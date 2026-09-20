<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import type { ModelInfo } from "./sdk";
  import {
    listBenchmarkSuites,
    putBenchmarkSuiteIfNoRuns,
    deleteBenchmarkSuiteIfNoRuns,
    listBenchmarkRunsForSuite,
    getBenchmarkRun,
    listAttemptsForRun,
    listAttemptSummariesForRun,
  } from "./benchmark-repository";
  import {
    BENCHMARK_MAX_TARGETS,
    BENCHMARK_MAX_ATTEMPTS,
    benchmarkAttemptCount,
    isBenchmarkSuite,
    type BenchmarkSuite,
    type BenchmarkTarget,
  } from "./benchmark-suite";
  import { applyTargetAlias, draftFromSuite, buildSuiteFromDraft, type SuiteDraft } from "./benchmark-draft";
  import { buildProgressMatrix, isRunInterrupted, isRunResumable, type AttemptSummary } from "./benchmark-progress";
  import { buildBenchmarkExport } from "./benchmark-export";
  import type { BenchmarkRun } from "./benchmark-run";

  export let availableModels: ModelInfo[] = [];
  /** The run id the parent is actually executing right now, or null. Used only to reflect
   * status here — lifecycle state (start/stop/resume) itself lives in the parent so a run
   * survives navigating away from this view. */
  export let activeRunId: string | null = null;
  /** True from the moment start/resume is requested until pin restore finishes. */
  export let runInFlight: boolean = false;
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
  let runsForSelectedSuite: BenchmarkRun[] = [];
  let runCountsBySuite: Record<string, number> = {};

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
  let pollHandle: ReturnType<typeof setInterval> | null = null;
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

  async function refreshSuites() {
    const generation = ++suitesGeneration;
    const res = await listBenchmarkSuites();
    if (generation !== suitesGeneration) return;
    if (!res.ok) {
      loadError = res.error || "Could not load benchmark suites";
      return;
    }
    const nextSuites = (res.value ?? []).sort((a, b) => b.createdAt - a.createdAt);
    const counts: Record<string, number> = {};
    for (const suite of nextSuites) {
      const runsRes = await listBenchmarkRunsForSuite(suite.id);
      if (generation !== suitesGeneration) return;
      if (!runsRes.ok) {
        loadError = runsRes.error || `Could not read runs for suite "${suite.id}"`;
        return;
      }
      counts[suite.id] = (runsRes.value ?? []).length;
    }
    if (generation !== suitesGeneration) return;
    suites = nextSuites;
    loadError = "";
    runCountsBySuite = counts;
  }

  async function refreshRunsForSelectedSuite(id: string) {
    const generation = ++runsRefreshGeneration;
    const res = await listBenchmarkRunsForSuite(id);
    if (destroyed || generation !== runsRefreshGeneration || selectedSuiteId !== id) return;
    if (!res.ok) {
      loadError = res.error || `Could not read runs for suite "${id}"`;
      return;
    }
    runsForSelectedSuite = (res.value ?? []).sort((a, b) => b.createdAt - a.createdAt);
    runCountsBySuite = { ...runCountsBySuite, [id]: runsForSelectedSuite.length };
    loadError = "";
  }

  async function selectSuite(id: string) {
    selectedSuiteId = id;
    selectedRunId = null;
    selectedRun = null;
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
  function startCreateSuite() {
    if (editingBusy || suiteBusy) return;
    editingDraft = newSuiteDraft();
    editingErrors = [];
  }

  async function startEditSuite(suite: BenchmarkSuite) {
    if (editingBusy || suiteBusy) return;
    // Editing is restricted to suites with no runs yet — a suite with runs already has attempts
    // recorded against its frozen snapshot, and silently changing the live suite underneath
    // that history would be misleading even though runs themselves are immutable.
    if ((runCountsBySuite[suite.id] ?? 0) > 0) {
      loadError = "This suite has runs and can no longer be edited. Duplicate it to make changes.";
      return;
    }
    editingDraft = draftFromSuite(suite);
    editingErrors = [];
  }

  function cancelEditSuite() {
    if (editingBusy || suiteBusy) return;
    editingDraft = null;
    editingErrors = [];
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
    return availableModels.find((m) => m.alias === alias)?.variants ?? [];
  }

  function updateTargetAlias(index: number, alias: string) {
    if (!editingDraft) return;
    const targets: BenchmarkTarget[] = [...editingDraft.targets];
    const variantIds = variantsForAlias(alias).map((v) => v.id);
    targets[index] = applyTargetAlias(targets[index], alias, variantIds);
    editingDraft.targets = targets;
  }

  function updateTargetVariant(index: number, variantId: string | null) {
    if (!editingDraft) return;
    const targets: BenchmarkTarget[] = [...editingDraft.targets];
    targets[index] = { ...targets[index], variantId };
    editingDraft.targets = targets;
  }

  $: draftAttemptEstimate = editingDraft
    ? (() => {
        try {
          const jsonl = editingDraft.casesJsonl.split(/\r?\n/).filter((l) => l.trim()).length;
          return benchmarkAttemptCount({
            targets: editingDraft.targets,
            cases: new Array(jsonl).fill(0),
            warmupCount: editingDraft.warmupCount,
            repeatCount: editingDraft.repeatCount,
          });
        } catch {
          return null;
        }
      })()
    : null;

  async function saveSuite() {
    if (!editingDraft || suiteBusy) return;
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
    if (suiteBusy || editingBusy) return;
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
    if (pollHandle !== null) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
  }

  async function refreshSelectedRun() {
    const runId = selectedRunId;
    if (!runId) return;
    const generation = ++refreshGeneration;
    const runRes = await getBenchmarkRun(runId);
    if (generation !== refreshGeneration || selectedRunId !== runId) return;
    if (runRes.ok) {
      selectedRun = runRes.value ?? null;
      pollError = "";
    } else {
      // A transient storage read failure must never be treated as "nothing changed" — the run
      // could have finished, stopped, or crashed in the same window, and silently keeping the
      // last-known snapshot would show a stale "running" status (and Stop button) forever with
      // no indication anything is wrong. Surface it; the next poll tick will clear it on success.
      pollError = `Could not refresh run status: ${runRes.error}`;
    }
    const summariesRes = await listAttemptSummariesForRun(runId);
    if (generation !== refreshGeneration || selectedRunId !== runId) return;
    if (summariesRes.ok) {
      selectedRunAttempts = summariesRes.value ?? [];
    } else {
      pollError = `Could not refresh run attempts: ${summariesRes.error}`;
    }
    if (!selectedRun || selectedRun.id !== activeRunId || selectedRun.status !== "running") {
      // Refresh the suite's run list whenever the open detail is not the live running run —
      // including the first openRun() after a fast start that already finished, when no
      // interval was ever installed (`wasPolling` would miss that).
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
      pollHandle = setInterval(() => { void refreshSelectedRun(); }, 1500);
    }
  }

  $: progressMatrix = selectedRun ? buildProgressMatrix(selectedRun.suite, selectedRunAttempts) : [];
  $: selectedRunIsActive = !!selectedRun && selectedRun.id === activeRunId;

  async function handleStart(suite: BenchmarkSuite) {
    lifecycleBusy = true;
    lifecycleError = "";
    try {
      const outcome = await onStart(suite);
      if (destroyed) return;
      if (!outcome.ok) {
        lifecycleError = outcome.error;
        return;
      }
      await selectSuite(suite.id);
      if (destroyed) return;
      await openRun(outcome.runId);
    } finally {
      lifecycleBusy = false;
    }
  }

  function handleStop() {
    onStop();
  }

  async function handleResume(runId: string) {
    lifecycleBusy = true;
    lifecycleError = "";
    try {
      const outcome = await onResume(runId);
      if (destroyed) return;
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
    const runRes = await getBenchmarkRun(runId);
    const attemptsRes = await listAttemptsForRun(runId);
    if (destroyed) return;
    if (!runRes.ok || !runRes.value || !attemptsRes.ok) {
      // A slow export racing the user navigating to a different run/suite must not attribute
      // its failure to whatever is now selected — only surface the error while this export's
      // run is still the one on screen; a successful export still downloads regardless.
      if (selectedRunId === runId) lifecycleError = "Could not build export";
      return;
    }
    const payload = buildBenchmarkExport(runRes.value, attemptsRes.value ?? []);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `benchmark-${runId}.json`;
    a.click();
    URL.revokeObjectURL(url);
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
    <button type="button" class="secondary small" onclick={startCreateSuite} disabled={editingBusy || suiteBusy}>New suite</button>
  </div>

  {#if loadError}
    <div class="warning-banner">{loadError}</div>
  {/if}

  {#if runError}
    <div class="warning-banner">{runError}</div>
  {/if}

  {#if editingDraft}
    <div class="benchmark-editor">
      <h3>{editingDraft.id ? "Edit suite" : "New suite"}</h3>
      {#if editingErrors.length}
        <ul class="benchmark-errors">
          {#each editingErrors as err}<li>{err}</li>{/each}
        </ul>
      {/if}
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
              {#each availableModels as m (m.alias)}
                <option value={m.alias}>{m.alias}</option>
              {/each}
            </select>
            <select
              value={target.variantId ?? ""}
              aria-label={`Target ${i + 1} variant`}
              onchange={(e) => updateTargetVariant(i, e.currentTarget.value || null)}
            >
              <option value="">Default variant</option>
              {#each variantsForAlias(target.alias) as v (v.id)}
                <option value={v.id}>{v.id}</option>
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

      <div class="benchmark-editor-actions">
        <button type="button" class="primary" disabled={editingBusy || suiteBusy} onclick={saveSuite}>
          {editingBusy ? "Saving…" : "Save suite"}
        </button>
        <button type="button" class="secondary" disabled={editingBusy || suiteBusy} onclick={cancelEditSuite}>Cancel</button>
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
          <button type="button" class="benchmark-suite-select" onclick={() => selectSuite(suite.id)}>
            <strong>{suite.name}</strong>
            <span class="muted small">{suite.targets.length} target(s) · {suite.cases.length} case(s) · {runCountsBySuite[suite.id] ?? 0} run(s)</span>
          </button>
          <button type="button" class="tiny" disabled={editingBusy || suiteBusy} onclick={() => startEditSuite(suite)}>Edit</button>
          <button type="button" class="tiny danger-btn" disabled={lifecycleBusy || runInFlight || editingBusy || suiteBusy} onclick={() => removeSuite(suite)}>Delete</button>
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
              disabled={lifecycleBusy || !!activeRunId || runInFlight || !isBenchmarkSuite(suite)}
              onclick={() => handleStart(suite)}
            >
              {lifecycleBusy ? "Starting…" : "Start run"}
            </button>
          </div>
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
                <button type="button" class="benchmark-run-select" onclick={() => openRun(run.id)}>
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
                  <button type="button" class="primary small" disabled={lifecycleBusy || !!activeRunId || runInFlight} onclick={() => handleResume(currentRun.id)}>
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
                    {target.counts.uncertain} uncertain · {target.counts.pending} pending
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
  .benchmark-errors {
    color: var(--danger, #c0392b);
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
  .benchmark-cell.uncertain { background: var(--warning, #f39c12); }
  .benchmark-cell.pending { background: var(--muted, #ccc); }
</style>
