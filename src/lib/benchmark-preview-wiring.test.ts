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

    const temperatureStart = source.indexOf('Temperature');
    const maxTokensStart = source.indexOf('Max tokens', temperatureStart);
    expect(temperatureStart).toBeGreaterThan(-1);
    expect(maxTokensStart).toBeGreaterThan(temperatureStart);
    expect(source.slice(temperatureStart, maxTokensStart)).toContain('type="text"');
    expect(source.slice(temperatureStart, maxTokensStart)).toContain('inputmode="decimal"');
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
      /disabled=\{editorBusy \|\| lifecycleBusy \|\| !!editingDraft\}[\s\S]*?>New suite<\/button>/,
    );
    expect(source).toMatch(
      /disabled=\{editorBusy \|\| lifecycleBusy \|\| !!editingDraft\}[\s\S]*?onclick=\{\(\) => startDuplicateSuite\(suite\)\}/,
    );
    expect(source).toMatch(
      /disabled=\{editorBusy \|\| lifecycleBusy \|\| !!editingDraft \|\| suiteHasStoredRuns\(suite\.id\)\}/,
    );
    expect(source).toContain('Save or cancel this draft before creating, editing, or duplicating another suite.');
    expect(source.match(/Save or cancel the open draft first\./g)).toHaveLength(3);
  });

  it('edits tags as a JSON array so commas remain part of a tag', () => {
    expect(source).toContain('Tags (JSON array)');
    expect(source).toContain('bind:value={row.tagsJson}');
    expect(source).toContain(`placeholder='["math","easy"]'`);
    expect(source).toContain('{@const tagsError = tagsJsonError(row.tagsJson)}');
    expect(source).not.toContain('Tags (comma-separated)');
  });

  it('explains when duplicating a legacy suite removes repeated aliases', () => {
    expect(source).toContain('const removedTargets = suite.targets.length - draft.targets.length;');
    expect(source).toContain('Benchmark targets are keyed by alias.');
    expect(source).toContain('{#each editingNotices as notice}');
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
});
