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
  import type { BenchmarkSuite, BenchmarkTarget } from "./benchmark-suite";
  import {
    BENCHMARK_MAX_TARGETS,
    benchmarkAttemptCount,
    BENCHMARK_MAX_ATTEMPTS,
  } from "./benchmark-suite";
  import { draftFromSuite, buildSuiteFromDraft, type SuiteDraft } from "./benchmark-draft";
  import { buildProgressMatrix, isRunInterrupted, type AttemptSummary } from "./benchmark-progress";
  import { buildBenchmarkExport } from "./benchmark-export";
  import type { BenchmarkRun } from "./benchmark-run";

  export let availableModels: ModelInfo[] = [];
  /** The run id the parent is actually executing right now, or null. Used only to reflect
   * status here — lifecycle state (start/stop/resume) itself lives in the parent so a run
   * survives navigating away from this view. */
  export let activeRunId: string | null = null;
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

  let selectedRunId: string | null = null;
  let selectedRun: BenchmarkRun | null = null;
  let selectedRunAttempts: AttemptSummary[] = [];
  let lifecycleBusy = false;
  let lifecycleError = "";
  let pollHandle: ReturnType<typeof setInterval> | null = null;

  async function refreshSuites() {
    const res = await listBenchmarkSuites();
    if (!res.ok) {
      loadError = res.error || "Could not load benchmark suites";
      return;
    }
    suites = (res.value ?? []).sort((a, b) => b.createdAt - a.createdAt);
    loadError = "";
    const counts: Record<string, number> = {};
    for (const suite of suites) {
      const runsRes = await listBenchmarkRunsForSuite(suite.id);
      counts[suite.id] = runsRes.ok ? (runsRes.value ?? []).length : 0;
    }
    runCountsBySuite = counts;
  }

  async function selectSuite(id: string) {
    selectedSuiteId = id;
    selectedRunId = null;
    selectedRun = null;
    stopPolling();
    const res = await listBenchmarkRunsForSuite(id);
    runsForSelectedSuite = res.ok ? (res.value ?? []).sort((a, b) => b.createdAt - a.createdAt) : [];
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

  function startCreateSuite() {
    editingDraft = newSuiteDraft();
    editingErrors = [];
  }

  async function startEditSuite(suite: BenchmarkSuite) {
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

  function updateTargetAlias(index: number, alias: string) {
    if (!editingDraft) return;
    const targets: BenchmarkTarget[] = [...editingDraft.targets];
    targets[index] = { ...targets[index], alias };
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
    if (!editingDraft) return;
    editingBusy = true;
    editingErrors = [];
    try {
      const result = buildSuiteFromDraft(editingDraft);
      if (!result.ok || !result.value) {
        editingErrors = result.errors;
        return;
      }
      const saved = await putBenchmarkSuiteIfNoRuns(result.value);
      if (!saved.ok) {
        editingErrors = [saved.error || "Could not save suite"];
        return;
      }
      editingDraft = null;
      await refreshSuites();
    } finally {
      editingBusy = false;
    }
  }

  async function removeSuite(suite: BenchmarkSuite) {
    // `runCountsBySuite` is only a UI hint (last refresh) — the actual guard against deleting a
    // suite that has gained a run since then lives inside `deleteBenchmarkSuiteIfNoRuns`, which
    // rechecks atomically in the same transaction as the delete.
    const res = await deleteBenchmarkSuiteIfNoRuns(suite.id);
    if (!res.ok) {
      loadError = res.error || "Could not delete suite";
      return;
    }
    if (selectedSuiteId === suite.id) {
      selectedSuiteId = null;
      runsForSelectedSuite = [];
    }
    await refreshSuites();
  }

  function stopPolling() {
    if (pollHandle !== null) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
  }

  async function refreshSelectedRun() {
    if (!selectedRunId) return;
    const runRes = await getBenchmarkRun(selectedRunId);
    if (runRes.ok) selectedRun = runRes.value ?? null;
    const summariesRes = await listAttemptSummariesForRun(selectedRunId);
    if (summariesRes.ok) selectedRunAttempts = summariesRes.value ?? [];
  }

  async function openRun(runId: string) {
    selectedRunId = runId;
    lifecycleError = "";
    stopPolling();
    await refreshSelectedRun();
    // Throttled polling, not per-keystroke/per-render: a live progress matrix reads a lightweight
    // projection (`listAttemptSummariesForRun`), but polling it on every tick would still be
    // wasteful for a run with hundreds of attempts.
    pollHandle = setInterval(refreshSelectedRun, 1500);
  }

  $: progressMatrix = selectedRun ? buildProgressMatrix(selectedRun.suite, selectedRunAttempts) : [];
  $: selectedRunIsActive = !!selectedRun && selectedRun.id === activeRunId;

  async function handleStart(suite: BenchmarkSuite) {
    lifecycleBusy = true;
    lifecycleError = "";
    try {
      const outcome = await onStart(suite);
      if (!outcome.ok) {
        lifecycleError = outcome.error;
        return;
      }
      await selectSuite(suite.id);
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
    if (!runRes.ok || !runRes.value || !attemptsRes.ok) {
      lifecycleError = "Could not build export";
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
    stopPolling();
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
    <button type="button" class="secondary small" onclick={startCreateSuite}>New suite</button>
  </div>

  {#if loadError}
    <div class="warning-banner">{loadError}</div>
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
            <select value={target.alias} onchange={(e) => updateTargetAlias(i, e.currentTarget.value)}>
              {#each availableModels as m (m.alias)}
                <option value={m.alias}>{m.alias}</option>
              {/each}
            </select>
            <button type="button" class="tiny danger-btn" onclick={() => removeTarget(i)}>Remove</button>
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
        <button type="button" class="primary" disabled={editingBusy} onclick={saveSuite}>
          {editingBusy ? "Saving…" : "Save suite"}
        </button>
        <button type="button" class="secondary" onclick={cancelEditSuite}>Cancel</button>
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
          <button type="button" class="tiny" onclick={() => startEditSuite(suite)}>Edit</button>
          <button type="button" class="tiny danger-btn" onclick={() => removeSuite(suite)}>Delete</button>
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
              disabled={lifecycleBusy || !!activeRunId}
              onclick={() => handleStart(suite)}
            >
              {lifecycleBusy ? "Starting…" : "Start run"}
            </button>
          </div>
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
                  <span class="badge">{isRunInterrupted(run) ? "interrupted" : run.status}</span>
                  {#if run.id === activeRunId}<span class="badge">active</span>{/if}
                </button>
              </li>
            {/each}
          </ul>

          {#if selectedRun}
            {@const currentRun = selectedRun}
            <div class="benchmark-run-detail">
              <div class="benchmark-run-actions">
                {#if selectedRunIsActive}
                  <button type="button" class="secondary small" onclick={handleStop}>Stop</button>
                  <p class="muted small">
                    Stop prevents further dispatches; a model already asked to respond may still
                    finish. Flint only records a result if it durably receives and saves one.
                  </p>
                {:else if isRunInterrupted(currentRun)}
                  <button type="button" class="primary small" disabled={lifecycleBusy || !!activeRunId} onclick={() => handleResume(currentRun.id)}>
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
                        title="{pos.phase} {pos.caseIndex ?? ''} state={pos.state}"
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
