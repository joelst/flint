import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createModelActivityFence } from './model-activity-fence.js';

describe('model activity fence', () => {
  it('atomically excludes new activity for an acquired alias', () => {
    const gate = createModelActivityFence({
      resolveAliases: (name) => [name],
      inFlightFor: () => 0,
    });

    const release = gate.tryAcquire('model-a');
    expect(release).toBeTypeOf('function');
    expect(gate.allows('model-a')).toBe(false);
    expect(gate.tryAcquire('model-a')).toBeNull();

    release();
    expect(gate.allows('model-a')).toBe(true);
  });

  it('refuses a fence while activity is already in flight', () => {
    const gate = createModelActivityFence({
      resolveAliases: (name) => [name],
      inFlightFor: (alias) => alias === 'model-a' ? 1 : 0,
    });

    expect(gate.tryAcquire('model-a')).toBeNull();
    expect(gate.allows('model-a')).toBe(true);
  });

  it('blocks variant and fallback names that resolve to a fenced alias', () => {
    const gate = createModelActivityFence({
      resolveAliases: (name) => name === 'variant-a' ? ['model-a', 'variant-a'] : [name],
      inFlightFor: () => 0,
    });

    const release = gate.tryAcquire('model-a');
    expect(gate.allows('variant-a')).toBe(false);
    release();
    expect(gate.allows('variant-a')).toBe(true);
  });

  it('checks in-flight state with the original alias while normalizing fence identity', () => {
    const seen = [];
    const gate = createModelActivityFence({
      resolveAliases: (name) => [name],
      inFlightFor: (alias) => {
        seen.push(alias);
        return alias === 'MyModel' ? 1 : 0;
      },
    });

    expect(gate.tryAcquire('MyModel')).toBeNull();
    expect(seen).toEqual(['MyModel']);
  });

  it('blocks unresolved activity while any destructive fence is active', () => {
    const gate = createModelActivityFence({
      resolveAliases: () => [],
      inFlightFor: () => 0,
    });

    const release = gate.tryAcquire('model-a');
    expect(gate.allows('unknown-variant')).toBe(false);
    release();
    expect(gate.allows('unknown-variant')).toBe(true);
  });

  it('wires fences around destructive paths before request work starts', () => {
    const source = readFileSync(
      join(process.cwd(), 'sidecar', 'foundry-sidecar-main.js'),
      'utf8',
    );
    const unloadStart = source.indexOf("} else if (cmd === 'unload') {");
    const unloadEnd = source.indexOf("} else if (cmd === 'deleteModel') {", unloadStart);
    const unloadFlow = source.slice(unloadStart, unloadEnd);
    const deleteEnd = source.indexOf("} else if (cmd === 'inspectModelFolder') {", unloadEnd);
    const deleteFlow = source.slice(unloadEnd, deleteEnd);
    const sweepStart = source.indexOf('async function runEvictionSweepLocked');
    const sweepEnd = source.indexOf('async function admitModel', sweepStart);
    const sweepFlow = source.slice(sweepStart, sweepEnd);
    const switchStart = source.indexOf('const releaseAdmission = await admitModel');
    const switchEnd = source.indexOf('try {', switchStart);
    const switchFlow = source.slice(switchStart, switchEnd);
    const audioStart = source.indexOf("} else if (cmd === 'transcribeAudio') {");
    const audioEnd = source.indexOf("} else if (cmd === 'poolStatus') {", audioStart);
    const audioFlow = source.slice(audioStart, audioEnd);

    expect(unloadFlow).toContain('withModelActivityFence(alias');
    expect(deleteFlow).toContain('modelActivityFence.tryAcquire(payload.alias)');
    expect(sweepFlow).toContain('withModelActivityFence(');
    expect(switchFlow).toContain('modelActivityFence.tryAcquire(alias)');
    expect(source.indexOf('let releaseReplacementFence = null;'))
      .toBeLessThan(source.indexOf('const releaseAdmission = await admitModel'));
    expect(audioFlow.indexOf("noteActivity(requestedAlias, 'start')"))
      .toBeLessThan(audioFlow.indexOf('await ensureModel(requestedAlias)'));
    expect(audioFlow.indexOf("noteActivity(requestedAlias, 'start')"))
      .toBeLessThan(audioFlow.indexOf('writeFile(tempPath, bytes)'));
  });
});
