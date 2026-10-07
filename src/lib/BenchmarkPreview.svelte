<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
  import type { ModelInfo } from "./sdk";
  import {
    listBenchmarkSuites,
    putBenchmarkSuiteIfNoRuns,
    deleteBenchmarkSuiteWithHistory,
    listBenchmarkRunHeadersForSuite,
    countBenchmarkRunsBySuite,
    getBenchmarkRun,
    getBenchmarkRunWithAttempts,
    listAttemptSummariesForRun,
  } from "./benchmark-repository";
  import {
    BENCHMARK_DEFAULT_MAX_TOKENS,
    BENCHMARK_MAX_REPEAT_COUNT,
    BENCHMARK_MAX_TARGETS,
    BENCHMARK_MAX_ATTEMPTS,
    BENCHMARK_MAX_CASES,
    BENCHMARK_MAX_TEMPERATURE,
    BENCHMARK_MAX_WARMUP_COUNT,
    BENCHMARK_MIN_REPEAT_COUNT,
    BENCHMARK_MIN_TEMPERATURE,
    BENCHMARK_MIN_WARMUP_COUNT,
    BENCHMARK_TEMPERATURE_STEP,
    BENCHMARK_MAX_JSONL_CHARS,
    isBenchmarkSuite,
    parseBenchmarkCasesJsonl,
    type BenchmarkSuite,
    type BenchmarkTarget,
  } from "./benchmark-suite";
  import { aliasChoicesForTarget, applyTargetAlias, cachedVariantIds, caseRowsFromJsonl, casesJsonlError, draftEditsSuite, draftFromSuite, draftInputBlocksSave, draftInputErrors, duplicateSuiteDraft, jsonlFromCaseRows, jsonlImportCanFitCharacterLimit, newPromptCaseRow, buildSuiteFromDraft, estimateDraftAttempts, tagsJsonError, variantChoicesForTarget, type SuiteCaseRow, type SuiteDraft } from "./benchmark-draft";
  import { caseSummaryLine, suiteDefinitionView } from "./benchmark-suite-summary";
  import { presentBenchmarkResponse } from "./benchmark-response-format";
  import { formatResponseMs, type TargetResultView } from "./benchmark-results";
  import { buildProgressMatrix, isRunInterrupted, isRunResumable, nextRunPollAction, nextRunPollActionAfterReread, type AttemptSummary } from "./benchmark-progress";
  import {
    applyHistoricalSnapshot,
    applyHistoricalSnapshotError,
    applySummarySnapshot,
    applySummarySnapshotError,
    claimPreviewOwnership,
    createPreviewOwnership,
    type BenchmarkPreviewSnapshot,
  } from "./benchmark-preview-snapshot";
  import { buildBenchmarkExport } from "./benchmark-export";
  import Icon from "./Icon.svelte";
  import IconActionButton from "./IconActionButton.svelte";
  import PanelCollapseButton from "./PanelCollapseButton.svelte";
  import MessageRenderer from "./MessageRenderer.svelte";
  import type { BenchmarkRun, BenchmarkRunHeader } from "./benchmark-run";

  export let availableModels: ModelInfo[] = [];
  /** The run id the parent is actually executing right now, or null. Used only to reflect
   * status here — lifecycle state (start/stop/resume) itself lives in the parent so a run
   * survives navigating away from this view. */
  export let activeRunId: string | null = null;
  /** Attempt ids that already existed before this live session dispatched anything — an exact
   * identity check for "this session's in-flight work" (see `PreparedExecution.knownAttemptIds`
   * in benchmark-lifecycle.ts), immune to wall-clock repeats/rollbacks during model loading. */
  export let knownAttemptIds: ReadonlySet<string> | null = null;
  /** True from the moment start/resume is requested until pin restore finishes. */
  export let runInFlight: boolean = false;
  /** True while chat, dictation, transcription, or summarization elsewhere in the app is
   * dispatching inference against the same shared pool. Disables Start/Resume proactively so
   * the user isn't surprised by the rejection `onStart`/`onResume` return in that case — the
   * parent's admission check is the actual enforcement, this is just visible feedback. */
  export let otherInferenceActive: boolean = false;
  /** Set by the parent when a detached run/resume execution settles with a failure or a
   * `recovery_required` halt — neither is visible from `onStart`/`onResume`'s own resolved
   * value, since both return as soon as the run is confirmed under way, well before the run
   * itself finishes. Shown as a standing banner (not tied to whichever run is selected) because
   * it can arrive after the user has navigated away from the run that failed. */
  export let runError: string | null = null;
  export let onStart: (suite: BenchmarkSuite) => Promise<{ ok: true; runId: string } | { ok: false; error: string }>;
  export let onStop: () => void;
  export let onResume: (runId: string) => Promise<{ ok: true; runId: string } | { ok: false; error: string }>;

  let suites: BenchmarkSuite[] = [];
  let suitesCollapsed = false;
  let loadError = "";
  let selectedSuiteId: string | null = null;
  let runsForSelectedSuite: BenchmarkRunHeader[] = [];
  let runCountsBySuite: Record<string, number> = Object.create(null);

  let editingDraft: SuiteDraft | null = null;
  let editingCaseRows: SuiteCaseRow[] = [];
  /** True when the JSONL text does not parse into rows. The textarea is the only editor then. */
  let casesAdvanced = false;
  let casesImporting = false;
  let casesFileInput: HTMLInputElement | null = null;
  let editingErrors: string[] = [];
  let editingNotices: string[] = [];
  let editingBusy = false;
  /** Held across create/edit/save/delete so Delete cannot race a Save that recreates the suite. */
  let suiteBusy = false;
  let suiteDeletePending = false;
  let resultView: TargetResultView[] | null = null;
  let resultViewRunId: string | null = null;
  let resultError = "";
  let resultGeneration = 0;
  let resultLoadRunId: string | null = null;
  let resultLoadPromise: Promise<void> | null = null;
  let expandedResultId: string | null = null;
  /** Per-attempt raw view. Reassigned so Svelte notices the change. */
  let rawResultIds: Record<string, true> = {};

  let selectedRunId: string | null = null;
  let selectedRun: BenchmarkRun | null = null;
  let selectedRunAttempts: AttemptSummary[] = [];
  let lifecycleBusy = false;
  let lifecycleError = "";
  /** Separate from `lifecycleError`: a poll tick's storage-read failure must never clobber (or
   * be clobbered by) a user-initiated Start/Resume/Stop/Export error sharing the same variable —
   * they can be in flight at the same moment (e.g. a poll tick landing right after a failed
   * Resume sets its own message) and each must remain visible until its own next resolution. */
  let pollError = "";
  let pollHandle: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by every `stopPolling()` call, including the one `openRun` makes at its own start.
   * `schedulePoll` captures the generation current when *it* was called and re-checks it both
   * before and after awaiting `refreshSelectedRun()`; a mismatch means some newer chain has since
   * taken over (a fresh `openRun` for the same or a different run, or `refreshSelectedRun`'s own
   * internal stop) and this callback must not reschedule. Relying on `pollHandle === null` alone
   * is not enough: reopening the *same* active run while a poll tick is still awaiting can
   * install a new `pollHandle` before the old tick resumes, so the old tick would see a non-null
   * handle (the new chain's) and wrongly conclude it is still the active chain. */
  let pollGeneration = 0;
  let refreshGeneration = 0;
  let snapshotOwnership = createPreviewOwnership();
  /** Guards `refreshSuites()` the same way `refreshGeneration` guards a run refresh: a slower,
   * now-stale call (e.g. the initial `onMount` load racing a create/edit/delete) must not
   * overwrite the newer suite list/run counts once it finally resolves. */
  let suitesGeneration = 0;
  /** Same overlapping-read hole as suite-list refresh: two `refreshRunsForSelectedSuite(id)`
   * calls for the same suite (start completing, then an older poll) can land out of order. */
  let runsRefreshGeneration = 0;
  /** `openRun()` only checks `selectedRunId` after its await, which is not enough when the
   * *same* run is opened twice in quick succession (e.g. a double-click): `selectedRunId` never
   * changes between the two calls, so both would otherwise pass that check and each install its
   * own polling interval — only the last-assigned `pollHandle` stays reachable, leaking the
   * other to poll forever. This monotonic token makes only the most recently started `openRun`
   * call install its interval, regardless of which one's await resolves first. */
  let openRunToken = 0;
  /** Set once by `onDestroy`. The generation/token counters above only catch a call that was
   * already inside its own async body when the component unmounted — they do nothing about a
   * caller (`handleStart`/`handleResume`) that is still awaiting an *earlier*, outer promise
   * (`onStart`/`onResume`) at that moment and only reaches `openRun()` afterward, with a
   * freshly-captured token that would otherwise satisfy every staleness check. `openRun` checks
   * this flag directly before installing its interval so no post-teardown caller, however it got
   * there, can start one that `onDestroy`'s single `stopPolling()` call never sees. */
  let destroyed = false;
  /** Editor write in flight — Save/Cancel/New/Edit serialize on this, not on an unrelated run. */
  $: editorBusy = editingBusy || suiteBusy || casesImporting;
  /** Start/resume handshake or live run. Does not freeze Save/Cancel of an unrelated draft. */
  $: runBusy = lifecycleBusy || runInFlight;
  function suiteHasStoredRuns(suiteId: string): boolean {
    return (runCountsBySuite[suiteId] ?? 0) > 0;
  }

  /** Shown on the Edit control and in the definition. A disabled button does not
   * receive the hover in WebView2, so the title has to live on a wrapper. */
  const LOCKED_SUITE_EDIT_REASON =
    "Locked after a run, on purpose. Duplicate this suite to modify it or to run it again with changes.";

  async function refreshSuites() {
    const generation = ++suitesGeneration;
    const res = await listBenchmarkSuites();
    if (generation !== suitesGeneration) return;
    if (!res.ok) {
      loadError = res.error || "Could not load benchmark suites";
      return;
    }
    const nextSuites = (res.value ?? []).sort((a, b) => b.createdAt - a.createdAt);
    const countRes = await countBenchmarkRunsBySuite();
    if (generation !== suitesGeneration) return;
    if (!countRes.ok) {
      loadError = countRes.error || "Could not read run counts";
      return;
    }
    const raw = countRes.value ?? {};
    // Suite IDs are arbitrary validated strings, not property-safe keys: an id like
    // `__proto__` would collide with Object.prototype in a plain object literal, so a
    // null-prototype dictionary is used here too — mirroring `countBenchmarkRunsBySuite`,
    // whose own fix does not, by itself, protect this second dictionary.
    const counts: Record<string, number> = Object.create(null);
    for (const suite of nextSuites) {
      counts[suite.id] = raw[suite.id] ?? 0;
    }
    if (generation !== suitesGeneration) return;
    suites = nextSuites;
    loadError = "";
    runCountsBySuite = counts;
  }

  async function refreshRunsForSelectedSuite(id: string) {
    const generation = ++runsRefreshGeneration;
    const res = await listBenchmarkRunHeadersForSuite(id);
    if (destroyed || generation !== runsRefreshGeneration || selectedSuiteId !== id) return;
    if (!res.ok) {
      loadError = res.error || `Could not read runs for suite "${id}"`;
      return;
    }
    runsForSelectedSuite = (res.value ?? []).sort((a, b) => b.createdAt - a.createdAt);
    // A spread into a plain object literal (`{ ...runCountsBySuite, [id]: n }`) would produce a
    // normal-prototype object regardless of the source's own prototype, silently reintroducing
    // the `__proto__`/`constructor` collision this dictionary is meant to avoid. Copy onto a
    // fresh null-prototype object instead.
    const nextCounts: Record<string, number> = Object.create(null);
    Object.assign(nextCounts, runCountsBySuite);
    nextCounts[id] = runsForSelectedSuite.length;
    runCountsBySuite = nextCounts;
    loadError = "";
  }

  async function selectSuite(id: string) {
    if (lifecycleBusy) return;
    snapshotOwnership = claimPreviewOwnership(snapshotOwnership, null, "none");
    selectedSuiteId = id;
    selectedRunId = null;
    selectedRun = null;
    selectedRunAttempts = [];
    runsForSelectedSuite = [];
    lifecycleError = "";
    pollError = "";
    clearRunResults();
    stopPolling();
    await refreshRunsForSelectedSuite(id);
  }

  function clearRunResults() {
    resultGeneration += 1;
    resultView = null;
    resultViewRunId = null;
    resultError = "";
    resultLoadRunId = null;
    resultLoadPromise = null;
    expandedResultId = null;
  }

  function currentPreviewSnapshot(): BenchmarkPreviewSnapshot {
    return {
      run: selectedRun,
      attempts: selectedRunAttempts,
      results: resultView,
      resultsRunId: resultViewRunId,
      pollError,
      resultError,
    };
  }

  function publishPreviewSnapshot(snapshot: BenchmarkPreviewSnapshot) {
    selectedRun = snapshot.run;
    selectedRunAttempts = snapshot.attempts;
    resultView = snapshot.results;
    resultViewRunId = snapshot.resultsRunId;
    pollError = snapshot.pollError;
    resultError = snapshot.resultError;
  }

  /** Full attempt bodies, once, when the run is no longer the live one. The progress poll
   * stays on summaries so a 1.5s tick never clones response text. */
  async function loadRunResults(runId: string) {
    if (runId === activeRunId) return;
    snapshotOwnership = claimPreviewOwnership(snapshotOwnership, runId, "historical-full");
    const ownership = snapshotOwnership;
    if (resultViewRunId === runId && resultView) return;
    if (resultLoadRunId === runId && resultLoadPromise) {
      return resultLoadPromise;
    }
    const generation = ++resultGeneration;
    const load = (async () => {
      const res = await getBenchmarkRunWithAttempts(runId);
      if (destroyed || generation !== resultGeneration || selectedRunId !== runId || runId === activeRunId) return;
      if (!res.ok || !res.value) {
        const error = !res.ok
          ? (res.error || "Could not load results")
          : `Could not load results: run "${runId}" was not found`;
        publishPreviewSnapshot(applyHistoricalSnapshotError(
          currentPreviewSnapshot(),
          snapshotOwnership,
          ownership,
          error,
        ));
        return;
      }
      publishPreviewSnapshot(applyHistoricalSnapshot(
        currentPreviewSnapshot(),
        snapshotOwnership,
        ownership,
        res.value.run,
        res.value.attempts,
      ));
    })();
    resultLoadRunId = runId;
    resultLoadPromise = load;
    try {
      await load;
    } finally {
      if (resultLoadPromise === load) {
        resultLoadRunId = null;
        resultLoadPromise = null;
      }
    }
  }

  function newSuiteDraft(): SuiteDraft {
    return {
      name: "",
      targets: [],
      casesJsonl: "",
      maxTokens: BENCHMARK_DEFAULT_MAX_TOKENS,
      warmupCount: 1,
      repeatCount: 1,
    };
  }

  // These three all replace or clear `editingDraft` — while `saveSuite` is awaiting IndexedDB
  // (`editingBusy`), letting any of them run would either discard the draft that save is about
  // to report success/failure against, or let the save's completion silently clobber a draft the
  // user opened in the meantime. The template also disables their buttons while `editingBusy`;
  // these are a defense-in-depth guard against any other call path.
  function discardDraft() {
    editingDraft = null;
    editingCaseRows = [];
    casesAdvanced = false;
    editingErrors = [];
    editingNotices = [];
  }

  function openDraft(draft: SuiteDraft, notices: string[] = []) {
    editingDraft = draft;
    editingErrors = [];
    editingNotices = notices;
    const parsed = caseRowsFromJsonl(draft.casesJsonl);
    if (parsed.ok) {
      editingCaseRows = parsed.rows;
      casesAdvanced = false;
    } else {
      // Leave the text in the advanced editor. A partial row list would drop the lines that failed.
      editingCaseRows = [];
      casesAdvanced = true;
      editingErrors = [parsed.error];
    }
  }

  function syncJsonlFromRows() {
    if (!editingDraft || casesAdvanced) return;
    editingDraft.casesJsonl = jsonlFromCaseRows(editingCaseRows);
  }

  function setPromptField(row: Extract<SuiteCaseRow, { kind: "prompt" }>, field: "id" | "prompt" | "expected" | "tagsJson", value: string) {
    if (editorBusy) return;
    row[field] = value;
    syncJsonlFromRows();
  }

  function commitCaseRows(rows: SuiteCaseRow[]) {
    if (!editingDraft || editorBusy) return;
    editingCaseRows = rows;
    casesAdvanced = false;
    editingDraft.casesJsonl = jsonlFromCaseRows(rows);
  }

  function setCasesAdvanced(advanced: boolean) {
    if (!editingDraft || editorBusy) return;
    if (advanced) {
      casesAdvanced = true;
      editingErrors = [];
      return;
    }
    const parsed = caseRowsFromJsonl(editingDraft.casesJsonl);
    if (!parsed.ok) {
      casesAdvanced = true;
      editingErrors = [parsed.error];
      return;
    }
    editingCaseRows = parsed.rows;
    casesAdvanced = false;
    editingErrors = [];
  }

  function addCaseRow() {
    if (!editingDraft || editorBusy || editingCaseRows.length >= BENCHMARK_MAX_CASES) return;
    commitCaseRows([...editingCaseRows, newPromptCaseRow(editingCaseRows.map((row) => row.id))]);
  }

  function removeCaseRow(index: number) {
    commitCaseRows(editingCaseRows.filter((_, i) => i !== index));
  }

  function moveCaseRow(index: number, delta: number) {
    const next = index + delta;
    if (next < 0 || next >= editingCaseRows.length) return;
    const rows = [...editingCaseRows];
    const [row] = rows.splice(index, 1);
    rows.splice(next, 0, row);
    commitCaseRows(rows);
  }

  function setDraftNumber(field: "temperature" | "maxTokens", raw: string) {
    if (!editingDraft || editorBusy) return;
    editingDraft = { ...editingDraft, [field]: raw };
  }

  function temperatureIsBlank(value: number | string | null | undefined): boolean {
    return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
  }

  function clearTemperature() {
    if (!editingDraft || editorBusy) return;
    editingDraft = { ...editingDraft, temperature: "" };
  }

  async function importCasesFile(event: Event) {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement) || !editingDraft || editingBusy || suiteBusy || casesImporting) return;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const draftAtImport = editingDraft;
    casesImporting = true;
    try {
      // The parser enforces the exact character limit after decoding. This byte bound only rejects
      // files that cannot possibly fit, while allowing valid multi-byte UTF-8 JSONL through.
      if (!jsonlImportCanFitCharacterLimit(file.size)) {
        editingErrors = [`file cannot fit within ${BENCHMARK_MAX_JSONL_CHARS} characters`];
        return;
      }
      const text = await file.text();
      if (destroyed || editingDraft !== draftAtImport) return;
      if (text.length > BENCHMARK_MAX_JSONL_CHARS) {
        editingErrors = [`file is larger than ${BENCHMARK_MAX_JSONL_CHARS} characters`];
        return;
      }
      editingDraft.casesJsonl = text;
      const parsed = caseRowsFromJsonl(text);
      if (!parsed.ok) {
        editingCaseRows = [];
        casesAdvanced = true;
        editingErrors = [parsed.error];
        return;
      }
      editingCaseRows = parsed.rows;
      casesAdvanced = false;
      editingErrors = [];
    } catch {
      if (!destroyed && editingDraft === draftAtImport) {
        editingErrors = ["Could not read JSONL file"];
      }
    } finally {
      casesImporting = false;
    }
  }

  function startCreateSuite() {
    if (editorBusy || lifecycleBusy || editingDraft) return;
    openDraft(newSuiteDraft());
  }

  function startDuplicateSuite(suite: BenchmarkSuite) {
    if (editorBusy || lifecycleBusy || editingDraft) return;
    const draft = duplicateSuiteDraft(suite);
    const removedTargets = suite.targets.length - draft.targets.length;
    const notices = removedTargets > 0
      ? [`Removed ${removedTargets} ${removedTargets === 1 ? "target" : "targets"} that repeated a model alias. Benchmark targets are keyed by alias.`]
      : [];
    openDraft(draft, notices);
  }

  function startEditSuite(suite: BenchmarkSuite) {
    if (editorBusy || lifecycleBusy || editingDraft) return;
    // Editing is restricted to suites with no runs yet — a suite with runs already has attempts
    // recorded against its frozen snapshot, and silently changing the live suite underneath
    // that history would be misleading even though runs themselves are immutable.
    if ((runCountsBySuite[suite.id] ?? 0) > 0) {
      loadError = LOCKED_SUITE_EDIT_REASON;
      return;
    }
    openDraft(draftFromSuite(suite));
  }

  function cancelEditSuite() {
    if (editorBusy) return;
    discardDraft();
  }

  function addTarget() {
    if (!editingDraft || editingDraft.targets.length >= BENCHMARK_MAX_TARGETS) return;
    const first = availableModels[0];
    editingDraft.targets = [...editingDraft.targets, { alias: first?.alias ?? "", variantId: null }];
  }

  function removeTarget(index: number) {
    if (!editingDraft) return;
    editingDraft.targets = editingDraft.targets.filter((_, i) => i !== index);
  }

  function variantsForAlias(alias: string) {
    return cachedVariantIds(availableModels.find((m) => m.alias === alias)?.variants);
  }

  function updateTargetAlias(index: number, alias: string) {
    if (!editingDraft) return;
    const targets: BenchmarkTarget[] = [...editingDraft.targets];
    targets[index] = applyTargetAlias(targets[index], alias, variantsForAlias(alias));
    editingDraft.targets = targets;
  }

  function updateTargetVariant(index: number, variantId: string | null) {
    if (!editingDraft) return;
    const targets: BenchmarkTarget[] = [...editingDraft.targets];
    targets[index] = { ...targets[index], variantId };
    editingDraft.targets = targets;
  }

  let jsonlFieldError: string | null = null;
  let jsonlListError: string | null = null;

  /** Parser message Save would copy into the list. Blank JSONL is one of those messages. */
  function casesJsonlListError(text: string): string | null {
    const parsed = parseBenchmarkCasesJsonl(text);
    return parsed.ok ? null : (parsed.error ?? "cases are invalid");
  }

  // Drop only the previous parser message once this JSONL's message changes.
  // A save error that still matches the current text, and an import error that is
  // not that parser message, stay in the list. Leaving JSONL mode does not count
  // as the text changing.
  $: {
    const text = editingDraft?.casesJsonl ?? "";
    jsonlFieldError = casesAdvanced && editingDraft ? casesJsonlError(text) : null;
    const nextList = editingDraft ? casesJsonlListError(text) : null;
    if (jsonlListError && jsonlListError !== nextList) {
      const stale = jsonlListError;
      const nextErrors = editingErrors.filter((message) => message !== stale);
      if (nextErrors.length !== editingErrors.length) editingErrors = nextErrors;
    }
    jsonlListError = nextList;
  }

  $: inputErrors = editingDraft ? draftInputErrors(editingDraft) : null;
  $: draftHasInputError = inputErrors ? draftInputBlocksSave(inputErrors) : false;

  $: draftAttemptEstimate = editingDraft ? estimateDraftAttempts(editingDraft) : null;
  $: attemptEstimateOverCap = draftAttemptEstimate !== null && draftAttemptEstimate > BENCHMARK_MAX_ATTEMPTS;

  async function saveSuite() {
    if (!editingDraft || editorBusy) return;
    editingBusy = true;
    suiteBusy = true;
    editingErrors = [];
    try {
      const result = buildSuiteFromDraft(editingDraft);
      if (!result.ok || !result.value) {
        editingErrors = result.errors;
        return;
      }
      const saved = await putBenchmarkSuiteIfNoRuns(result.value);
      if (destroyed) return;
      if (!saved.ok) {
        editingErrors = [saved.error || "Could not save suite"];
        return;
      }
      discardDraft();
      await refreshSuites();
    } finally {
      editingBusy = false;
      suiteBusy = false;
    }
  }

  function suiteDeleteMessage(name: string, runs: number): string {
    const label = (name ?? "").trim() || "this suite";
    if (runs > 0) {
      const noun = runs === 1 ? "run" : "runs";
      return `Delete "${label}" and its ${runs} saved ${noun}? The runs and their responses are removed with the suite. This cannot be undone.`;
    }
    return `Delete "${label}"? This cannot be undone.`;
  }

  async function removeSuite(suite: BenchmarkSuite) {
    if (suiteDeletePending || editorBusy || lifecycleBusy || runInFlight) return;
    if (draftEditsSuite(editingDraft, suite.id)) return;
    // The dialog plugin replaces window.confirm with invoke("plugin:dialog|confirm").
    // That command is not granted. confirmDialog uses plugin:dialog|message, which is.
    let confirmed = false;
    try {
      confirmed = await confirmDialog(suiteDeleteMessage(suite.name, runCountsBySuite[suite.id] ?? 0), {
        title: "Delete suite",
        kind: "warning",
      });
    } catch (error) {
      loadError = error instanceof Error && error.message ? error.message : "Could not ask to confirm deletion";
      return;
    }
    if (!confirmed) return;
    if (destroyed || editorBusy || lifecycleBusy || runInFlight) return;
    if (draftEditsSuite(editingDraft, suite.id)) return;
    suiteDeletePending = true;
    suiteBusy = true;
    try {
      const res = await deleteBenchmarkSuiteWithHistory(suite.id, activeRunId);
      if (destroyed) return;
      if (!res.ok) {
        loadError = res.error || "Could not delete suite";
        return;
      }
      // Defense: a stale editor for this id would recreate the suite on Save.
      if (draftEditsSuite(editingDraft, suite.id)) discardDraft();
      if (selectedSuiteId === suite.id) {
        selectedSuiteId = null;
        selectedRunId = null;
        selectedRun = null;
        selectedRunAttempts = [];
        runsForSelectedSuite = [];
        clearRunResults();
        stopPolling();
      }
      await refreshSuites();
    } catch (error) {
      if (!destroyed) {
        loadError = error instanceof Error && error.message ? error.message : "Could not delete suite";
      }
    } finally {
      suiteDeletePending = false;
      suiteBusy = false;
    }
  }

  function stopPolling() {
    // Bumped unconditionally, even when nothing is currently scheduled: this is what lets a
    // still-awaiting poll callback (see `schedulePoll`) detect that a newer chain has since
    // taken over, so it must not reschedule itself even though `pollHandle` may already hold
    // that newer chain's (non-null) timer by the time the old callback resumes.
    pollGeneration += 1;
    if (pollHandle !== null) {
      clearTimeout(pollHandle);
      pollHandle = null;
    }
  }

  /** Schedules the next poll only after the previous one's IndexedDB reads finish, instead of a
   * fixed-cadence `setInterval` — a slow refresh (device under load, a large attempt list) could
   * otherwise start a new tick before the last one settled. Each new tick bumps
   * `refreshGeneration` and discards the older tick's result, so overlapping ticks would starve
   * every refresh and the progress view would neither update nor ever detect the run finishing.
   * Captures `pollGeneration` at schedule time and re-checks it against the live value both
   * before and after awaiting `refreshSelectedRun()`: a mismatch means some `stopPolling()` call
   * happened since (a fresh `openRun` — including for this same run — or `refreshSelectedRun`'s
   * own internal stop once the run is no longer active) and this chain must not continue.
   * `pollHandle === null` alone is not a reliable "should stop" signal here: reopening the same
   * run while a tick is still awaiting installs a *new* `pollHandle` before the old tick resumes,
   * so the old tick would otherwise see a non-null handle belonging to that newer chain. */
  function schedulePoll(runId: string) {
    const generation = pollGeneration;
    pollHandle = setTimeout(async () => {
      if (destroyed || selectedRunId !== runId || generation !== pollGeneration) return;
      await refreshSelectedRun();
      if (destroyed || selectedRunId !== runId || generation !== pollGeneration) return;
      schedulePoll(runId);
    }, 1500);
  }

  /** Run row and attempt summaries are one snapshot. Partial success must not update either
   * field or clear pollError — that would stop as completed with a stale matrix and no banner. */
  function applyPollPair(
    ownership: typeof snapshotOwnership,
    runRes: { ok: boolean; value?: BenchmarkRun | null; error?: string },
    summariesRes: { ok: boolean; value?: AttemptSummary[] | null; error?: string },
  ): { confirmed: boolean; status: BenchmarkRun["status"] | undefined } {
    if (runRes.ok && summariesRes.ok && runRes.value) {
      publishPreviewSnapshot(applySummarySnapshot(
        currentPreviewSnapshot(),
        snapshotOwnership,
        ownership,
        runRes.value,
        summariesRes.value ?? [],
      ));
      return { confirmed: true, status: runRes.value.status };
    }
    const error = !runRes.ok
      ? `Could not refresh run status: ${runRes.error}`
      : !summariesRes.ok
        ? `Could not refresh run attempts: ${summariesRes.error}`
        : `Could not refresh run status: run "${ownership.runId}" was not found`;
    publishPreviewSnapshot(applySummarySnapshotError(
      currentPreviewSnapshot(),
      snapshotOwnership,
      ownership,
      error,
    ));
    return { confirmed: false, status: undefined };
  }

  async function refreshSelectedRun() {
    const runId = selectedRunId;
    if (!runId) return;
    const generation = ++refreshGeneration;
    const ownership = snapshotOwnership;
    const ownedAtStart = runId === activeRunId;
    const runRes = await getBenchmarkRun(runId);
    if (generation !== refreshGeneration || selectedRunId !== runId) return;
    const summariesRes = await listAttemptSummariesForRun(runId);
    if (generation !== refreshGeneration || selectedRunId !== runId) return;
    // Apply run + summaries as one snapshot. A completed row with a failed summaries read
    // must not paint as done with the previous attempt list (last result missing, no error).
    const first = applyPollPair(ownership, runRes, summariesRes);
    const ownedNow = runId === activeRunId;
    const poll = nextRunPollAction({
      confirmed: first.confirmed,
      ownedNow,
      ownedAtStart,
      status: first.status,
    });
    if (poll === 'keep') return;
    if (poll === 'reread') {
      const finalRun = await getBenchmarkRun(runId);
      if (generation !== refreshGeneration || selectedRunId !== runId) return;
      const finalSummaries = await listAttemptSummariesForRun(runId);
      if (generation !== refreshGeneration || selectedRunId !== runId) return;
      const reread = applyPollPair(ownership, finalRun, finalSummaries);
      const after = nextRunPollActionAfterReread({
        confirmed: reread.confirmed,
        ownedNow: runId === activeRunId,
        ownedAtStart,
        status: reread.status,
      });
      if (after === 'keep') return;
    }
    if (runId !== activeRunId) {
      stopPolling();
      if (selectedRun && selectedRun.id === runId) void loadRunResults(runId);
      if (selectedSuiteId) await refreshRunsForSelectedSuite(selectedSuiteId);
    }
  }

  async function openRun(runId: string) {
    const liveAtOpen = runId === activeRunId;
    snapshotOwnership = claimPreviewOwnership(
      snapshotOwnership,
      runId,
      liveAtOpen ? "live-summary" : "historical-full",
    );
    const preserveHistoricalResults = selectedRunId === runId && runId !== activeRunId;
    selectedRunId = runId;
    if (!preserveHistoricalResults) {
      selectedRun = null;
      selectedRunAttempts = [];
      clearRunResults();
    }
    lifecycleError = "";
    pollError = "";
    stopPolling();
    const token = ++openRunToken;
    // A historical run does not start the summary poll. A failed summary read
    // returns "keep" and never reaches the full-attempt load, so that load has
    // to start here. A live run still waits for the poll to stop.
    if (!liveAtOpen) void loadRunResults(runId);
    await refreshSelectedRun();
    if (token !== openRunToken || selectedRunId !== runId || destroyed) return;
    // Historical opens already own the full read started above. Only a run that was live when
    // opened needs a post-refresh decision: keep polling if it is still live, otherwise load its
    // now-terminal result once.
    if (!liveAtOpen) return;
    if (runId === activeRunId) {
      schedulePoll(runId);
    } else {
      void loadRunResults(runId);
    }
  }

  $: progressMatrix = selectedRun
    ? buildProgressMatrix(selectedRun.suite, selectedRunAttempts, {
        live: selectedRun.id === activeRunId,
        knownAttemptIds: selectedRun.id === activeRunId ? knownAttemptIds : null,
      })
    : [];
  $: selectedRunIsActive = !!selectedRun && selectedRun.id === activeRunId;
  /** The selected suite owns the live run, even if an older row in its list is open. */
  $: suiteOwnsActiveRun = !!activeRunId && (
    selectedRunIsActive || runsForSelectedSuite.some((run) => run.id === activeRunId)
  );

  /** `openRun` only starts `pollHandle` for whichever run is *selected* at the time. Selecting a
   * different (e.g. historical) run while a run stays active elsewhere stops that poll, so if
   * the active run then finishes with no run selected here, nothing would ever refresh
   * `runsForSelectedSuite` and its row would sit relabeled "interrupted" forever even though it
   * completed normally. Tracking the previous `activeRunId` lets us catch exactly that release
   * and refresh the currently-viewed suite's run list regardless of what's selected. */
  let lastActiveRunId: string | null = null;
  $: {
    if (lastActiveRunId && !activeRunId && selectedSuiteId) {
      void refreshRunsForSelectedSuite(selectedSuiteId);
    }
    lastActiveRunId = activeRunId;
  }

  async function handleStart(suite: BenchmarkSuite) {
    if (runBusy || suiteDeletePending) return;
    if (draftEditsSuite(editingDraft, suite.id)) {
      lifecycleError = "Save or cancel your edits before starting a run.";
      return;
    }
    const suiteId = suite.id;
    lifecycleBusy = true;
    lifecycleError = "";
    try {
      const outcome = await onStart(suite);
      if (destroyed) return;
      if (selectedSuiteId !== suiteId) return;
      // Preparation inserts the run row before pin/load; a failed Start can still have left a
      // stopped row, so Edit/Delete must refresh even on failure or they stay enabled at 0.
      await refreshRunsForSelectedSuite(suiteId);
      if (destroyed || selectedSuiteId !== suiteId) return;
      if (!outcome.ok) {
        lifecycleError = outcome.error;
        return;
      }
      if (draftEditsSuite(editingDraft, suiteId)) discardDraft();
      await openRun(outcome.runId);
    } finally {
      lifecycleBusy = false;
    }
  }

  function handleStop() {
    onStop();
  }

  function startRunTitle(suite: BenchmarkSuite): string {
    if (lifecycleBusy) return "Starting the run";
    if (otherInferenceActive) {
      return "Finish or stop chat, dictation, transcription, summarization, or endpoint self-test before starting a benchmark.";
    }
    if (activeRunId) return "A benchmark run is already going. Stop it before starting another.";
    if (draftEditsSuite(editingDraft, suite.id)) return "Save or cancel your edits before starting a run.";
    if (!isBenchmarkSuite(suite)) {
      return "This suite lists the same model alias twice, so a new run would not measure both.";
    }
    return "Start run";
  }

  function toggleRawResult(attemptId: string) {
    if (rawResultIds[attemptId]) {
      const next = { ...rawResultIds };
      delete next[attemptId];
      rawResultIds = next;
      return;
    }
    rawResultIds = { ...rawResultIds, [attemptId]: true };
  }

  async function copyBenchmarkResponse(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      lifecycleError = "Could not copy the response.";
    }
  }

  async function handleResume(runId: string) {
    if (runBusy) return;
    const suiteId = selectedSuiteId;
    lifecycleBusy = true;
    lifecycleError = "";
    try {
      const outcome = await onResume(runId);
      if (destroyed) return;
      if (selectedSuiteId !== suiteId) return;
      if (!outcome.ok) {
        lifecycleError = outcome.error;
        return;
      }
      await openRun(outcome.runId);
    } finally {
      lifecycleBusy = false;
    }
  }

  async function exportRun(runId: string) {
    // Read the run and its full attempt history in one transaction: two separate reads could
    // observe the run row and its attempts at different moments (e.g. a `running` run snapshot
    // paired with an attempt set from after it actually finished), producing an export that is
    // internally inconsistent with what `benchmark-export.ts` documents.
    const res = await getBenchmarkRunWithAttempts(runId);
    if (destroyed) return;
    if (!res.ok || !res.value) {
      // A slow export racing the user navigating to a different run/suite must not attribute
      // its failure to whatever is now selected — only surface the error while this export's
      // run is still the one on screen; a successful export still downloads regardless.
      if (selectedRunId === runId) {
        lifecycleError = !res.ok
          ? (res.error || "Could not build export")
          : `Could not build export: run "${runId}" was not found`;
      }
      return;
    }
    const payload = buildBenchmarkExport(res.value.run, res.value.attempts);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `benchmark-${runId}.json`;
    a.click();
    // Deferred, not immediate: revoking right after click() can race the WebView actually
    // starting the download and invalidate the URL before it reads the blob (see the identical
    // fix and its 10s deferral in +page.svelte's access-log export).
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  onMount(() => {
    refreshSuites();
  });

  onDestroy(() => {
    destroyed = true;
    snapshotOwnership = claimPreviewOwnership(snapshotOwnership, null, "none");
    stopPolling();
    // Also invalidate any in-flight openRun()/refreshSelectedRun()/refreshSuites() calls: none
    // of them checks for component teardown, only staleness relative to a later call of the
    // same kind. Without this, an `openRun()` awaiting `refreshSelectedRun()` at the moment of
    // unmount could still resolve afterward with a matching token and install a `setInterval`
    // that nothing left running would ever clear.
    openRunToken++;
    refreshGeneration++;
    suitesGeneration++;
    runsRefreshGeneration++;
  });
</script>

<div class="benchmark-preview">
  <div class="benchmark-header">
    <div>
      <h2>Benchmark</h2>
      <p class="muted">
        Measured, repeatable multi-model runs — distinct from Model Arena's one-shot compare.
        Early preview.
      </p>
    </div>
  </div>

  {#if loadError}
    <div class="warning-banner">{loadError}</div>
  {/if}

  {#if runError}
    <div class="warning-banner">{runError}</div>
  {/if}

  {#if activeRunId && !suiteOwnsActiveRun}
    <!-- The banner is the stop control when the live run belongs to a suite that is not
         selected. While the selected suite owns the live run, Stop is the header button
         even if an older row is open. -->
    <div class="benchmark-active-run-banner">
      <span>A benchmark run is active in the background.</span>
      <button type="button" class="secondary small" onclick={handleStop}>Stop</button>
    </div>
  {/if}

  {#if editingDraft}
    <div class="benchmark-editor">
      <h3>{editingDraft.id ? "Edit suite" : "New suite"}</h3>
      <p class="muted small">Save or cancel this draft before creating, editing, or duplicating another suite.</p>
      {#if editingErrors.length}
        <ul class="benchmark-errors">
          {#each editingErrors as err}<li>{err}</li>{/each}
        </ul>
      {/if}
      {#each editingNotices as notice}
        <div class="warning-banner">{notice}</div>
      {/each}
      <!-- A save in flight must not let any control here keep mutating `editingDraft` --
           a successful save clears the draft, and any edit made during that window would be
           silently discarded rather than saved or visibly rejected. A native `fieldset` disables
           every input/select/button inside it in one place, so a future control added here is
           covered automatically instead of needing its own `disabled={editorBusy}` wiring. -->
      <fieldset class="benchmark-editor-fieldset" disabled={editorBusy}>
      <label>
        Name
        <input type="text" bind:value={editingDraft.name} aria-invalid={inputErrors?.name ? "true" : "false"} />
        {#if inputErrors?.name}<span class="field-error">{inputErrors.name}</span>{/if}
      </label>
      <label>
        Description
        <textarea bind:value={editingDraft.description} rows="2" aria-invalid={inputErrors?.description ? "true" : "false"}></textarea>
        {#if inputErrors?.description}<span class="field-error">{inputErrors.description}</span>{/if}
      </label>

      <div class="benchmark-targets">
        <div class="benchmark-editor-head">
          <strong>Targets ({editingDraft.targets.length}/{BENCHMARK_MAX_TARGETS})</strong>
          <button
            type="button"
            class="editor-add"
            onclick={addTarget}
            disabled={availableModels.length === 0 || editingDraft.targets.length >= BENCHMARK_MAX_TARGETS}
          >
            + Add target
          </button>
        </div>
        {#each editingDraft.targets as target, i}
          <div class="benchmark-target-row">
            <select
              value={target.alias}
              aria-label={`Target ${i + 1} model`}
              onchange={(e) => updateTargetAlias(i, e.currentTarget.value)}
            >
              {#each aliasChoicesForTarget(availableModels.map((m) => m.alias), target.alias) as choice (choice.alias)}
                <option value={choice.alias}>{choice.alias}{choice.available ? "" : " (not available)"}</option>
              {/each}
            </select>
            <select
              value={target.variantId ?? ""}
              aria-label={`Target ${i + 1} variant`}
              onchange={(e) => updateTargetVariant(i, e.currentTarget.value || null)}
            >
              <option value="">Runtime-selected variant</option>
              {#each variantChoicesForTarget(variantsForAlias(target.alias), target.variantId) as choice (choice.id)}
                <option value={choice.id}>{choice.id}{choice.available ? "" : " (not downloaded)"}</option>
              {/each}
            </select>
            <button
              type="button"
              class="tiny danger-btn"
              aria-label={`Remove target ${i + 1}${target.alias ? ` (${target.alias})` : ""}`}
              onclick={() => removeTarget(i)}
            >
              Remove
            </button>
          </div>
        {/each}
        {#if editingDraft.targets.some((t) =>
          aliasChoicesForTarget(availableModels.map((m) => m.alias), t.alias).some((c) => !c.available)
          || variantChoicesForTarget(variantsForAlias(t.alias), t.variantId).some((c) => !c.available)
        )}
          <p class="muted small">
            A stored model or variant is not available locally. Saving keeps it; Start will try
            to load that build. Pick a downloaded model to measure something already on disk.
          </p>
        {/if}
        {#if inputErrors?.targets}<p class="field-error">{inputErrors.targets}</p>{/if}
      </div>

      <div class="benchmark-cases">
        <div class="benchmark-editor-head">
          <strong>Cases ({casesAdvanced ? "JSONL" : editingCaseRows.length}/{BENCHMARK_MAX_CASES})</strong>
          <div class="benchmark-editor-head-actions">
            <button type="button" class="editor-add" onclick={() => casesFileInput?.click()}>Import JSONL</button>
            <button
              type="button"
              class="editor-add"
              disabled={casesAdvanced || editingCaseRows.length >= BENCHMARK_MAX_CASES}
              title={casesAdvanced ? "Switch off JSONL editing to add a case in the form." : undefined}
              onclick={addCaseRow}
            >+ Add case</button>
          </div>
          <input
            bind:this={casesFileInput}
            class="benchmark-file-input"
            type="file"
            accept=".jsonl,.txt,application/jsonl,text/plain"
            onchange={importCasesFile}
          />
        </div>
        <label class="benchmark-check">
          <input
            type="checkbox"
            checked={casesAdvanced}
            onchange={(e) => setCasesAdvanced(e.currentTarget.checked)}
          />
          Edit cases as JSONL
        </label>
        {#if casesAdvanced}
          <p id="benchmark-jsonl-help" class="muted small benchmark-jsonl-help">
            One case per line, for example {`{"id":"c1","prompt":"..."}`}. A messages array is kept when you return to the form, but that case stays read-only there.
          </p>
          <textarea
            class="benchmark-jsonl"
            class:invalid={!!jsonlFieldError}
            bind:value={editingDraft.casesJsonl}
            rows="8"
            spellcheck="false"
            aria-label="Cases as JSONL"
            aria-invalid={jsonlFieldError ? "true" : "false"}
            aria-describedby={jsonlFieldError ? "benchmark-jsonl-help benchmark-jsonl-error" : "benchmark-jsonl-help"}
          ></textarea>
          {#if jsonlFieldError}
            <span id="benchmark-jsonl-error" class="field-error">{jsonlFieldError}</span>
          {/if}
        {:else}
          {#each editingCaseRows as row, i (i)}
            {@const rowError = inputErrors?.rows[i]}
            <div class="benchmark-case-edit">
              {#if row.kind === "messages"}
                <p class="small">
                  <strong>{row.id}</strong>
                  <span class="muted"> — {row.messageCount === 1 ? "1 message" : `${row.messageCount} messages`}. Edit this case in JSONL.</span>
                </p>
                {#if rowError?.other}<p class="field-error">{rowError.other}</p>{/if}
              {:else}
                {@const tagsError = tagsJsonError(row.tagsJson)}
                <label>
                  Id
                  <input
                    type="text"
                    bind:value={row.id}
                    aria-invalid={rowError?.id ? "true" : "false"}
                    oninput={(e) => setPromptField(row, "id", e.currentTarget.value)}
                  />
                  {#if rowError?.id}<span class="field-error">{rowError.id}</span>{/if}
                </label>
                <label>
                  Prompt
                  <textarea
                    rows="2"
                    bind:value={row.prompt}
                    aria-invalid={rowError?.prompt ? "true" : "false"}
                    oninput={(e) => setPromptField(row, "prompt", e.currentTarget.value)}
                  ></textarea>
                  {#if rowError?.prompt}<span class="field-error">{rowError.prompt}</span>{/if}
                </label>
                <label>
                  Expected (stored, not scored)
                  <textarea rows="2" bind:value={row.expected} aria-invalid={rowError?.expected ? "true" : "false"} oninput={(e) => setPromptField(row, "expected", e.currentTarget.value)}></textarea>
                  {#if rowError?.expected}<span class="field-error">{rowError.expected}</span>{/if}
                </label>
                <label>
                  Tags (JSON array)
                  <input
                    type="text"
                    placeholder='["math","easy"]'
                    bind:value={row.tagsJson}
                    oninput={(e) => setPromptField(row, "tagsJson", e.currentTarget.value)}
                  />
                  {#if tagsError}
                    <span class="field-error">{tagsError}</span>
                  {/if}
                </label>
              {/if}
              <div class="benchmark-case-edit-actions">
                <button type="button" class="tiny" disabled={i === 0} onclick={() => moveCaseRow(i, -1)}>Up</button>
                <button type="button" class="tiny" disabled={i === editingCaseRows.length - 1} onclick={() => moveCaseRow(i, 1)}>Down</button>
                <button type="button" class="tiny danger-btn" aria-label={`Remove case ${row.id || i + 1}`} onclick={() => removeCaseRow(i)}>Remove</button>
              </div>
            </div>
          {/each}
        {/if}
      </div>

      <div class="benchmark-form-row">
        <label>
          Warmups ({BENCHMARK_MIN_WARMUP_COUNT}–{BENCHMARK_MAX_WARMUP_COUNT})
          <input type="number" min={BENCHMARK_MIN_WARMUP_COUNT} max={BENCHMARK_MAX_WARMUP_COUNT} bind:value={editingDraft.warmupCount} />
        </label>
        <label>
          Repeats ({BENCHMARK_MIN_REPEAT_COUNT}–{BENCHMARK_MAX_REPEAT_COUNT})
          <input type="number" min={BENCHMARK_MIN_REPEAT_COUNT} max={BENCHMARK_MAX_REPEAT_COUNT} bind:value={editingDraft.repeatCount} />
        </label>
        <div class="benchmark-temperature">
          <div class="benchmark-temperature-head">
            <label for="benchmark-temperature">Temperature</label>
            <span class="benchmark-range-value">
              {temperatureIsBlank(editingDraft.temperature) ? "runtime default" : editingDraft.temperature}
            </span>
          </div>
          <div class="benchmark-range">
            <span class="benchmark-range-end">{BENCHMARK_MIN_TEMPERATURE}</span>
            <input
              id="benchmark-temperature"
              type="range"
              min={BENCHMARK_MIN_TEMPERATURE}
              max={BENCHMARK_MAX_TEMPERATURE}
              step={BENCHMARK_TEMPERATURE_STEP}
              value={temperatureIsBlank(editingDraft.temperature) ? BENCHMARK_MIN_TEMPERATURE : editingDraft.temperature}
              aria-valuemin={BENCHMARK_MIN_TEMPERATURE}
              aria-valuemax={BENCHMARK_MAX_TEMPERATURE}
              aria-valuetext={temperatureIsBlank(editingDraft.temperature) ? "runtime default" : String(editingDraft.temperature)}
              aria-invalid={inputErrors?.temperature ? "true" : "false"}
              oninput={(e) => setDraftNumber("temperature", e.currentTarget.value)}
            />
            <span class="benchmark-range-end">{BENCHMARK_MAX_TEMPERATURE}</span>
          </div>
          {#if !temperatureIsBlank(editingDraft.temperature)}
            <button type="button" class="tiny" onclick={clearTemperature}>Use runtime default</button>
          {/if}
          {#if inputErrors?.temperature}<span class="field-error">{inputErrors.temperature}</span>{/if}
        </div>
        <label>
          Max tokens
          <input
            type="text"
            inputmode="numeric"
            value={editingDraft.maxTokens ?? ""}
            aria-invalid={inputErrors?.maxTokens ? "true" : "false"}
            oninput={(e) => setDraftNumber("maxTokens", e.currentTarget.value)}
          />
          {#if inputErrors?.maxTokens}<span class="field-error">{inputErrors.maxTokens}</span>{/if}
        </label>
      </div>
      <p class="muted small">A new suite starts at {BENCHMARK_DEFAULT_MAX_TOKENS} max tokens. Blank temperature or max tokens uses the runtime default. Expected answers are stored and not scored.</p>

      {#if draftAttemptEstimate !== null}
        <p class="small" class:muted={!attemptEstimateOverCap} class:field-error={attemptEstimateOverCap}>
          Estimated attempts: {draftAttemptEstimate} / {BENCHMARK_MAX_ATTEMPTS}
        </p>
      {/if}
      </fieldset>

      <div class="benchmark-editor-actions">
        <button type="button" class="primary" disabled={editorBusy || !!jsonlFieldError || draftHasInputError || attemptEstimateOverCap} onclick={saveSuite}>
          {editingBusy ? "Saving…" : "Save suite"}
        </button>
        <button type="button" class="secondary" disabled={editorBusy} onclick={cancelEditSuite}>Cancel</button>
      </div>
    </div>
  {/if}

  <div class="benchmark-body" class:suites-collapsed={suitesCollapsed}>
    <div class="benchmark-suite-list" class:collapsed={suitesCollapsed}>
      <div class="benchmark-suite-head">
        <PanelCollapseButton
          collapsed={suitesCollapsed}
          collapseLabel="Collapse suites"
          expandLabel="Expand suites"
          onclick={() => (suitesCollapsed = !suitesCollapsed)}
        />
        {#if !suitesCollapsed}
          <h3>Suites</h3>
        {/if}
        <span
          class="benchmark-action-tip"
          title={editingDraft ? "Save or cancel the open draft first." : "New suite"}
        >
          <IconActionButton
            name="plus"
            label="New suite"
            filled
            disabled={editorBusy || lifecycleBusy || !!editingDraft}
            onclick={startCreateSuite}
          />
        </span>
      </div>
      {#if !suitesCollapsed}
      {#if suites.length === 0}
        <p class="muted small">No suites yet. Create one to get started.</p>
      {/if}
      {#each suites as suite (suite.id)}
        <div class="benchmark-suite-row" class:active={selectedSuiteId === suite.id}>
          <button type="button" class="benchmark-suite-select" disabled={lifecycleBusy} onclick={() => selectSuite(suite.id)}>
            <strong>{suite.name}</strong>
            <span class="muted small">{suite.targets.length} target(s) · {suite.cases.length} case(s) · {runCountsBySuite[suite.id] ?? 0} run(s)</span>
          </button>
          <div class="benchmark-suite-actions">
            <span
              class="benchmark-action-tip"
              title={editingDraft
                ? "Save or cancel the open draft first."
                : suiteHasStoredRuns(suite.id)
                  ? LOCKED_SUITE_EDIT_REASON
                  : "Edit"}
            >
              <IconActionButton
                name="pencil"
                label="Edit"
                disabled={editorBusy || lifecycleBusy || !!editingDraft || suiteHasStoredRuns(suite.id)}
                onclick={() => startEditSuite(suite)}
              />
            </span>
            <span
              class="benchmark-action-tip"
              title={editingDraft ? "Save or cancel the open draft first." : "Duplicate"}
            >
              <IconActionButton
                name="copy"
                label="Duplicate"
                disabled={editorBusy || lifecycleBusy || !!editingDraft}
                onclick={() => startDuplicateSuite(suite)}
              />
            </span>
            <span
              class="benchmark-action-tip"
              title={draftEditsSuite(editingDraft, suite.id)
                ? "Save or cancel the open draft first."
                : runInFlight
                  ? "Stop the benchmark run before deleting a suite."
                  : "Delete"}
            >
              <IconActionButton
                name="trash"
                label="Delete"
                danger
                disabled={editorBusy || lifecycleBusy || runInFlight || draftEditsSuite(editingDraft, suite.id)}
                onclick={() => removeSuite(suite)}
              />
            </span>
          </div>
        </div>
      {/each}
      {/if}
    </div>

    {#if selectedSuiteId}
      {@const suite = suites.find((s) => s.id === selectedSuiteId)}
      {#if suite}
        {@const definition = suiteDefinitionView(suite)}
        <div class="benchmark-run-panel">
          <div class="benchmark-run-header">
            <div class="benchmark-run-title">
              <h3>{suite.name}</h3>
              {#if suiteOwnsActiveRun}
                <span class="badge badge-live"><span class="live-dot" aria-hidden="true"></span>Running</span>
              {/if}
            </div>
            {#if suiteOwnsActiveRun}
              <button
                type="button"
                class="benchmark-icon-btn stop"
                title="Stop. Prevents further dispatches; a model already asked to respond may still finish."
                aria-label="Stop run"
                onclick={handleStop}
              >
                <Icon name="stop" size={16} />
              </button>
            {:else}
              <button
                type="button"
                class="benchmark-icon-btn"
                disabled={runBusy || otherInferenceActive || !!activeRunId || !isBenchmarkSuite(suite) || draftEditsSuite(editingDraft, suite.id)}
                title={startRunTitle(suite)}
                aria-label="Start run"
                onclick={() => handleStart(suite)}
              >
                <Icon name={lifecycleBusy ? "loader" : "play"} size={16} class={lifecycleBusy ? "spin" : ""} />
              </button>
            {/if}
          </div>
          {#if suiteOwnsActiveRun}
            <p class="muted small benchmark-live-note">
              Stop prevents further dispatches; a model already asked to respond may still
              finish. Flint only records a result if it durably receives and saves one.
            </p>
          {/if}
          {#if draftEditsSuite(editingDraft, suite.id)}
            <p class="muted small">Save or cancel your edits before starting a run.</p>
          {/if}
          {#if otherInferenceActive && !activeRunId}
            <p class="muted small">Chat, dictation, transcription, summarization, or endpoint self-test is in progress — finish or stop it before starting a benchmark.</p>
          {/if}
          {#if !isBenchmarkSuite(suite)}
            <p class="muted small">
              This suite lists the same model alias twice; the runtime can only keep one variant
              loaded, so a new run would not measure both.
            </p>
          {/if}
          {#if lifecycleError}<div class="warning-banner">{lifecycleError}</div>{/if}

          {#key suite.id}
            <details class="benchmark-definition" open>
              <summary class="benchmark-section-head">
                <h4>Definition</h4>
                <Icon name="chevron-down" size={14} class="benchmark-disclosure-chevron" />
              </summary>
              {#if suiteHasStoredRuns(suite.id)}
                <p class="muted small">{LOCKED_SUITE_EDIT_REASON}</p>
              {/if}
              {#if definition.description}
                <p class="small benchmark-definition-description">{definition.description}</p>
              {/if}
              <dl class="benchmark-stat-row">
                <div class="benchmark-stat">
                  <dt>Warmups</dt>
                  <dd>{definition.warmupCount}</dd>
                </div>
                <div class="benchmark-stat">
                  <dt>Repeats</dt>
                  <dd>{definition.repeatCount}</dd>
                </div>
                <div class="benchmark-stat">
                  <dt>Temperature</dt>
                  <dd>{definition.temperatureLabel}</dd>
                </div>
                <div class="benchmark-stat">
                  <dt>Max tokens</dt>
                  <dd>{definition.maxTokensLabel}</dd>
                </div>
              </dl>
              <div class="benchmark-section-head">
                <h4>Targets</h4>
              </div>
              {#if definition.targets.length === 0}
                <p class="muted small">No targets.</p>
              {:else}
                <table class="benchmark-definition-table">
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th>Variant</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each definition.targets as target, i (i)}
                      <tr>
                        <td>{target.alias}</td>
                        <td>{target.variantLabel}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              {/if}
              <div class="benchmark-section-head">
                <h4>Cases</h4>
              </div>
              {#if definition.cases.length === 0}
                <p class="muted small">No cases yet.</p>
              {:else}
                <div class="benchmark-case-list">
                  {#each definition.cases as entry (entry.id)}
                    <details class="benchmark-case-row">
                      <summary class="benchmark-case-summary">
                        <Icon name="chevron-down" size={14} class="benchmark-disclosure-chevron" />
                        <strong>{entry.id}</strong>
                        {#if entry.tags.length}
                          <span class="benchmark-case-tags">{entry.tags.join(", ")}</span>
                        {/if}
                        <span class="benchmark-case-preview">{caseSummaryLine(entry)}</span>
                      </summary>
                      <div class="benchmark-case-detail">
                        {#if entry.messages}
                          {#each entry.messages as message, messageIndex (messageIndex)}
                            <p class="small benchmark-case-body"><span class="muted">{message.role}:</span> {message.content}</p>
                          {/each}
                        {:else}
                          <p class="small benchmark-case-body">{entry.prompt}</p>
                        {/if}
                        {#if entry.expected}
                          <p class="muted small">Expected (stored, not scored): {entry.expected}</p>
                        {/if}
                      </div>
                    </details>
                  {/each}
                </div>
              {/if}
            </details>
          {/key}

          <div class="benchmark-section-head">
            <h4>Runs</h4>
          </div>
          {#if runsForSelectedSuite.length === 0}
            <p class="muted small">No runs yet.</p>
          {/if}
          <ul class="benchmark-run-list">
            {#each runsForSelectedSuite as run (run.id)}
              <li class:active={selectedRunId === run.id}>
                <button type="button" class="benchmark-run-select" disabled={lifecycleBusy} onclick={() => openRun(run.id)}>
                  <span>{new Date(run.createdAt).toLocaleString()}</span>
                  {#if run.id === activeRunId}
                    <span class="badge badge-live"><span class="live-dot" aria-hidden="true"></span>Running</span>
                  {:else}
                    <span class="badge">{isRunInterrupted(run, activeRunId) ? "interrupted" : run.status}</span>
                  {/if}
                </button>
              </li>
            {/each}
          </ul>

          {#if selectedRunId && !selectedRun}
            {#if pollError}<div class="warning-banner">{pollError}</div>{/if}
            {#if resultError}<div class="warning-banner">{resultError}</div>{/if}
          {/if}

          {#if selectedRun}
            {@const currentRun = selectedRun}
            <div class="benchmark-run-detail">
              {#if pollError}<div class="warning-banner">{pollError}</div>{/if}
              <div class="benchmark-run-toolbar">
                {#if !selectedRunIsActive && isRunResumable(currentRun, activeRunId)}
                  <button
                    type="button"
                    class="primary small"
                    disabled={runBusy || otherInferenceActive || !!activeRunId}
                    title={otherInferenceActive ? "Finish or stop chat, dictation, transcription, summarization, or endpoint self-test before resuming a benchmark." : "Resume"}
                    onclick={() => handleResume(currentRun.id)}
                  >
                    {lifecycleBusy ? "Resuming…" : "Resume"}
                  </button>
                {/if}
                <button type="button" class="secondary small" title="Export this run as JSON" onclick={() => exportRun(currentRun.id)}>Export JSON</button>
              </div>

              {#each progressMatrix as target}
                <div class="benchmark-target-progress">
                  <strong>{currentRun.suite.targets[target.targetIndex]?.alias}</strong>
                  <span class="muted small">
                    {target.counts.succeeded} succeeded · {target.counts.failed} failed ·
                    {target.counts.running} running · {target.counts.uncertain} uncertain ·
                    {target.counts.pending} pending
                    ({target.counts.total} total)
                  </span>
                  <div class="benchmark-progress-cells">
                    {#each target.positions as pos}
                      <span
                        class="benchmark-cell {pos.state}"
                        role="img"
                        title="{pos.phase} {pos.caseIndex ?? ''} state={pos.state}"
                        aria-label="{pos.phase}{pos.caseIndex != null ? ` case ${pos.caseIndex + 1}` : ''} {pos.state}"
                      ></span>
                    {/each}
                  </div>
                </div>
              {/each}

              {#if !selectedRunIsActive}
                {#if resultError}<div class="warning-banner">{resultError}</div>{/if}
                {#if resultView && resultViewRunId === currentRun.id}
                  <div class="benchmark-results">
                    <div class="benchmark-section-head">
                      <h4>Results</h4>
                    </div>
                    <p class="muted small">Response time is the full call, not time to first token. Warmups do not get a vote in the median.</p>
                    {#each resultView as target (target.targetIndex)}
                      <div class="benchmark-score-card">
                        <div class="benchmark-score-head">
                          <strong>{target.alias}</strong>
                          <span class="benchmark-score-median">
                            {#if target.medianResponseMs !== null}
                              {formatResponseMs(target.medianResponseMs)}
                            {:else}
                              —
                            {/if}
                          </span>
                        </div>
                        <p class="muted small">
                          {target.succeededMeasured} measured succeeded
                          {#if target.medianResponseMs !== null}
                            · median response time {formatResponseMs(target.medianResponseMs)}
                          {:else if target.succeededMeasured > 0}
                            · median response time unavailable because a succeeded attempt has no usable timing
                          {/if}
                        </p>
                        {#if target.measured.length > 0}
                          <table class="benchmark-results-table">
                            <thead>
                              <tr>
                                <th>Case</th>
                                <th>Repeat</th>
                                <th>Status</th>
                                <th>Response time</th>
                                <th>Tokens</th>
                                <th>Served variant</th>
                                <th></th>
                              </tr>
                            </thead>
                            <tbody>
                              {#each target.measured as row (row.logicalAttemptId)}
                                <tr>
                                  <td>{row.caseId ?? "—"}</td>
                                  <td>{row.repeatIndex == null ? "—" : row.repeatIndex + 1}</td>
                                  <td><span class="status-chip {row.status}">{row.status}</span></td>
                                  <td>{formatResponseMs(row.responseTimeMs)}</td>
                                  <td>{row.promptTokens == null && row.completionTokens == null ? "—" : `${row.promptTokens ?? "—"} / ${row.completionTokens ?? "—"}`}</td>
                                  <td>{row.servedVariantId ?? "—"}</td>
                                  <td>
                                    {#if row.responseText !== null && row.attemptId}
                                      <button
                                        type="button"
                                        class="benchmark-icon-btn ghost"
                                        title={expandedResultId === row.attemptId ? "Hide response" : "Show response"}
                                        aria-label={expandedResultId === row.attemptId ? "Hide response" : "Show response"}
                                        aria-expanded={expandedResultId === row.attemptId}
                                        onclick={() => expandedResultId = expandedResultId === row.attemptId ? null : row.attemptId}
                                      >
                                        <Icon name={expandedResultId === row.attemptId ? "chevron-up" : "chevron-down"} size={14} />
                                      </button>
                                    {/if}
                                  </td>
                                </tr>
                                {#if row.errorMessage}
                                  <tr>
                                    <td colspan="7" class="benchmark-result-error">{row.errorMessage}</td>
                                  </tr>
                                {/if}
                                {#if row.attemptId && expandedResultId === row.attemptId && row.responseText !== null}
                                  <tr>
                                    <td colspan="7">
                                      <div class="benchmark-response-card">
                                        <div class="benchmark-response-toolbar">
                                          <button
                                            type="button"
                                            class="tiny"
                                            title={rawResultIds[row.attemptId] ? "Show the formatted answer" : "Show the raw response"}
                                            aria-pressed={rawResultIds[row.attemptId] ? "true" : "false"}
                                            onclick={() => toggleRawResult(row.attemptId!)}
                                          >{rawResultIds[row.attemptId] ? "Formatted" : "Raw"}</button>
                                          <button
                                            type="button"
                                            class="benchmark-icon-btn ghost"
                                            title="Copy response"
                                            aria-label="Copy response"
                                            onclick={() => copyBenchmarkResponse(row.responseText ?? "")}
                                          >
                                            <Icon name="copy" size={14} />
                                          </button>
                                        </div>
                                        {#if rawResultIds[row.attemptId]}
                                          <pre class="benchmark-response">{row.responseText}</pre>
                                        {:else}
                                          <MessageRenderer content={presentBenchmarkResponse(row.responseText, [target.alias, row.servedVariantId, currentRun.suite.targets[target.targetIndex]?.variantId])} role="assistant" messageKey={row.attemptId} />
                                        {/if}
                                      </div>
                                    </td>
                                  </tr>
                                {/if}
                              {/each}
                            </tbody>
                          </table>
                        {/if}
                        {#if target.warmups.length > 0}
                          <p class="muted small">
                            Warmups (not measured): {target.warmups.map((row) => row.status).join(", ")}
                          </p>
                        {/if}
                      </div>
                    {/each}
                  </div>
                {:else if !resultError}
                  <p class="muted small">Loading results…</p>
                {/if}
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .benchmark-preview {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1rem;
    height: 100%;
    overflow-y: auto;
  }
  .benchmark-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1rem;
  }
  .benchmark-body {
    display: grid;
    grid-template-columns: minmax(16rem, 22rem) minmax(0, 1fr);
    gap: 1rem;
    align-items: start;
  }
  .benchmark-body.suites-collapsed {
    grid-template-columns: 3.25rem minmax(0, 1fr);
  }
  .benchmark-body:not(:has(.benchmark-run-panel)):not(.suites-collapsed) {
    grid-template-columns: minmax(0, 1fr);
  }
  .benchmark-suite-list, .benchmark-run-panel, .benchmark-editor {
    border: 1px solid var(--border, #ccc);
    border-radius: 8px;
    padding: 0.75rem;
    min-width: 0;
  }
  .benchmark-suite-list.collapsed {
    padding: 0.4rem 0.2rem;
  }
  .benchmark-suite-head {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    margin-bottom: 0.55rem;
  }
  .benchmark-suite-list.collapsed .benchmark-suite-head {
    flex-direction: column;
    margin-bottom: 0;
  }
  .benchmark-suite-head h3 {
    margin: 0;
    flex: 1;
    min-width: 0;
    font-size: 1rem;
    color: var(--fg, inherit);
  }
  .benchmark-editor {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .benchmark-editor h3,
  .benchmark-editor p,
  .benchmark-editor ul {
    margin: 0;
  }
  .benchmark-suite-row {
    display: flex;
    align-items: center;
    flex-wrap: nowrap;
    gap: 0.25rem;
    margin-bottom: 0.25rem;
  }
  .benchmark-suite-actions {
    display: flex;
    align-items: center;
    gap: 0.2rem;
    flex: none;
  }
  .benchmark-action-tip {
    display: inline-flex;
  }
  /* The action button lives in a child component. Disabled controls do not show a title in WebView2. */
  .benchmark-action-tip :global(button:disabled) {
    pointer-events: none;
  }
  .benchmark-suite-select, .benchmark-run-select {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.25rem;
    /* The shared button rule paints white text for filled actions. These controls
       sit on the panel, so they have to use the theme foreground or light mode
       washes the suite name and run time out. */
    color: var(--fg, inherit);
  }
  .benchmark-suite-row.active, .benchmark-run-list li.active {
    background: var(--surface-active, rgba(127,127,127,0.15));
    border-radius: 6px;
  }
  .benchmark-target-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-bottom: 0.25rem;
  }
  .benchmark-target-row select {
    flex: 1 1 0;
    min-width: 0;
    width: auto;
  }
  .benchmark-target-row button {
    flex: none;
  }
  .benchmark-form-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
    gap: 0.75rem;
  }
  .benchmark-temperature {
    grid-column: 1 / -1;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.35rem;
    min-width: 0;
  }
  .benchmark-temperature-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
    width: 100%;
  }
  .benchmark-temperature-head label {
    font-size: 0.85rem;
  }
  .benchmark-range {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
  }
  .benchmark-range-end,
  .benchmark-range-value {
    flex: none;
    font-variant-numeric: tabular-nums;
  }
  .benchmark-range input[type="range"] {
    flex: 1 1 auto;
    min-width: 8rem;
    accent-color: var(--accent, #3b82f6);
  }
  .benchmark-editor-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  .benchmark-editor-fieldset {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    border: none;
    margin: 0;
    padding: 0;
    min-width: 0;
  }
  .benchmark-editor-fieldset label {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.3rem;
    min-width: 0;
    font-size: 0.85rem;
  }
  .benchmark-editor-fieldset label > input:not([type="checkbox"]),
  .benchmark-editor-fieldset label > textarea {
    width: 100%;
    box-sizing: border-box;
    font: inherit;
    font-weight: 400;
  }
  .benchmark-targets,
  .benchmark-cases {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.4rem;
    min-width: 0;
  }
  .benchmark-editor-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .benchmark-editor-head strong {
    min-width: 0;
  }
  .benchmark-editor-head-actions {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex: none;
  }
  button.editor-add {
    font-size: 0.85rem;
    line-height: 1.2;
    padding: 6px 12px;
    min-height: 2.25rem;
    background: var(--panel-bg, transparent);
    border: 1px solid var(--border, #ccc);
    color: var(--fg, inherit);
  }
  button.editor-add:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent, #3b82f6) 12%, var(--panel-bg, #fff));
  }
  .benchmark-errors {
    color: var(--danger, #c0392b);
    font-size: 0.85rem;
  }
  .field-error {
    color: var(--danger, #c0392b);
    font-size: 0.8rem;
  }
  /* Utility classes live in +page.svelte's scoped sheet and do not apply to this child. */
  .muted { color: var(--muted, #888); }
  .small { font-size: 0.85rem; }
  .badge {
    font-size: 0.7rem;
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--subtle-bg, rgba(127,127,127,0.15));
    color: var(--fg, inherit);
  }
  .warning-banner {
    padding: 8px 12px;
    border-radius: 6px;
    border: 1px solid color-mix(in srgb, var(--warning, #b8860b) 40%, transparent);
    background: color-mix(in srgb, var(--warning, #b8860b) 10%, transparent);
    color: var(--warning, #b8860b);
    font-size: 0.8rem;
  }
  button {
    padding: 6px 12px;
    background: var(--button-bg, #444);
    color: white;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    font-size: 0.85rem;
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  button.secondary {
    background: var(--panel-bg, #222);
    color: var(--fg, inherit);
    border: 1px solid color-mix(in srgb, var(--fg, #e8e8e8) 35%, var(--border, #2a2a30));
  }
  button.small {
    font-size: 0.75rem;
    padding: 2px 8px;
  }
  button.tiny {
    font-size: 0.7rem;
    padding: 1px 6px;
    background: var(--panel-bg, transparent);
    border: 1px solid var(--border, #ccc);
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--fg, inherit);
  }
  button.tiny.danger-btn {
    background: var(--danger-btn-bg, #9f1239);
    border-color: var(--danger-btn-bg, #9f1239);
    color: var(--danger-btn-fg, #fff);
  }
  .benchmark-active-run-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 8px 12px;
    border-radius: 6px;
    border: 1px solid color-mix(in srgb, var(--warning, #b8860b) 40%, transparent);
    background: color-mix(in srgb, var(--warning, #b8860b) 10%, transparent);
    font-size: 0.85rem;
  }
  .benchmark-run-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .benchmark-run-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
  }
  .benchmark-run-title {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    min-width: 0;
  }
  .benchmark-run-title h3 {
    margin: 0;
  }
  .benchmark-live-note {
    margin: 0.35rem 0 0;
  }
  .benchmark-section-head {
    display: flex;
    align-items: baseline;
    margin: 1.15rem 0 0.45rem;
    padding-bottom: 0.3rem;
    border-bottom: 1px solid var(--border, #ccc);
  }
  .benchmark-definition > summary.benchmark-section-head {
    margin-top: 0.85rem;
    width: 100%;
    cursor: pointer;
    list-style: none;
    color: var(--fg, inherit);
  }
  .benchmark-definition > summary::-webkit-details-marker,
  .benchmark-case-summary::-webkit-details-marker {
    display: none;
  }
  .benchmark-definition > summary::marker,
  .benchmark-case-summary::marker {
    content: none;
  }
  .benchmark-definition > summary :global(.benchmark-disclosure-chevron) {
    margin-left: auto;
    flex: none;
    transition: transform 0.15s ease;
  }
  .benchmark-definition[open] > summary :global(.benchmark-disclosure-chevron),
  .benchmark-case-row[open] > summary :global(.benchmark-disclosure-chevron) {
    transform: rotate(180deg);
  }
  .benchmark-definition-description {
    margin: 0.45rem 0 0;
  }
  .benchmark-stat-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0.75rem 0 0.1rem;
  }
  .benchmark-stat {
    flex: 1 1 7.5rem;
    margin: 0;
    padding: 0.45rem 0.7rem 0.5rem;
    border: 1px solid var(--border, #ccc);
    border-radius: 8px;
    background: color-mix(in srgb, var(--accent, #3b82f6) 12%, var(--panel-bg, #fff));
  }
  .benchmark-stat dt {
    margin: 0;
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--muted, #6c757d);
  }
  .benchmark-stat dd {
    margin: 0.12rem 0 0;
    font-size: 1.15rem;
    font-weight: 700;
    line-height: 1.2;
    font-variant-numeric: tabular-nums;
    color: var(--fg, inherit);
  }
  .benchmark-section-head h4 {
    margin: 0;
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fg, inherit);
  }
  .benchmark-run-toolbar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.85rem;
  }
  .benchmark-icon-btn {
    width: 2rem;
    height: 2rem;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    border-radius: 999px;
    background: var(--button-bg, #1d4ed8);
    color: #fff;
  }
  .benchmark-icon-btn.stop {
    background: var(--danger-btn-bg, #9f1239);
    color: var(--danger-btn-fg, #fff);
  }
  .benchmark-icon-btn.ghost {
    width: 1.75rem;
    height: 1.75rem;
    background: var(--panel-bg, transparent);
    color: var(--fg, inherit);
    border: 1px solid var(--border, #ccc);
  }
  .benchmark-icon-btn :global(.spin) {
    animation: benchmark-spin 0.8s linear infinite;
  }
  .badge-live {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-weight: 700;
    color: var(--accent, #3b82f6);
    background: color-mix(in srgb, var(--accent, #3b82f6) 14%, transparent);
  }
  .live-dot {
    width: 0.45rem;
    height: 0.45rem;
    border-radius: 50%;
    background: var(--accent, #3b82f6);
    animation: benchmark-pulse 1.2s ease-in-out infinite;
  }
  .benchmark-score-card {
    margin-top: 0.85rem;
    padding: 0.75rem 0.8rem 0.4rem;
    border: 1px solid var(--border, #ccc);
    border-radius: 10px;
    background: color-mix(in srgb, var(--panel-bg, #fff) 88%, var(--accent, #3b82f6));
  }
  .benchmark-score-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .benchmark-score-median {
    font-variant-numeric: tabular-nums;
    font-weight: 700;
    font-size: 1.05rem;
  }
  .status-chip {
    display: inline-block;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    font-size: 0.72rem;
    font-weight: 600;
    background: var(--subtle-bg, rgba(127, 127, 127, 0.15));
  }
  .status-chip.succeeded { color: var(--success, #198754); }
  .status-chip.failed { color: var(--danger, #dc3545); }
  .status-chip.running { color: var(--accent, #3b82f6); font-weight: 700; }
  .benchmark-response-card {
    margin: 0.35rem 0 0.5rem;
    padding: 0.55rem 0.65rem;
    border-radius: 8px;
    background: var(--panel-bg, transparent);
    border: 1px solid var(--border, #ccc);
  }
  .benchmark-response-toolbar {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.35rem;
    margin-bottom: 0.35rem;
  }
  .benchmark-response-toolbar .tiny {
    min-width: 6.5rem;
    justify-content: center;
  }
  .benchmark-response-card :global(.copy-btn) {
    display: none;
  }
  @keyframes benchmark-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.35; transform: scale(0.72); }
  }
  @keyframes benchmark-spin {
    to { transform: rotate(360deg); }
  }
  @media (prefers-reduced-motion: reduce) {
    .live-dot,
    .benchmark-icon-btn :global(.spin) {
      animation: none;
    }
    .benchmark-definition > summary :global(.benchmark-disclosure-chevron),
    .benchmark-case-summary :global(.benchmark-disclosure-chevron) {
      transition: none;
    }
  }
  .benchmark-run-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .benchmark-target-progress {
    margin-top: 0.5rem;
  }
  .benchmark-progress-cells {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    margin-top: 0.25rem;
  }
  .benchmark-cell {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    display: inline-block;
    background: var(--muted, #999);
  }
  .benchmark-cell.succeeded { background: var(--success, #2ecc71); }
  .benchmark-cell.failed { background: var(--danger, #e74c3c); }
  .benchmark-cell.running { background: var(--accent, #3b82f6); }
  .benchmark-cell.uncertain { background: var(--warning, #f39c12); }
  .benchmark-cell.pending { background: var(--muted, #ccc); }
  .benchmark-preview input,
  .benchmark-preview textarea,
  .benchmark-preview select {
    background: var(--input-bg, transparent);
    color: var(--fg, inherit);
    border: 1px solid var(--border, #ccc);
    border-radius: 4px;
    padding: 4px 6px;
  }
  .benchmark-file-input { display: none; }
  .benchmark-editor-fieldset label.benchmark-check {
    flex-direction: row;
    align-items: center;
    justify-content: flex-start;
    width: fit-content;
    gap: 0.4rem;
    margin: 0;
    font-weight: 400;
  }
  .benchmark-check input {
    width: auto;
    flex: none;
  }
  .benchmark-jsonl-help {
    margin: 0;
  }
  .benchmark-jsonl {
    width: 100%;
    box-sizing: border-box;
    min-height: 9rem;
    font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
    font-size: 0.85rem;
    line-height: 1.45;
    resize: vertical;
  }
  .benchmark-jsonl.invalid {
    border-color: var(--danger, #c0392b);
  }
  .benchmark-case-edit-actions {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex-wrap: wrap;
  }
  .benchmark-case-edit {
    border-top: 1px solid var(--border, #ccc);
    padding: 0.5rem 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .benchmark-case-list {
    margin: 0.15rem 0 0;
  }
  .benchmark-case-row {
    border-top: 1px solid var(--border, #ccc);
  }
  .benchmark-case-row:last-child {
    border-bottom: 1px solid var(--border, #ccc);
  }
  .benchmark-case-summary {
    display: flex;
    align-items: baseline;
    gap: 0.55rem;
    padding: 0.45rem 0.15rem;
    cursor: pointer;
    color: var(--fg, inherit);
  }
  .benchmark-case-summary :global(.benchmark-disclosure-chevron) {
    flex: none;
    align-self: center;
    transition: transform 0.15s ease;
  }
  .benchmark-case-tags {
    font-size: 0.75rem;
    color: var(--muted, #6c757d);
    white-space: nowrap;
  }
  .benchmark-case-preview {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg, inherit);
    font-size: 0.85rem;
  }
  .benchmark-case-row[open] .benchmark-case-preview {
    display: none;
  }
  .benchmark-case-detail {
    padding: 0 0.15rem 0.55rem 1.45rem;
  }
  .benchmark-case-body,
  .benchmark-response {
    white-space: pre-wrap;
    margin: 0.2rem 0 0;
  }
  .benchmark-results { overflow-x: auto; }
  .benchmark-results-table,
  .benchmark-definition-table {
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    font-size: 0.8rem;
    margin-top: 0.45rem;
    border: 1px solid var(--border, #ccc);
    border-radius: 8px;
    overflow: hidden;
  }
  .benchmark-results-table th,
  .benchmark-results-table td,
  .benchmark-definition-table th,
  .benchmark-definition-table td {
    text-align: left;
    padding: 0.4rem 0.5rem;
    border-bottom: 1px solid var(--border, #ccc);
    vertical-align: top;
    color: var(--fg, inherit);
  }
  .benchmark-results-table th,
  .benchmark-definition-table th {
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted, #6c757d);
    background: color-mix(in srgb, var(--accent, #3b82f6) 10%, var(--panel-bg, #fff));
  }
  .benchmark-results-table td:nth-child(4),
  .benchmark-results-table th:nth-child(4) {
    font-variant-numeric: tabular-nums;
  }
  .benchmark-results-table tr:last-child td,
  .benchmark-definition-table tr:last-child td {
    border-bottom: none;
  }
  .benchmark-result-error { color: var(--danger, #c0392b); }
</style>
