import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(process.cwd(), 'src', 'lib', 'BenchmarkPreview.svelte'),
  'utf8',
);

describe('benchmark editor wiring', () => {
  it('preserves raw generation-setting text until suite validation', () => {
    const setterStart = source.indexOf('function setDraftNumber(');
    const setterEnd = source.indexOf('async function importCasesFile', setterStart);
    expect(setterStart).toBeGreaterThan(-1);
    expect(setterEnd).toBeGreaterThan(setterStart);
    const setter = source.slice(setterStart, setterEnd);
    expect(setter).toContain('[field]: raw');
    expect(setter).not.toContain('optionalDraftNumber');

    const temperatureStart = source.indexOf('id="benchmark-temperature"');
    const maxTokensStart = source.indexOf('Max tokens', temperatureStart);
    expect(temperatureStart).toBeGreaterThan(-1);
    expect(maxTokensStart).toBeGreaterThan(temperatureStart);
    const temperatureControl = source.slice(temperatureStart, maxTokensStart);
    expect(temperatureControl).toContain('type="range"');
    expect(temperatureControl).toContain('min={BENCHMARK_MIN_TEMPERATURE}');
    expect(temperatureControl).toContain('max={BENCHMARK_MAX_TEMPERATURE}');
    expect(temperatureControl).toContain('step={BENCHMARK_TEMPERATURE_STEP}');
    expect(temperatureControl).toContain('>Use runtime default</button>');
    expect(source).toContain('max={BENCHMARK_MAX_REPEAT_COUNT}');
    expect(source).toContain('min={BENCHMARK_MIN_REPEAT_COUNT}');
    expect(source).toContain('maxTokens: BENCHMARK_DEFAULT_MAX_TOKENS');
    expect(source).toContain('A new suite starts at {BENCHMARK_DEFAULT_MAX_TOKENS} max tokens.');
  });

  it('paints suite and run titles with the theme foreground', () => {
    const start = source.indexOf('.benchmark-suite-select, .benchmark-run-select');
    const end = source.indexOf('}', start);
    expect(start).toBeGreaterThan(-1);
    const rule = source.slice(start, end);
    expect(rule).toContain('background: none');
    expect(rule).toContain('color: var(--fg, inherit)');
  });

  it('uses runtime-selected consistently for alias-only benchmark targets', () => {
    expect(source).toContain('<option value="">Runtime-selected variant</option>');
  });

  it('does not replace an open unsaved draft', () => {
    for (const functionName of ['startCreateSuite', 'startDuplicateSuite', 'startEditSuite']) {
      const start = source.indexOf(`function ${functionName}(`);
      const end = source.indexOf('\n  }', start);
      expect(start, `${functionName} marker not found`).toBeGreaterThan(-1);
      expect(source.slice(start, end)).toContain(
        'if (editorBusy || lifecycleBusy || editingDraft) return;',
      );
    }
    expect(source).toMatch(
      /label="New suite"[\s\S]*?disabled=\{editorBusy \|\| lifecycleBusy \|\| !!editingDraft\}/,
    );
    expect(source).toContain('name="plus"');
    expect(source).toContain('name="pencil"');
    expect(source).toContain('name="trash"');
    expect(source).toContain('label="Edit"');
    expect(source).toContain('label="Duplicate"');
    expect(source).toContain('label="Delete"');
    expect(source).toContain('This cannot be undone.');
    expect(source).toContain('deleteBenchmarkSuiteWithHistory');
    const removeStart = source.indexOf('async function removeSuite(');
    const removeEnd = source.indexOf('\n  function stopPolling(', removeStart);
    const removeSuite = source.slice(removeStart, removeEnd);
    expect(source).toContain('confirm as confirmDialog');
    expect(source).toContain('from "@tauri-apps/plugin-dialog"');
    expect(removeSuite).toContain('await confirmDialog(');
    expect(removeSuite.indexOf('suiteDeletePending = true')).toBeGreaterThan(-1);
    expect(removeSuite.indexOf('suiteDeletePending = true')).toBeLessThan(removeSuite.indexOf('await confirmDialog('));
    expect(removeSuite).toContain('suiteDeletePending = false');
    expect(removeSuite).toContain('deleteBenchmarkSuiteWithHistory(suite.id, activeRunId)');
    expect(removeSuite).not.toContain('globalThis.confirm(');
    expect(source).toContain('if (runBusy || suiteDeletePending) return');
    expect(source).toContain('$: runBusy = lifecycleBusy || runInFlight || suiteDeletePending');
    expect(source).toContain('function casesJsonlListError');
    expect(source).not.toContain('isStaleCasesJsonlMessage');
    expect(source).not.toContain('Suites with runs cannot be deleted.');
    expect(source).not.toMatch(/>New suite<\/button>/);
    expect(source).not.toMatch(/>Edit<\/button>/);
    expect(source).toMatch(
      /disabled=\{editorBusy \|\| lifecycleBusy \|\| !!editingDraft\}[\s\S]*?onclick=\{\(\) => startDuplicateSuite\(suite\)\}/,
    );
    expect(source).toMatch(
      /disabled=\{editorBusy \|\| lifecycleBusy \|\| !!editingDraft \|\| suiteHasStoredRuns\(suite\.id\)\}/,
    );
    expect(source).toContain('Save or cancel this draft before creating, editing, or duplicating another suite.');
    expect(source.match(/Save or cancel the open draft first\./g)).toHaveLength(4);
    expect(source).toContain(
      'Locked after a run, on purpose. Duplicate this suite to modify it or to run it again with changes.',
    );
    const tip = source.indexOf('class="benchmark-action-tip"');
    const editButton = source.indexOf('label="Edit"');
    expect(tip).toBeGreaterThan(-1);
    expect(tip).toBeLessThan(editButton);
    expect(source).toContain('.benchmark-action-tip :global(button:disabled)');
    expect(source).toContain('pointer-events: none');
  });

  it('edits tags as a JSON array so commas remain part of a tag', () => {
    expect(source).toContain('Tags (JSON array)');
    expect(source).toContain('bind:value={row.tagsJson}');
    expect(source).toContain(`placeholder='["math","easy"]'`);
    expect(source).toContain('{@const tagsError = tagsJsonError(row.tagsJson)}');
    expect(source).not.toContain('Tags (comma-separated)');
  });

  it('uses a textarea so multiline expected answers round-trip', () => {
    expect(source).toMatch(
      /Expected \(stored, not scored\)[\s\S]*?<textarea rows="2" bind:value=\{row\.expected\}/,
    );
    expect(source).not.toMatch(
      /Expected \(stored, not scored\)[\s\S]*?<input type="text" bind:value=\{row\.expected\}/,
    );
  });

  it('collapses the suites pane with the playground panel control', () => {
    const collapse = readFileSync(join(process.cwd(), 'src', 'lib', 'PanelCollapseButton.svelte'), 'utf8');
    expect(collapse).toContain('M9.5 5.5V18.5');
    expect(source).toContain('<PanelCollapseButton');
    expect(source).toContain('collapseLabel="Collapse suites"');
    expect(source).toContain('expandLabel="Expand suites"');
    expect(source).toContain('class:suites-collapsed={suitesCollapsed}');
    const chats = readFileSync(join(process.cwd(), 'src', 'lib', 'ConversationSidebar.svelte'), 'utf8');
    expect(chats).toContain('<PanelCollapseButton');
    expect(chats).toContain('name="plus"');
    expect(chats).toContain('label="New conversation"');
    expect(chats).toContain('name="trash"');
    expect(chats).toContain('label="Delete conversation"');
    expect(chats).toContain('name="download"');
    expect(chats).toContain('label="Export conversations"');
    expect(chats).toContain('title={exportTip}');
    expect(chats).not.toContain('>Export</button>');
  });

  it('collapses the suite definition and separates targets from cases', () => {
    expect(source).toContain('<details class="benchmark-definition" open>');
    expect(source).toContain('<h4>Targets</h4>');
    expect(source).toContain('<h4>Cases</h4>');
    expect(source).toContain('<dt>Warmups</dt>');
    expect(source).toContain('<dt>Repeats</dt>');
    expect(source).toContain('<dt>Temperature</dt>');
    expect(source).toContain('<dt>Max tokens</dt>');
    expect(source).toContain('class="benchmark-definition-table"');
    expect(source).toContain('class="benchmark-case-row"');
    expect(source).not.toContain('Warmups {definition.warmupCount} · Repeats');
  });

  it('keeps start and stop on one header control and formats stored responses', () => {
    expect(source).toContain('name={lifecycleBusy ? "loader" : "play"}');
    expect(source).toContain('name="stop"');
    expect(source).toContain('aria-label="Stop run"');
    expect(source).toContain('aria-label="Start run"');
    expect(source).toContain('name={expandedResultId === row.attemptId ? "chevron-up" : "chevron-down"}');
    expect(source).toContain('title="Copy response"');
    expect(source).toContain('<MessageRenderer content={presentBenchmarkResponse(');
    expect(source).not.toContain('<MessageRenderer content={row.responseText}');
    expect(source).toContain('<pre class="benchmark-response">{row.responseText}</pre>');
    expect(source).toContain('copyBenchmarkResponse(row.responseText ?? "")');
    expect(source).toContain('class="badge badge-live"');
    expect(source).toContain('class="benchmark-run-toolbar"');
  });

  it('describes unavailable medians without assuming timing was never started', () => {
    expect(source).toContain(
      'median response time unavailable because a succeeded attempt has no usable timing',
    );
    expect(source).not.toContain(
      'median response time unavailable because a succeeded attempt has no start time',
    );
  });

  it('explains when duplicating a legacy suite removes repeated aliases', () => {
    expect(source).toContain('const removedTargets = suite.targets.length - draft.targets.length;');
    expect(source).toContain('Benchmark targets are keyed by alias.');
    expect(source).toContain('{#each editingNotices as notice}');
  });

  it('takes the import lock synchronously instead of relying on reactive editorBusy', () => {
    const start = source.indexOf('async function importCasesFile(');
    const end = source.indexOf('\n  function startCreateSuite', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const importCasesFile = source.slice(start, end);
    expect(importCasesFile).toContain(
      'if (!(input instanceof HTMLInputElement) || !editingDraft || editingBusy || suiteBusy || casesImporting) return;',
    );
    expect(importCasesFile.indexOf('casesImporting = true;')).toBeLessThan(
      importCasesFile.indexOf('jsonlImportCanFitCharacterLimit(file.size)'),
    );
    expect(importCasesFile).toContain('editingDraft.casesJsonl = text;');
    expect(importCasesFile).toContain('if (!destroyed && editingDraft === draftAtImport)');
    expect(importCasesFile).toContain('editingErrors = ["Could not read JSONL file"];');
  });

  it('loads results when a run stops being active while it is opened', () => {
    const start = source.indexOf('async function openRun(');
    const end = source.indexOf('\n  $: progressMatrix', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const openRun = source.slice(start, end);
    expect(openRun).toContain('const liveAtOpen = runId === activeRunId;');
    expect(openRun).toContain('if (!liveAtOpen) void loadRunResults(runId);');
    expect(openRun).toContain('if (!liveAtOpen) return;');
    expect(openRun.match(/void loadRunResults\(runId\);/g)).toHaveLength(2);
  });

  it('coalesces overlapping full-result reads for the same run', () => {
    expect(source).toContain('let resultLoadRunId: string | null = null;');
    expect(source).toContain('let resultLoadPromise: Promise<void> | null = null;');
    expect(source).toContain('if (resultViewRunId === runId && resultView) return;');
    expect(source).toContain('if (resultLoadRunId === runId && resultLoadPromise)');
    expect(source).toContain('return resultLoadPromise;');
    expect(source).toContain('resultLoadRunId = runId;');
    expect(source).toContain('resultLoadPromise = load;');
    expect(source).toContain('if (resultLoadPromise === load)');

    const clearStart = source.indexOf('function clearRunResults()');
    const clearEnd = source.indexOf('\n  }', clearStart);
    const clear = source.slice(clearStart, clearEnd);
    expect(clear).toContain('resultLoadRunId = null;');
    expect(clear).toContain('resultLoadPromise = null;');
  });

  it('validates JSONL text in the editor', () => {
    expect(source).toContain('casesJsonlError(');
    expect(source).toContain('id="benchmark-jsonl-error"');
    expect(source).toContain('aria-invalid={jsonlFieldError ? "true" : "false"}');
    expect(source).toContain('draftInputErrors(');
    expect(source).toContain('disabled={editorBusy || !!jsonlFieldError || draftHasInputError || attemptEstimateOverCap}');
  });

  it('shows a duplicate id on a read-only messages case', () => {
    const start = source.indexOf('row.kind === "messages"');
    const end = source.indexOf('{:else}', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const messages = source.slice(start, end);
    expect(messages).toContain('rowError?.id');
    expect(messages).toContain('rowError?.other');
  });

  it('keeps the JSONL editor below its help text', () => {
    const helpAt = source.indexOf('class="muted small benchmark-jsonl-help"');
    const editorAt = source.indexOf('class="benchmark-jsonl"');
    expect(helpAt).toBeGreaterThan(-1);
    expect(editorAt).toBeGreaterThan(helpAt);
    const help = source.slice(helpAt, editorAt);
    expect(help).toContain('One case per line');
    expect(help.indexOf('</p>')).toBeGreaterThan(-1);
    expect(help.indexOf('</p>')).toBeLessThan(help.indexOf('<textarea'));
  });

  it('blocks resume while suite deletion is pending', () => {
    expect(source).toContain('$: runBusy = lifecycleBusy || runInFlight || suiteDeletePending');
    const start = source.indexOf('async function handleResume(');
    const end = source.indexOf('await onResume(', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const resume = source.slice(start, end);
    expect(resume).toContain('if (runBusy) return');
    expect(resume).not.toContain('onResume');
  });

  it('preserves same-run historical result ownership when the row is reopened', () => {
    const start = source.indexOf('async function openRun(');
    const end = source.indexOf('\n  $: progressMatrix', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const openRun = source.slice(start, end);
    expect(openRun).toContain(
      'const preserveHistoricalResults = selectedRunId === runId && runId !== activeRunId;',
    );
    expect(openRun).toMatch(
      /if \(!preserveHistoricalResults\) \{[\s\S]*?clearRunResults\(\);[\s\S]*?\}/,
    );
  });
});
