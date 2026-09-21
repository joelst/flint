<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import type { ModelInfo } from "./sdk";
  import {
    listBenchmarkSuites,
    putBenchmarkSuiteIfNoRuns,
    deleteBenchmarkSuiteIfNoRuns,
    listBenchmarkRunHeadersForSuite,
    countBenchmarkRunsBySuite,
    getBenchmarkRun,
    getBenchmarkRunWithAttempts,
    listAttemptSummariesForRun,
  } from "./benchmark-repository";
  import {
    BENCHMARK_MAX_TARGETS,
    BENCHMARK_MAX_ATTEMPTS,
    isBenchmarkSuite,
    type BenchmarkSuite,
    type BenchmarkTarget,
  } from "./benchmark-suite";
  import { aliasChoicesForTarget, applyTargetAlias, cachedVariantIds, draftEditsSuite, draftFromSuite, buildSuiteFromDraft, estimateDraftAttempts, variantChoicesForTarget, type SuiteDraft } from "./benchmark-draft";
  import { buildProgressMatrix, isRunInterrupted, isRunResumable, nextRunPollAction, nextRunPollActionAfterReread, type AttemptSummary } from "./benchmark-progress";
  import { buildBenchmarkExport } from "./benchmark-export";
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
  let loadError = "";
  let selectedSuiteId: string | null = null;
  let runsForSelectedSuite: BenchmarkRunHeader[] = [];
  let runCountsBySuite: Record<string, number> = Object.create(null);

  let editingDraft: SuiteDraft | null = null;
  let editingErrors: string[] = [];
  let editingBusy = false;
  /** Held across create/edit/save/delete so Delete cannot race a Save that recreates the suite. */
  let suiteBusy = false;

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
  $: editorBusy = editingBusy || suiteBusy;
  /** Start/resume handshake or live run. Does not freeze Save/Cancel of an unrelated draft. */
  $: runBusy = lifecycleBusy || runInFlight;
  function suiteHasStoredRuns(suiteId: string): boolean {
    return (runCountsBySuite[suiteId] ?? 0) > 0;
  }

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
    selectedSuiteId = id;
    selectedRunId = null;
    selectedRun = null;
    selectedRunAttempts = [];
    runsForSelectedSuite = [];
    lifecycleError = "";
    pollError = "";
    stopPolling();
    await refreshRunsForSelectedSuite(id);
  }

  function newSuiteDraft(): SuiteDraft {
    return {
      name: "",
      targets: [],
      casesJsonl: "",
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
    editingErrors = [];
  }

  function startCreateSuite() {
    if (editorBusy || lifecycleBusy) return;
    editingDraft = newSuiteDraft();
    editingErrors = [];
  }

  async function startEditSuite(suite: BenchmarkSuite) {
    if (editorBusy || lifecycleBusy) return;
    // Editing is restricted to suites with no runs yet — a suite with runs already has attempts
    // recorded against its frozen snapshot, and silently changing the live suite underneath
    // that history would be misleading even though runs themselves are immutable.
    if ((runCountsBySuite[suite.id] ?? 0) > 0) {
      loadError = "This suite has runs and can no longer be edited. Create a new suite to make changes.";
      return;
    }
    editingDraft = draftFromSuite(suite);
    editingErrors = [];
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

  $: draftAttemptEstimate = editingDraft ? estimateDraftAttempts(editingDraft) : null;

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
      editingDraft = null;
      await refreshSuites();
    } finally {
      editingBusy = false;
      suiteBusy = false;
    }
  }

  async function removeSuite(suite: BenchmarkSuite) {
    if (editorBusy || lifecycleBusy || runInFlight) return;
    if (draftEditsSuite(editingDraft, suite.id)) return;
    suiteBusy = true;
    // `runCountsBySuite` is only a UI hint (last refresh) — the actual guard against deleting a
    // suite that has gained a run since then lives inside `deleteBenchmarkSuiteIfNoRuns`, which
    // rechecks atomically in the same transaction as the delete.
    try {
      const res = await deleteBenchmarkSuiteIfNoRuns(suite.id);
      if (destroyed) return;
      if (!res.ok) {
        loadError = res.error || "Could not delete suite";
        return;
      }
      // Defense: a stale editor for this id would recreate the suite on Save.
      if (draftEditsSuite(editingDraft, suite.id)) discardDraft();
      if (selectedSuiteId === suite.id) {
        selectedSuiteId = null;
        runsForSelectedSuite = [];
      }
      await refreshSuites();
    } finally {
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
    runRes: { ok: boolean; value?: BenchmarkRun | null; error?: string },
    summariesRes: { ok: boolean; value?: AttemptSummary[] | null; error?: string },
  ): boolean {
    if (runRes.ok && summariesRes.ok) {
      selectedRun = runRes.value ?? null;
      selectedRunAttempts = summariesRes.value ?? [];
      pollError = "";
      return true;
    }
    pollError = !runRes.ok
      ? `Could not refresh run status: ${runRes.error}`
      : `Could not refresh run attempts: ${summariesRes.error}`;
    return false;
  }

  async function refreshSelectedRun() {
    const runId = selectedRunId;
    if (!runId) return;
    const generation = ++refreshGeneration;
    const ownedAtStart = runId === activeRunId;
    const runRes = await getBenchmarkRun(runId);
    if (generation !== refreshGeneration || selectedRunId !== runId) return;
    const summariesRes = await listAttemptSummariesForRun(runId);
    if (generation !== refreshGeneration || selectedRunId !== runId) return;
    // Apply run + summaries as one snapshot. A completed row with a failed summaries read
    // must not paint as done with the previous attempt list (last result missing, no error).
    const confirmed = applyPollPair(runRes, summariesRes);
    const ownedNow = runId === activeRunId;
    const poll = nextRunPollAction({
      confirmed,
      ownedNow,
      ownedAtStart,
      status: confirmed ? selectedRun?.status : undefined,
    });
    if (poll === 'keep') return;
    if (poll === 'reread') {
      const finalRun = await getBenchmarkRun(runId);
      if (generation !== refreshGeneration || selectedRunId !== runId) return;
      const finalSummaries = await listAttemptSummariesForRun(runId);
      if (generation !== refreshGeneration || selectedRunId !== runId) return;
      const rereadConfirmed = applyPollPair(finalRun, finalSummaries);
      const after = nextRunPollActionAfterReread({
        confirmed: rereadConfirmed,
        ownedNow: runId === activeRunId,
        ownedAtStart,
        status: rereadConfirmed ? selectedRun?.status : undefined,
      });
      if (after === 'keep') return;
    }
    if (runId !== activeRunId) {
      stopPolling();
      if (selectedSuiteId) await refreshRunsForSelectedSuite(selectedSuiteId);
    }
  }

  async function openRun(runId: string) {
    selectedRunId = runId;
    selectedRun = null;
    selectedRunAttempts = [];
    lifecycleError = "";
    pollError = "";
    stopPolling();
    const token = ++openRunToken;
    await refreshSelectedRun();
    if (token !== openRunToken || selectedRunId !== runId || destroyed) return;
    if (runId === activeRunId) {
      schedulePoll(runId);
    }
  }

  $: progressMatrix = selectedRun
    ? buildProgressMatrix(selectedRun.suite, selectedRunAttempts, {
        live: selectedRun.id === activeRunId,
        knownAttemptIds: selectedRun.id === activeRunId ? knownAttemptIds : null,
      })
    : [];
  $: selectedRunIsActive = !!selectedRun && selectedRun.id === activeRunId;

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
    if (runBusy) return;
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
    <button type="button" class="secondary small" onclick={startCreateSuite} disabled={editorBusy || lifecycleBusy}>New suite</button>
  </div>

  {#if loadError}
    <div class="warning-banner">{loadError}</div>
  {/if}

  {#if runError}
    <div class="warning-banner">{runError}</div>
  {/if}

  {#if activeRunId && !selectedRunIsActive}
    <!-- Suite/run selection stays enabled while a run executes, so the run-detail Stop button
         below is hidden whenever the user has selected anything other than the live run. This
         standing control is the only way to stop it in that case. -->
    <div class="benchmark-active-run-banner">
      <span>A benchmark run is active in the background.</span>
      <button type="button" class="secondary small" onclick={handleStop}>Stop</button>
    </div>
  {/if}

  {#if editingDraft}
    <div class="benchmark-editor">
      <h3>{editingDraft.id ? "Edit suite" : "New suite"}</h3>
      {#if editingErrors.length}
        <ul class="benchmark-errors">
          {#each editingErrors as err}<li>{err}</li>{/each}
        </ul>
      {/if}
      <!-- A save in flight must not let any control here keep mutating `editingDraft` --
           a successful save clears the draft, and any edit made during that window would be
           silently discarded rather than saved or visibly rejected. A native `fieldset` disables
           every input/select/button inside it in one place, so a future control added here is
           covered automatically instead of needing its own `disabled={editorBusy}` wiring. -->
      <fieldset class="benchmark-editor-fieldset" disabled={editorBusy}>
      <label>
        Name
        <input type="text" bind:value={editingDraft.name} />
      </label>
      <label>
        Description
        <textarea bind:value={editingDraft.description} rows="2"></textarea>
      </label>

      <div class="benchmark-targets">
        <strong>Targets ({editingDraft.targets.length}/{BENCHMARK_MAX_TARGETS})</strong>
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
              <option value="">Default variant</option>
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
        {#if editingDraft.targets.length < BENCHMARK_MAX_TARGETS}
          <button type="button" class="tiny" onclick={addTarget} disabled={availableModels.length === 0}>
            + Add target
          </button>
        {/if}
        {#if editingDraft.targets.some((t) =>
          aliasChoicesForTarget(availableModels.map((m) => m.alias), t.alias).some((c) => !c.available)
          || variantChoicesForTarget(variantsForAlias(t.alias), t.variantId).some((c) => !c.available)
        )}
          <p class="muted small">
            A stored model or variant is not available locally. Saving keeps it; Start will try
            to load that build. Pick a downloaded model to measure something already on disk.
          </p>
        {/if}
      </div>

      <label>
        Cases (JSONL — one case per line, e.g. {`{"id":"c1","prompt":"..."}`})
        <textarea bind:value={editingDraft.casesJsonl} rows="6"></textarea>
      </label>

      <div class="benchmark-form-row">
        <label>
          Warmups
          <input type="number" min="0" max="1" bind:value={editingDraft.warmupCount} />
        </label>
        <label>
          Repeats
          <input type="number" min="1" max="3" bind:value={editingDraft.repeatCount} />
        </label>
      </div>

      {#if draftAttemptEstimate !== null}
        <p class="muted small">
          Estimated attempts: {draftAttemptEstimate} / {BENCHMARK_MAX_ATTEMPTS}
        </p>
      {/if}
      </fieldset>

      <div class="benchmark-editor-actions">
        <button type="button" class="primary" disabled={editorBusy} onclick={saveSuite}>
          {editingBusy ? "Saving…" : "Save suite"}
        </button>
        <button type="button" class="secondary" disabled={editorBusy} onclick={cancelEditSuite}>Cancel</button>
      </div>
    </div>
  {/if}

  <div class="benchmark-body">
    <div class="benchmark-suite-list">
      <h3>Suites</h3>
      {#if suites.length === 0}
        <p class="muted small">No suites yet. Create one to get started.</p>
      {/if}
      {#each suites as suite (suite.id)}
        <div class="benchmark-suite-row" class:active={selectedSuiteId === suite.id}>
          <button type="button" class="benchmark-suite-select" disabled={lifecycleBusy} onclick={() => selectSuite(suite.id)}>
            <strong>{suite.name}</strong>
            <span class="muted small">{suite.targets.length} target(s) · {suite.cases.length} case(s) · {runCountsBySuite[suite.id] ?? 0} run(s)</span>
          </button>
          <button type="button" class="tiny" disabled={editorBusy || lifecycleBusy || suiteHasStoredRuns(suite.id)} onclick={() => startEditSuite(suite)}>Edit</button>
          <button
            type="button"
            class="tiny danger-btn"
            disabled={editorBusy || lifecycleBusy || runInFlight || suiteHasStoredRuns(suite.id) || draftEditsSuite(editingDraft, suite.id)}
            onclick={() => removeSuite(suite)}
          >Delete</button>
        </div>
      {/each}
    </div>

    {#if selectedSuiteId}
      {@const suite = suites.find((s) => s.id === selectedSuiteId)}
      {#if suite}
        <div class="benchmark-run-panel">
          <div class="benchmark-run-header">
            <h3>{suite.name}</h3>
            <button
              type="button"
              class="primary small"
              disabled={runBusy || otherInferenceActive || !!activeRunId || !isBenchmarkSuite(suite) || draftEditsSuite(editingDraft, suite.id)}
              title={otherInferenceActive ? "Finish or stop chat, dictation, transcription, summarization, or endpoint self-test before starting a benchmark." : undefined}
              onclick={() => handleStart(suite)}
            >
              {lifecycleBusy ? "Starting…" : "Start run"}
            </button>
          </div>
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

          <h4>Runs</h4>
          {#if runsForSelectedSuite.length === 0}
            <p class="muted small">No runs yet.</p>
          {/if}
          <ul class="benchmark-run-list">
            {#each runsForSelectedSuite as run (run.id)}
              <li class:active={selectedRunId === run.id}>
                <button type="button" class="benchmark-run-select" disabled={lifecycleBusy} onclick={() => openRun(run.id)}>
                  <span>{new Date(run.createdAt).toLocaleString()}</span>
                  <span class="badge">{isRunInterrupted(run, activeRunId) ? "interrupted" : run.status}</span>
                  {#if run.id === activeRunId}<span class="badge">active</span>{/if}
                </button>
              </li>
            {/each}
          </ul>

          {#if selectedRun}
            {@const currentRun = selectedRun}
            <div class="benchmark-run-detail">
              {#if pollError}<div class="warning-banner">{pollError}</div>{/if}
              <div class="benchmark-run-actions">
                {#if selectedRunIsActive}
                  <button type="button" class="secondary small" onclick={handleStop}>Stop</button>
                  <p class="muted small">
                    Stop prevents further dispatches; a model already asked to respond may still
                    finish. Flint only records a result if it durably receives and saves one.
                  </p>
                {:else if isRunResumable(currentRun, activeRunId)}
                  <button
                    type="button"
                    class="primary small"
                    disabled={runBusy || otherInferenceActive || !!activeRunId}
                    title={otherInferenceActive ? "Finish or stop chat, dictation, transcription, summarization, or endpoint self-test before resuming a benchmark." : undefined}
                    onclick={() => handleResume(currentRun.id)}
                  >
                    {lifecycleBusy ? "Resuming…" : "Resume"}
                  </button>
                {/if}
                <button type="button" class="tiny" onclick={() => exportRun(currentRun.id)}>Export JSON</button>
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
    grid-template-columns: 260px 1fr;
    gap: 1rem;
    align-items: start;
  }
  .benchmark-suite-list, .benchmark-run-panel, .benchmark-editor {
    border: 1px solid var(--border, #ccc);
    border-radius: 8px;
    padding: 0.75rem;
  }
  .benchmark-suite-row {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    margin-bottom: 0.25rem;
  }
  .benchmark-suite-select, .benchmark-run-select {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.25rem;
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
  .benchmark-form-row {
    display: flex;
    gap: 1rem;
  }
  .benchmark-editor-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  .benchmark-editor-fieldset {
    border: none;
    margin: 0;
    padding: 0;
    min-width: 0;
  }
  .benchmark-errors {
    color: var(--danger, #c0392b);
    font-size: 0.85rem;
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
    background: var(--subtle-bg, rgba(127,127,127,0.2));
    color: var(--fg, inherit);
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
  }
  .danger-btn {
    border-color: #ef4444;
    color: #fecaca;
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
</style>
