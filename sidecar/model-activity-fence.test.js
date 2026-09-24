import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createModelActivityFence } from './model-activity-fence.js';

/** A pool of `alias → resident variant id` with the sidecar's name resolution rules. */
function createLedger({ index = {} } = {}) {
  const pool = new Map();
  const residentAliasFor = (name) => {
    const wanted = String(name || '').trim().toLowerCase();
    if (!wanted) return null;
    for (const [alias, variantId] of pool) {
      if (alias.toLowerCase() === wanted) return alias;
      const id = variantId.toLowerCase();
      if (id === wanted || id.split(':')[0] === wanted) return alias;
    }
    return null;
  };
  const gate = createModelActivityFence({
    residentAliasFor,
    catalogAliasFor: (name) => index[name] ?? null,
  });
  return { gate, pool };
}

describe('model activity fence', () => {
  it('requires both resolution callbacks', () => {
    expect(() => createModelActivityFence({ residentAliasFor: () => null })).toThrow(TypeError);
    expect(() => createModelActivityFence({ catalogAliasFor: () => null })).toThrow(TypeError);
  });

  it('atomically excludes new activity for an acquired alias', () => {
    const { gate } = createLedger();

    const release = gate.tryAcquire('model-a');
    expect(release).toBeTypeOf('function');
    expect(gate.allows('model-a')).toBe(false);
    expect(gate.start('model-a')).toBe(false);
    expect(gate.inFlightFor('model-a')).toBe(0);
    expect(gate.tryAcquire('model-a')).toBeNull();

    release();
    release();
    expect(gate.allows('model-a')).toBe(true);
    expect(gate.start('model-a')).toBe(true);
  });

  it('refuses a fence while a request named for the alias is in flight', () => {
    const { gate } = createLedger();

    expect(gate.start('model-a')).toBe(true);
    expect(gate.tryAcquire('model-a')).toBeNull();
    gate.end('model-a');
    expect(gate.tryAcquire('model-a')).toBeTypeOf('function');
  });

  it('counts requests the pool resolves to the resident build', () => {
    const { gate, pool } = createLedger();
    pool.set('model-a', 'model-a-cpu:1');

    gate.start('model-a-cpu:1');
    gate.start('model-a-cpu');
    gate.start('MODEL-A');
    expect(gate.inFlightFor('model-a')).toBe(3);
    expect(gate.tryAcquire('model-a')).toBeNull();
  });

  it('does not count a request for another build of the alias against the resident one', () => {
    // The request that asks for a different variant is the one that wants the switch; counting
    // it as work on the build it replaces refuses every gateway variant switch.
    const { gate, pool } = createLedger({ index: { 'model-a-gpu:1': 'model-a' } });
    pool.set('model-a', 'model-a-cpu:1');

    expect(gate.start('model-a-gpu:1')).toBe(true);
    expect(gate.inFlightFor('model-a')).toBe(0);

    pool.set('model-a', 'model-a-gpu:1');
    expect(gate.inFlightFor('model-a')).toBe(1);
  });

  it('releases the booking a request started under even after the pool changes', () => {
    // An autoloading variant request and an alias request overlap. The variant request ends
    // after its model became resident; it must release its own booking, not the alias one.
    const { gate, pool } = createLedger();

    gate.start('model-a-cpu:1');
    gate.start('model-a');
    pool.set('model-a', 'model-a-cpu:1');
    gate.end('model-a-cpu:1');

    expect(gate.inFlightFor('model-a')).toBe(1);
    gate.end('model-a');
    expect(gate.inFlightFor('model-a')).toBe(0);
    expect(gate.tryAcquire('model-a')).toBeTypeOf('function');
  });

  it('admits unrelated unresolved models while another alias is fenced', () => {
    const { gate } = createLedger();

    const release = gate.tryAcquire('model-a');
    expect(gate.allows('unknown-variant:1')).toBe(true);
    expect(gate.start('unknown-variant:1')).toBe(true);
    expect(gate.inFlightFor('model-a')).toBe(0);
    release();
  });

  it('denies names the pool or catalog resolves to a fenced alias', () => {
    const { gate, pool } = createLedger({ index: { 'model-a-gpu:1': 'model-a' } });
    pool.set('model-a', 'model-a-cpu:1');

    const release = gate.tryAcquire('Model-A');
    expect(gate.allows('model-a-cpu')).toBe(false);
    expect(gate.allows('model-a-gpu:1')).toBe(false);
    expect(gate.allows(' model-a ')).toBe(false);
    release();
    expect(gate.allows('model-a-gpu:1')).toBe(true);
  });

  it('denies the fenced alias by name while it is neither resident nor indexed', () => {
    const { gate } = createLedger();

    const release = gate.tryAcquire('model-a');
    expect(gate.start('MODEL-A')).toBe(false);
    release();
  });

  it('ignores empty names and unmatched ends', () => {
    const { gate } = createLedger();

    expect(gate.start('')).toBe(false);
    expect(gate.start(undefined)).toBe(false);
    expect(gate.inFlightFor('')).toBe(0);
    gate.end('never-started');
    gate.start('model-a');
    gate.end('model-a');
    gate.end('model-a');
    gate.start('model-a');
    expect(gate.inFlightFor('model-a')).toBe(1);
    expect(() => gate.tryAcquire('  ')).toThrow(TypeError);
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
