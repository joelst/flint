// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs, stopSidecar } from './byom-gateway-live.mjs';

afterEach(() => vi.useRealTimers());

function sidecarFixture() {
  let close;
  const sidecar = {
    hasClosed: false,
    exited: new Promise((resolve) => { close = resolve; }),
    send: vi.fn(async () => ({ ok: true, result: { cleanup: 'confirmed' } })),
    child: { kill: vi.fn() },
  };
  return {
    sidecar,
    close: () => { sidecar.hasClosed = true; close({ code: null, signal: 'SIGTERM' }); },
  };
}

describe('BYOM runner cleanup', () => {
  it('does not claim graceful cleanup when the sidecar already closed', async () => {
    const { sidecar } = sidecarFixture();
    sidecar.hasClosed = true;
    await expect(stopSidecar(sidecar)).resolves.toMatchObject({
      error: expect.stringMatching(/closed before.*shutdown/),
      forced: false,
    });
    expect(sidecar.send).not.toHaveBeenCalled();
  });

  it('waits for child close after the shutdown acknowledgement instead of killing immediately', async () => {
    vi.useFakeTimers();
    const { sidecar, close } = sidecarFixture();
    const stopping = stopSidecar(sidecar);
    setTimeout(close, 100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(stopping).resolves.toEqual({ error: null, forced: false });
    expect(sidecar.child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recognizes signal termination only after close, even with no numeric exit code', async () => {
    vi.useFakeTimers();
    const { sidecar, close } = sidecarFixture();
    sidecar.child.kill.mockImplementation(() => { setTimeout(close, 10); return true; });
    const stopping = stopSidecar(sidecar, { graceMs: 20 });
    await vi.advanceTimersByTimeAsync(30);
    await expect(stopping).resolves.toMatchObject({
      error: expect.stringMatching(/forced termination/),
      forced: true,
    });
    expect(sidecar.child.kill).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains the work directory when forced termination cannot be confirmed', async () => {
    vi.useFakeTimers();
    const { sidecar } = sidecarFixture();
    const stopping = stopSidecar(sidecar, { graceMs: 10, forceMs: 20 });
    await vi.advanceTimersByTimeAsync(30);
    await expect(stopping).resolves.toMatchObject({
      error: expect.stringMatching(/did not close.*retained/),
      forced: true,
    });
    expect(sidecar.hasClosed).toBe(false);
  });

  it('keeps a rejected shutdown outcome even after the child closes', async () => {
    const { sidecar, close } = sidecarFixture();
    sidecar.send.mockImplementation(async () => { close(); return { ok: false, error: 'drain failed' }; });
    await expect(stopSidecar(sidecar)).resolves.toMatchObject({
      error: expect.stringMatching(/drain failed/),
      forced: false,
    });
  });

  it.each(['failed', 'timed-out'])('reports %s runtime cleanup even after a graceful child close', async (cleanup) => {
    const { sidecar, close } = sidecarFixture();
    sidecar.send.mockImplementation(async () => {
      close();
      return { ok: true, result: { cleanup, unloadFailures: ['flint-byom-live'] } };
    });
    await expect(stopSidecar(sidecar)).resolves.toMatchObject({
      error: expect.stringMatching(new RegExp(`cleanup.*${cleanup}`)),
      forced: false,
    });
  });
});

describe('BYOM runner copy selection', () => {
  it('requires an explicit copy option and rejects missing model values', () => {
    expect(parseArgs(['--model', 'model']).copy).toBe(false);
    expect(parseArgs(['--copy', '--model', 'model']).copy).toBe(true);
    expect(() => parseArgs(['--model'])).toThrow(/requires a folder/);
    expect(() => parseArgs(['--model', '--copy'])).toThrow(/requires a folder/);
  });
});
