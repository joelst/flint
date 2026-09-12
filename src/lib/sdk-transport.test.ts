/**
 * Behavioural tests for the sidecar transport's delivery and settlement guarantees.
 *
 * These drive the real `sdk.ts` against a fake child process. The classification tests in
 * `operation-outcome.test.ts` check what a given outcome is *called*; these check which outcome
 * a given sequence of events actually produces, and — the part classification cannot express —
 * whether a request that has been answered can still reach the child afterwards.
 *
 * The module keeps process state in module scope, so every test re-imports it through
 * `vi.resetModules()` to get a clean transport.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Handles for the fake child.
 *
 * The methods are **stable**: they delegate to whichever child is currently spawned rather than
 * being reassigned when one is. That matters because `obj.method(await x)` looks the property up
 * before the awaited argument resolves, so a rebinding harness would silently capture the
 * pre-spawn no-op and the test would hang rather than fail.
 */
type Harness = {
  /** Lines written by the transport, in order. */
  writes: string[];
  /** Reject the next write instead of resolving it. */
  failNextWrite: (err: string) => void;
  /** Feed a line to the transport's stdout parser. */
  emitStdout: (obj: unknown) => void;
  /** Fire the child's `close` event. */
  emitClose: (data?: unknown) => void;
  /** Fire the child's `error` event. */
  emitError: (err: string) => void;
  /** Resolve the pending `spawn()` call. Only set when spawning is gated. */
  releaseSpawn?: () => void;
  /** True once `spawn()` has been entered, so a test can act during a gated startup. */
  spawnEntered: boolean;
  spawnCount: number;
  killCount: number;
  hangKill: boolean;
};

let harness: Harness;
/** The live child's event hooks, replaced on every spawn; the harness delegates to these. */
/** Module-scoped so it survives the child being replaced. */
let pendingWriteError: string | null = null;
/** When set, `spawn()` waits on this so a test can act while startup is still in flight. */
let gateSpawn = false;
let readyProtocolVersion = 1;
let nativeGeneration = 0;
let nativePhase = 'stopped';
let listenerRegistrationCount = 0;
let rejectListenerRegistration: number | null = null;
let gateNativeWrite = false;
let nativeWriteStarted = false;
let releaseNativeWrite: (() => void) | null = null;
const nativeListeners = new Map<string, Set<(event: { payload: any }) => void>>();

function makeCommand() {
  return {
    async execute() {
      return { code: 0, stdout: 'v22.11.0', stderr: '' };
    },
  };
}

function emitNative(event: string, payload: any) {
  for (const listener of nativeListeners.get(event) ?? []) listener({ payload });
}

function nativeListenerCount() {
  return [...nativeListeners.values()].reduce((total, listeners) => total + listeners.size, 0);
}

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args: any = {}) => {
    if (command === 'runtime_status') {
      return { generation: nativeGeneration, phase: nativePhase };
    }
    if (command === 'runtime_start') {
      harness.spawnEntered = true;
      harness.spawnCount += 1;
      nativeGeneration += 1;
      nativePhase = 'starting';
      const generation = nativeGeneration;
      if (gateSpawn) {
        await new Promise<void>((resolve) => {
          harness.releaseSpawn = resolve;
        });
      }
      queueMicrotask(() =>
        emitNative('flint://runtime-stdout', {
          generation,
          message: { ready: true, protocolVersion: readyProtocolVersion },
        }),
      );
      return { generation };
    }
    if (command === 'runtime_mark_ready') {
      if (args.generation !== nativeGeneration || nativePhase !== 'starting') return false;
      nativePhase = 'ready';
      return true;
    }
    if (command === 'runtime_write') {
      harness.writes.push(`${args.frame}\n`);
      nativeWriteStarted = true;
      if (gateNativeWrite) {
        await new Promise<void>((resolve) => {
          releaseNativeWrite = resolve;
        });
      }
      if (pendingWriteError) {
        const error = pendingWriteError;
        pendingWriteError = null;
        throw new Error(error);
      }
      return;
    }
    if (command === 'runtime_force_stop') {
      harness.killCount += 1;
      if (harness.hangKill) return new Promise(() => {});
      nativePhase = 'shuttingDown';
      return true;
    }
    throw new Error(`unexpected invoke command: ${command}`);
  },
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: async (event: string, listener: (event: { payload: any }) => void) => {
    listenerRegistrationCount += 1;
    if (listenerRegistrationCount === rejectListenerRegistration) {
      throw new Error(`listener ${listenerRegistrationCount} failed`);
    }
    const listeners = nativeListeners.get(event) ?? new Set();
    listeners.add(listener);
    nativeListeners.set(event, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) nativeListeners.delete(event);
    };
  },
}));

vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: {
    create: () => makeCommand(),
    sidecar: () => makeCommand(),
  },
}));
async function loadSdk() {
  vi.resetModules();
  harness = {
    writes: [],
    failNextWrite: (err: string) => {
      pendingWriteError = err;
    },
    emitStdout: (obj) => {
      const message = typeof obj === 'string' ? JSON.parse(obj) : obj;
      emitNative('flint://runtime-stdout', { generation: nativeGeneration, message });
    },
    emitClose: (data) => {
      nativePhase = 'exited';
      emitNative('flint://runtime-exit', {
        generation: nativeGeneration,
        ...(data as any ?? { code: 1 }),
      });
    },
    emitError: (err) => {
      emitNative('flint://runtime-error', { generation: nativeGeneration, text: err });
    },
    spawnEntered: false,
    spawnCount: 0,
    killCount: 0,
    hangKill: false,
  };
  gateSpawn = false;
  readyProtocolVersion = 1;
  nativeGeneration = 0;
  nativePhase = 'stopped';
  listenerRegistrationCount = 0;
  rejectListenerRegistration = null;
  gateNativeWrite = false;
  nativeWriteStarted = false;
  releaseNativeWrite = null;
  pendingWriteError = null;
  nativeListeners.clear();
  return await import('./sdk');
}

/**
 * Let the transport reach its next observable state.
 *
 * Elapsed time is not a synchronization contract, so this drains the microtask queue repeatedly
 * and only falls back to real time for the transport's own 100 ms startup poll. `waitFor` below
 * is preferred wherever there is a condition to wait on.
 */
const settleStartup = () => new Promise((r) => setTimeout(r, 250));

/**
 * Wait until `cond` holds, polling the microtask queue.
 *
 * Bounded, and it reports what it was waiting for — a timeout here is a diagnosis rather than a
 * bare "test timed out after 5000ms".
 */
async function waitFor(what: string, cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Wait until a line for `cmd` has been written, and return its id. */
async function waitForWrite(cmd: string, afterCount = 0): Promise<number> {
  await waitFor(
    `a ${cmd} line to be written`,
    () => harness.writes.filter((w) => w.includes(cmd)).length > afterCount,
  );
  const line = harness.writes.filter((w) => w.includes(cmd))[afterCount];
  return JSON.parse(line).id;
}

async function completeInitialization(
  sdk: Awaited<ReturnType<typeof loadSdk>>,
  logLevel = 'info',
): Promise<void> {
  const initialized = sdk.initializeSDK({ autoStartService: false, logLevel });
  const initId = await waitForWrite('init');
  harness.emitStdout({ id: initId, result: 'initialized' });
  const logId = await waitForWrite('setLogLevel');
  harness.emitStdout({ id: logId, result: {} });
  const listId = await waitForWrite('listModels');
  harness.emitStdout({ id: listId, result: [] });
  const statusId = await waitForWrite('getStatus');
  harness.emitStdout({ id: statusId, result: { serviceRunning: false, endpoint: null } });
  const poolId = await waitForWrite('poolStatus');
  harness.emitStdout({ id: poolId, result: { models: [] } });
  const finalStatusId = await waitForWrite('getStatus', 1);
  harness.emitStdout({ id: finalStatusId, result: { serviceRunning: false, endpoint: null } });
  await expect(initialized).resolves.toBe(true);
}

/** Capture a rejection without triggering an unhandled-rejection warning. */
function capture<T>(p: Promise<T>) {
  const box: { err?: any; done: boolean } = { done: false };
  const tracked = p.then(
    () => {
      box.done = true;
    },
    (e) => {
      box.done = true;
      box.err = e;
    },
  );
  return { box, tracked };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('catalog queries', () => {
  it('propagates a failed STT catalog query instead of returning an empty list', async () => {
    const sdk = await loadSdk();
    const request = capture(sdk.getSTTModels());
    const id = await waitForWrite('getSTTModels');
    harness.emitStdout({ id, error: 'catalog unavailable' });
    await request.tracked;
    expect(request.box.err?.message).toContain('catalog unavailable');
  });
});

describe('initialization', () => {
  it('passes the configured log level through initialization', async () => {
    const sdk = await loadSdk();
    const initialized = sdk.initializeSDK({ autoStartService: false, logLevel: 'debug' });
    const initId = await waitForWrite('init');
    harness.emitStdout({ id: initId, result: 'initialized' });
    const logId = await waitForWrite('setLogLevel');
    const logLine = JSON.parse(harness.writes.find((line) => line.includes('"cmd":"setLogLevel"'))!);
    expect(logLine.level).toBe('debug');
    harness.emitStdout({ id: logId, result: {} });
    const listId = await waitForWrite('listModels');
    harness.emitStdout({ id: listId, result: [] });
    const statusId = await waitForWrite('getStatus');
    harness.emitStdout({ id: statusId, result: { serviceRunning: false, endpoint: null } });
    const poolId = await waitForWrite('poolStatus');
    harness.emitStdout({ id: poolId, result: { models: [] } });
    const finalStatusId = await waitForWrite('getStatus', 1);
    harness.emitStdout({ id: finalStatusId, result: { serviceRunning: false, endpoint: null } });
    await expect(initialized).resolves.toBe(true);
  });
});

describe('settlement revokes permission to dispatch', () => {
  it('publishes independent process and manager readiness', async () => {
    const sdk = await loadSdk();
    const request = capture(sdk.getEps());
    await waitForWrite('getEps');
    let snapshot: any;
    const unsubscribe = sdk.getSDKState().subscribe((state) => {
      snapshot = state;
    });

    expect(snapshot.runtime.process).toBe('ready');
    expect(snapshot.runtime.manager).toBe('uninitialized');
    expect(snapshot.runtime.generation).toBeGreaterThan(0);
    harness.emitClose({ code: 1 });
    await request.tracked;
    expect(snapshot.runtime.process).toBe('crashed');
    expect(snapshot.runtime.manager).toBe('unknown');
    unsubscribe();
  });

  it('rejects a sidecar with an incompatible handshake before sending requests', async () => {
    const sdk = await loadSdk();
    readyProtocolVersion = 999;
    const { box, tracked } = capture(sdk.getEps());
    await tracked;
    expect(box.err).toBeDefined();
    expect(String(box.err.message)).toContain('Unsupported sidecar protocol version');
    expect(harness.writes).toHaveLength(0);
  });

  it('does not claim a failed-start child terminated without a close event', async () => {
    const sdk = await loadSdk();
    readyProtocolVersion = 999;
    const request = capture(sdk.getEps());
    await request.tracked;
    expect(harness.killCount).toBe(1);

    const result = await sdk.quitRuntime({ killTimeoutMs: 10 });
    expect(harness.killCount).toBe(2);
    expect(result.termination).toBe('unconfirmed');
  });

  it('uses close evidence even when a late-spawn kill acknowledgement hangs', async () => {
    const sdk = await loadSdk();
    gateSpawn = true;
    harness.hangKill = true;
    const request = capture(sdk.getEps());
    await waitFor('the send path to reach the gated spawn', () => harness.spawnEntered);

    const quitting = sdk.quitRuntime({ gracefulTimeoutMs: 100, killTimeoutMs: 100 });
    harness.releaseSpawn?.();
    await waitFor('the late-spawn kill request', () => harness.killCount >= 1);
    harness.emitClose({ code: null, signal: 'SIGTERM' });

    await request.tracked;
    await expect(quitting).resolves.toMatchObject({ termination: 'confirmed' });
  });

  it('never writes a request that was drained while the runtime was starting', async () => {
    const sdk = await loadSdk();
    gateSpawn = true;

    const { box, tracked } = capture(sdk.deleteModel({ alias: 'm' } as any));
    await waitFor('the send path to reach the gated spawn', () => harness.spawnEntered);
    expect(harness.writes).toHaveLength(0);

    // The child dies while the request waits. This settles it as never-dispatched.
    harness.emitError('boom');
    await tracked;
    expect(box.done).toBe(true);
    expect(box.err).toBeDefined();
    expect(box.err.certainty).toBe('failed');

    // Now let startup finish. The answered request must not go on to write itself.
    harness.releaseSpawn?.();
    await settleStartup();
    expect(harness.writes.filter((w) => w.includes('deleteModel'))).toHaveLength(0);
  });

  it('does not retain a child that closed before spawn resolved', async () => {
    const sdk = await loadSdk();
    gateSpawn = true;
    const first = capture(sdk.getEps());
    await waitFor('the first spawn to be pending', () => harness.spawnEntered);
    harness.emitClose({ code: 1 });
    harness.releaseSpawn?.();
    await first.tracked;
    expect(first.box.err).toBeDefined();

    gateSpawn = false;
    const retry = sdk.getEps();
    const retryId = await waitForWrite('getEps');
    harness.emitStdout({ id: retryId, result: [] });
    await expect(retry).resolves.toEqual([]);
    expect(harness.spawnCount).toBe(2);
  });

  it('does not adopt a previous generation event while its replacement starts', async () => {
    const sdk = await loadSdk();
    nativeGeneration = 1;
    nativePhase = 'exited';
    gateSpawn = true;

    const request = sdk.getEps();
    await waitFor('the replacement spawn to be pending', () => harness.spawnEntered);
    emitNative('flint://runtime-exit', { generation: 1, code: 1 });
    harness.releaseSpawn?.();

    const requestId = await waitForWrite('getEps');
    harness.emitStdout({ id: requestId, result: [] });
    await expect(request).resolves.toEqual([]);
    expect(harness.spawnCount).toBe(1);
    expect(harness.killCount).toBe(0);
  });

  it('does not let reset authorize a native child whose start was already in flight', async () => {
    const sdk = await loadSdk();
    gateSpawn = true;
    const request = capture(sdk.getEps());
    await waitFor('the native start to be pending', () => harness.spawnEntered);

    sdk.resetSDK();
    await request.tracked;
    harness.releaseSpawn?.();
    await waitFor('the revoked generation to be terminated', () => harness.killCount === 1);
    await settleStartup();
    expect(harness.writes).toHaveLength(0);
  });

  it('cleans up each listener acquired before a later registration fails', async () => {
    const sdk = await loadSdk();
    rejectListenerRegistration = 3;

    const failed = capture(sdk.getEps());
    await failed.tracked;
    expect(String(failed.box.err?.message)).toContain('listener 3 failed');
    expect(nativeListenerCount()).toBe(0);

    rejectListenerRegistration = null;
    const retry = sdk.getEps();
    const requestId = await waitForWrite('getEps');
    harness.emitStdout({ id: requestId, result: [] });
    await expect(retry).resolves.toEqual([]);
    expect(nativeListenerCount()).toBe(4);
  });

  it('removes a reset generation listener set when its close arrives later', async () => {
    const sdk = await loadSdk();
    const request = capture(sdk.getEps());
    await waitForWrite('getEps');
    expect(nativeListenerCount()).toBe(4);

    sdk.resetSDK();
    await request.tracked;
    expect(nativeListenerCount()).toBe(4);
    harness.emitClose({ code: 1 });
    expect(nativeListenerCount()).toBe(0);
  });

  it('does not remove current listeners for an unrelated stale exit', async () => {
    const sdk = await loadSdk();
    const request = sdk.getEps();
    const requestId = await waitForWrite('getEps');
    expect(nativeListenerCount()).toBe(4);

    emitNative('flint://runtime-exit', { generation: 0, code: 1 });
    expect(nativeListenerCount()).toBe(4);
    harness.emitStdout({ id: requestId, result: [] });
    await expect(request).resolves.toEqual([]);
  });

  it('rejects an oversized mutation before native dispatch', async () => {
    const sdk = await loadSdk();
    vi.stubGlobal(
      'TextEncoder',
      class {
        encode() {
          return { byteLength: sdk.NATIVE_RUNTIME_MAX_FRAME_BYTES + 1 };
        }
      },
    );

    const request = capture(sdk.deleteModel({ alias: 'm' } as any));
    await request.tracked;
    expect(request.box.err?.certainty).toBe('failed');
    expect(String(request.box.err?.message)).toContain('transport limit');
    expect(harness.writes).toHaveLength(0);
  });

  it('rechecks authorization inside the ordered native write queue', async () => {
    const sdk = await loadSdk();
    await completeInitialization(sdk);
    gateNativeWrite = true;

    const first = sdk.getEps();
    await waitFor('the first native write to block', () => nativeWriteStarted);
    let secondId = -1;
    const second = capture(
      sdk.chatCompletionStream(
        'm',
        [{ role: 'user', content: 'hi' }],
        () => {},
        undefined,
        (id) => {
          secondId = id;
        },
      ),
    );
    await waitFor('the queued request id', () => secondId > 0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sdk.cancelBeforeDispatch(secondId)).toBe(true);
    await second.tracked;

    gateNativeWrite = false;
    releaseNativeWrite?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.writes.filter((line) => line.includes('chatCompletion'))).toHaveLength(0);
    const firstId = JSON.parse(harness.writes.find((line) => line.includes('"getEps"'))!).id;
    harness.emitStdout({ id: firstId, result: [] });
    await expect(first).resolves.toEqual([]);
  });

  it('rejects writes exceeding queue backpressure before dispatch', async () => {
    const sdk = await loadSdk();
    await completeInitialization(sdk);
    gateNativeWrite = true;

    const first = sdk.getEps();
    await waitFor('the first native write to block', () => nativeWriteStarted);

    const queued: Array<ReturnType<typeof capture>> = [];
    for (let i = 0; i < sdk.MAX_QUEUED_WRITES; i += 1) {
      queued.push(capture(sdk.deleteModel({ alias: `queued-${i}` } as any)));
    }

    const overflow = capture(sdk.deleteModel({ alias: 'overflow' } as any));
    await overflow.tracked;
    expect(overflow.box.err?.cmd).toBe('deleteModel');
    expect(overflow.box.err?.certainty).toBe('failed');
    expect(String(overflow.box.err?.message)).toContain('write queue is full');
    expect(harness.writes.filter((line) => line.includes('overflow'))).toHaveLength(0);

    gateNativeWrite = false;
    releaseNativeWrite?.();
    const firstId = JSON.parse(harness.writes.find((line) => line.includes('"getEps"'))!).id;
    harness.emitStdout({ id: firstId, result: [] });
    await expect(first).resolves.toEqual([]);
    sdk.resetSDK();
    await Promise.all(queued.map((q) => q.tracked));
  });

  it('keeps transport failure sticky even if a ready frame arrives later', async () => {
    const sdk = await loadSdk();
    await completeInitialization(sdk);
    harness.writes.length = 0;

    harness.emitError('stdout framing failed');
    harness.emitStdout({ ready: true, protocolVersion: 1 });
    const request = capture(sdk.getEps());
    await request.tracked;
    expect(request.box.err).toBeDefined();
    expect(harness.writes).toHaveLength(0);
  });

  it('reports a drained undispatched request as failed, not unknown', async () => {
    const sdk = await loadSdk();
    gateSpawn = true;
    const { box, tracked } = capture(sdk.deleteModel({ alias: 'm' } as any));
    await waitFor('the send path to reach the gated spawn', () => harness.spawnEntered);
    harness.emitClose({ code: 1 });
    await tracked;
    // Nothing was written, so the negative is provable even for a mutation.
    expect(box.err.certainty).toBe('failed');
  });
});

describe('cancellation before dispatch', () => {
  it('settles immediately rather than waiting for a startup that never finishes', async () => {
    const sdk = await loadSdk();
    gateSpawn = true;

    let assigned = -1;
    const { box, tracked } = capture(
      sdk.chatCompletionStream(
        'm',
        [{ role: 'user', content: 'hi' }],
        () => {},
        undefined,
        (id: number) => {
          assigned = id;
        },
      ),
    );
    await waitFor('the send path to reach the gated spawn', () => harness.spawnEntered);
    expect(assigned).toBeGreaterThan(0);

    expect(sdk.cancelBeforeDispatch(assigned)).toBe(true);
    await tracked;

    // Settled while startup is still gated — the caller is not left waiting on it.
    expect(box.err.certainty).toBe('cancelled');
    expect(harness.writes.filter((w) => w.includes('chatCompletion'))).toHaveLength(0);
  });

  it('does not later downgrade an accepted cancellation to failed', async () => {
    const sdk = await loadSdk();
    gateSpawn = true;
    let assigned = -1;
    const { box, tracked } = capture(
      sdk.chatCompletionStream(
        'm',
        [{ role: 'user', content: 'hi' }],
        () => {},
        undefined,
        (id: number) => {
          assigned = id;
        },
      ),
    );
    await waitFor('the send path to reach the gated spawn', () => harness.spawnEntered);
    sdk.cancelBeforeDispatch(assigned);
    await tracked;
    expect(box.err.certainty).toBe('cancelled');

    // Startup then fails outright. The already-settled request keeps its answer.
    harness.releaseSpawn?.();
    harness.emitClose({ code: 1 });
    await settleStartup();
    expect(box.err.certainty).toBe('cancelled');
  });

  it('refuses to cancel a request that has already been written', async () => {
    const sdk = await loadSdk();
    let assigned = -1;
    const p = sdk.chatCompletionStream(
      'm',
      [{ role: 'user', content: 'hi' }],
      () => {},
      undefined,
      (id: number) => {
        assigned = id;
      },
    );
    await settleStartup();
    expect(harness.writes.some((w) => w.includes('chatCompletion'))).toBe(true);

    // Dispatched, so stopping it is a request to the sidecar, not a transport guarantee.
    expect(sdk.cancelBeforeDispatch(assigned)).toBe(false);

    harness.emitStdout({ id: assigned, result: { choices: [] } });
    await expect(p).resolves.toBeDefined();
  });
});

describe('progress stall notices', () => {
  it('starts the download quiet period at dispatch and resets it on progress', async () => {
    const sdk = await loadSdk();
    gateSpawn = true;
    const progress: number[] = [];
    const onStall = vi.fn();

    vi.useFakeTimers();
    const download = capture(
      sdk.downloadModel(
        { alias: 'model-a' },
        (percent) => progress.push(percent),
        undefined,
        onStall,
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.spawnEntered).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(onStall).not.toHaveBeenCalled();

    harness.releaseSpawn?.();
    await vi.advanceTimersByTimeAsync(0);
    const downloadLine = harness.writes.find((line) => line.includes('"download"'))!;
    const downloadId = JSON.parse(downloadLine).id;

    await vi.advanceTimersByTimeAsync(59_999);
    expect(onStall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(download.box.done).toBe(false);

    harness.emitStdout({ id: downloadId, progress: 42, alias: 'model-a' });
    expect(progress).toEqual([42]);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(onStall).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(onStall).toHaveBeenCalledTimes(2);
    expect(download.box.done).toBe(false);

    harness.emitStdout({ id: downloadId, error: 'download failed' });
    await download.tracked;
    expect(download.box.err.message).toContain('download failed');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onStall).toHaveBeenCalledTimes(2);
  });

  it('retires accelerator stall notices when reset makes the outcome unknown', async () => {
    const sdk = await loadSdk();
    await completeInitialization(sdk);
    const onStall = vi.fn();

    vi.useFakeTimers();
    const readiness = capture(sdk.ensureAccelerators(undefined, onStall));
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.writes.some((line) => line.includes('"ensureAccelerators"'))).toBe(true);

    sdk.resetSDK();
    await readiness.tracked;
    expect(readiness.box.err.certainty).toBe('unknown');

    await vi.advanceTimersByTimeAsync(60_000);
    expect(onStall).not.toHaveBeenCalled();
  });
});

describe('one answer per request', () => {
  it('bounds a dispatched read-only query and ignores a late reply', async () => {
    const sdk = await loadSdk();
    const warmup = sdk.getEps();
    const warmupId = await waitForWrite('getEps');
    harness.emitStdout({ id: warmupId, result: [] });
    await warmup;

    vi.useFakeTimers();
    try {
      const query = capture(sdk.getEps());
      const queryLine = harness.writes.filter((w) => w.includes('getEps')).at(-1)!;
      const queryId = JSON.parse(queryLine).id;

      await vi.advanceTimersByTimeAsync(10_000);
      await query.tracked;
      expect(query.box.err.certainty).toBe('failed');
      expect(query.box.err.message).toContain('10 seconds');

      harness.emitStdout({ id: queryId, result: [{ name: 'late' }] });
      expect(query.box.err.certainty).toBe('failed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('revokes an undispatched query when its deadline expires during startup', async () => {
    const sdk = await loadSdk();
    gateSpawn = true;

    vi.useFakeTimers();
    try {
      const query = capture(sdk.getEps());
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.spawnEntered).toBe(true);
      expect(harness.writes).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(10_000);
      await query.tracked;
      expect(query.box.err.certainty).toBe('failed');

      harness.releaseSpawn?.();
      await vi.advanceTimersByTimeAsync(250);
      expect(harness.writes.filter((w) => w.includes('getEps'))).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not apply query deadlines to effectful work', async () => {
    const sdk = await loadSdk();
    const warmup = sdk.getEps();
    const warmupId = await waitForWrite('getEps');
    harness.emitStdout({ id: warmupId, result: [] });
    await warmup;

    vi.useFakeTimers();
    try {
      const mutation = capture(sdk.shutdownWsl());
      const mutationLine = harness.writes.find((w) => w.includes('wslShutdown'))!;
      const mutationId = JSON.parse(mutationLine).id;

      await vi.advanceTimersByTimeAsync(60_000);
      expect(mutation.box.done).toBe(false);

      harness.emitStdout({ id: mutationId, result: {} });
      await mutation.tracked;
      expect(mutation.box.err).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows pool telemetry to return after the accelerator probe budget', async () => {
    const sdk = await loadSdk();
    const warmup = sdk.getEps();
    const warmupId = await waitForWrite('getEps');
    harness.emitStdout({ id: warmupId, result: [] });
    await warmup;

    vi.useFakeTimers();
    try {
      const poll = capture(sdk.pollPoolStatus());
      const poolLine = harness.writes.find((w) => w.includes('poolStatus'))!;
      const poolId = JSON.parse(poolLine).id;

      await vi.advanceTimersByTimeAsync(10_001);
      expect(poll.box.done).toBe(false);

      harness.emitStdout({
        id: poolId,
        result: {
          models: [],
          usedMemMb: 1,
          totalMemMb: 2,
          freeMemMb: 1,
          accelerators: [],
        },
      });
      await poll.tracked;
      expect(poll.box.err).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the sidecar reply when a close arrives afterwards', async () => {
    const sdk = await loadSdk();
    const p = sdk.getEps();
    const id = await waitForWrite('getEps');

    harness.emitStdout({ id, result: [{ alias: 'a' }] });
    const value = await p;
    expect(value).toBeDefined();

    // Must not overwrite an answered request.
    harness.emitClose({ code: 1 });
    await settleStartup();
    expect(await p).toBe(value);
  });

  it('settles a rejected write by command, not as a clean failure', async () => {
    const sdk = await loadSdk();
    // Force the child to exist first: the write hook is installed when it spawns.
    const warmup = capture(sdk.getEps());
    const warmupId = await waitForWrite('getEps');
    harness.emitStdout({ id: warmupId, result: [] });
    await warmup.tracked;

    harness.failNextWrite('EPIPE');
    const mutation = capture(sdk.deleteModel({ alias: 'm' } as any));
    await waitForWrite('deleteModel');
    await mutation.tracked;
    // A rejected write does not prove the bytes never arrived, so a mutation stays unknown.
    expect(mutation.box.err.certainty).toBe('unknown');

    harness.failNextWrite('EPIPE');
    const query = capture(sdk.getEps());
    await waitForWrite('getEps', 1);
    await query.tracked;
    // The same event on a query is a clean failure: re-running it changes nothing.
    expect(query.box.err.certainty).toBe('failed');
  });

  it('keeps an answer already given when the write rejects afterwards', async () => {
    const sdk = await loadSdk();
    const warmup = capture(sdk.getEps());
    const warmupId = await waitForWrite('getEps');
    harness.emitStdout({ id: warmupId, result: [] });
    await warmup.tracked;

    harness.failNextWrite('EPIPE');
    const p = sdk.getEps();
    const { box } = capture(p);
    // The reply lands first; the rejected write must not overwrite it.
    const line = harness.writes.find((w, i) => i > 0 && w.includes('getEps'));
    expect(line).toBeDefined();
    harness.emitStdout({ id: JSON.parse(line!).id, result: [{ name: 'CPU', isRegistered: true }] });
    await settleStartup();
    expect(box.err).toBeUndefined();
    await expect(p).resolves.toEqual([{ name: 'CPU', isRegistered: true }]);
  });
});

describe('classification of an interrupted mutation', () => {
  it('calls a dispatched mutation unknown when the connection is lost', async () => {
    const sdk = await loadSdk();
    const { box, tracked } = capture(sdk.deleteModel({ alias: 'm' } as any));
    await waitForWrite('deleteModel');

    harness.emitClose({ code: 1 });
    await tracked;
    // Written, so the acknowledgement is lost rather than the work provably skipped.
    expect(box.err.certainty).toBe('unknown');
  });

  it('calls a dispatched query failed when the connection is lost', async () => {
    const sdk = await loadSdk();
    const { box, tracked } = capture(sdk.getEps());
    await waitForWrite('getEps');
    harness.emitClose({ code: 1 });
    await tracked;
    expect(box.err.certainty).toBe('failed');
  });

  it('classifies mixed pending requests independently', async () => {
    const sdk = await loadSdk();
    const query = capture(sdk.getEps());
    const mutation = capture(sdk.deleteModel({ alias: 'm' } as any));
    await waitForWrite('getEps');
    await waitForWrite('deleteModel');
    harness.emitClose({ code: 1 });
    await Promise.all([query.tracked, mutation.tracked]);
    expect(query.box.err.certainty).toBe('failed');
    expect(mutation.box.err.certainty).toBe('unknown');
  });

  it('treats an explicit error reply as a real failure, not a lost acknowledgement', async () => {
    const sdk = await loadSdk();
    const { box, tracked } = capture(sdk.deleteModel({ alias: 'm' } as any));
    const id = await waitForWrite('deleteModel');
    // The child answered, so nothing is unknown.
    harness.emitStdout({ id, error: 'no such model' });
    await tracked;
    expect(box.err.certainty).toBe('failed');
  });

  it('preserves a sidecar-confirmed cancellation as not executed', async () => {
    const sdk = await loadSdk();
    const request = capture(sdk.deleteModel({ alias: 'late-model' } as any));
    const id = await waitForWrite('deleteModel');
    harness.emitStdout({
      id,
      error: 'Runtime is draining; "deleteModel" was not started',
      certainty: 'cancelled',
    });

    await request.tracked;
    expect(request.box.err.certainty).toBe('cancelled');
    expect(request.box.err.message).toContain('did not run');
  });
});

describe('service start uncertainty', () => {
  it('does not restart a confirmed running service when ensuring readiness', async () => {
    const sdk = await loadSdk();
    const start = sdk.startService(5272);
    const startId = await waitForWrite('startService');
    harness.emitStdout({ id: startId, endpoint: 'http://127.0.0.1:5272' });
    await start;

    const before = harness.writes.filter((w) => w.includes('startService')).length;
    const ensured = await sdk.ensureServiceRunning(5272);

    expect(ensured).toEqual({ endpoint: 'http://127.0.0.1:5272', started: false });
    expect(harness.writes.filter((w) => w.includes('startService')).length).toBe(before);
  });

  it('stands down a convenience start after an unestablished outcome', async () => {
    const sdk = await loadSdk();
    const first = capture(sdk.startService(5272, undefined, undefined, undefined, {
      convenience: true,
    }));
    await settleStartup();
    expect(harness.writes.some((w) => w.includes('startService'))).toBe(true);

    // Interrupted with no answer: the service may well be running.
    harness.emitClose({ code: 1 });
    await first.tracked;
    expect(first.box.err.certainty).toBe('unknown');
    expect(sdk.isServiceStartUncertain()).toBe(true);

    const before = harness.writes.filter((w) => w.includes('startService')).length;
    const second = capture(
      sdk.startService(5272, undefined, undefined, undefined, { convenience: true }),
    );
    await settleStartup();
    await second.tracked;
    // Blocked without writing: starting is a destructive restart.
    expect(harness.writes.filter((w) => w.includes('startService')).length).toBe(before);
    expect(second.box.err.certainty).toBe('unknown');
  });

  it('lets an explicit start through without clearing the latch for anyone else', async () => {
    const sdk = await loadSdk();
    const first = capture(
      sdk.startService(5272, undefined, undefined, undefined, { convenience: true }),
    );
    await settleStartup();
    harness.emitClose({ code: 1 });
    await first.tracked;
    expect(sdk.isServiceStartUncertain()).toBe(true);

    // An explicit start bypasses the guard by not being a convenience start. It must not clear
    // the shared latch, or every convenience start queued behind the lock would be released too.
    const before = harness.writes.filter((w) => w.includes('startService')).length;
    const retry = capture(sdk.startService(5272));
    await settleStartup();
    expect(harness.writes.filter((w) => w.includes('startService')).length).toBe(before + 1);

    harness.emitClose({ code: 1 });
    await retry.tracked;
    // The retry was itself unestablished, so the latch stands.
    expect(sdk.isServiceStartUncertain()).toBe(true);
  });

  it('retires the latch only on a start that reported success', async () => {
    const sdk = await loadSdk();
    const first = capture(
      sdk.startService(5272, undefined, undefined, undefined, { convenience: true }),
    );
    await settleStartup();
    harness.emitClose({ code: 1 });
    await first.tracked;
    expect(sdk.isServiceStartUncertain()).toBe(true);

    const retry = sdk.startService(5272);
    await settleStartup();
    const line = harness.writes.filter((w) => w.includes('startService')).pop()!;
    harness.emitStdout({ id: JSON.parse(line).id, endpoint: 'http://127.0.0.1:5272' });
    await retry;
    expect(sdk.isServiceStartUncertain()).toBe(false);
  });

  it('does not treat a Stop acknowledgement as proof the service is quiescent', async () => {
    const sdk = await loadSdk();
    const first = capture(
      sdk.startService(5272, undefined, undefined, undefined, { convenience: true }),
    );
    await settleStartup();
    harness.emitClose({ code: 1 });
    await first.tracked;
    expect(sdk.isServiceStartUncertain()).toBe(true);

    const stop = sdk.stopService();
    await settleStartup();
    const line = harness.writes.filter((w) => w.includes('stopService')).pop()!;
    harness.emitStdout({ id: JSON.parse(line).id, result: {} });
    await stop;
    // The sidecar handles commands concurrently, so the earlier start may still be inside
    // startWebService() and can bring the service up again after Stop has replied.
    expect(sdk.isServiceStartUncertain()).toBe(true);
  });

  it('stops and unloads without terminating the reusable runtime', async () => {
    const sdk = await loadSdk();
    const start = sdk.startService(5272);
    const startId = await waitForWrite('startService');
    harness.emitStdout({ id: startId, endpoint: 'http://127.0.0.1:5272' });
    await start;

    const stopping = sdk.stopAndUnload({ drainTimeoutMs: 25 });
    const stopId = await waitForWrite('stopAndUnload');
    const cleanup = {
      endpointWithdrawn: true,
      serviceStopped: true,
      drained: true,
      activeOperations: [],
      modelsUnloaded: [],
      unloadFailures: [],
      nativeServiceStopped: true,
      cleanup: 'confirmed',
    };
    harness.emitStdout({ id: stopId, result: cleanup });

    await expect(stopping).resolves.toEqual(cleanup);
    expect(harness.killCount).toBe(0);
    const snapshot = getLastSdkSnapshot(sdk);
    expect(snapshot.runtime.process).toBe('ready');
    expect(snapshot.runtime.service).toBe('stopped');
    expect(snapshot.runtime.models).toBe('empty');
  });

  it('does not publish a stopped native service when cleanup reports failure', async () => {
    const sdk = await loadSdk();
    const warmup = sdk.getEps();
    const warmupId = await waitForWrite('getEps');
    harness.emitStdout({ id: warmupId, result: [] });
    await warmup;

    const stopping = sdk.stopAndUnload();
    const stopId = await waitForWrite('stopAndUnload');
    harness.emitStdout({
      id: stopId,
      result: {
        endpointWithdrawn: true,
        serviceStopped: false,
        drained: true,
        activeOperations: [],
        modelsUnloaded: [],
        unloadFailures: [],
        nativeServiceStopped: false,
        cleanup: 'failed',
      },
    });
    await stopping;

    const snapshot = getLastSdkSnapshot(sdk);
    expect(snapshot.endpoint).toBeUndefined();
    expect(snapshot.serviceRunning).toBe(false);
    expect(snapshot.runtime.service).toBe('failed');
  });

  it('confirms runtime quit only after the child closes', async () => {
    const sdk = await loadSdk();
    const warmup = sdk.getEps();
    const warmupId = await waitForWrite('getEps');
    harness.emitStdout({ id: warmupId, result: [] });
    await warmup;

    const quitting = sdk.quitRuntime({ gracefulTimeoutMs: 100, killTimeoutMs: 100 });
    const shutdownId = await waitForWrite('shutdownRuntime');
    const cleanup = {
      endpointWithdrawn: true,
      serviceStopped: true,
      drained: true,
      activeOperations: [],
      modelsUnloaded: ['model-a'],
      unloadFailures: [],
      nativeServiceStopped: true,
      cleanup: 'confirmed',
    };
    harness.emitStdout({ id: shutdownId, result: cleanup });
    await Promise.resolve();
    expect(harness.killCount).toBe(0);

    harness.emitClose({ code: 0 });
    await expect(quitting).resolves.toEqual({
      cleanup,
      termination: 'confirmed',
    });
    expect(getLastSdkSnapshot(sdk).runtime.process).toBe('stopped');
  });

  it('escalates runtime quit only after the graceful close deadline', async () => {
    const sdk = await loadSdk();
    const warmup = sdk.getEps();
    const warmupId = await waitForWrite('getEps');
    harness.emitStdout({ id: warmupId, result: [] });
    await warmup;

    const quitting = sdk.quitRuntime({ gracefulTimeoutMs: 20, killTimeoutMs: 100 });
    await waitForWrite('shutdownRuntime');
    expect(harness.killCount).toBe(0);
    harness.hangKill = true;
    await waitFor('the sidecar kill escalation', () => harness.killCount === 1);
    harness.emitClose({ code: null, signal: 'SIGTERM' });

    await expect(quitting).resolves.toEqual({
      cleanup: null,
      termination: 'escalated-confirmed',
    });
  });

  it('starts the quit deadline without waiting for a blocked service transition', async () => {
    const sdk = await loadSdk();
    const warmup = sdk.getEps();
    const warmupId = await waitForWrite('getEps');
    harness.emitStdout({ id: warmupId, result: [] });
    await warmup;

    let release!: () => void;
    const blocked = sdk.withServiceTransition(
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await waitFor('the service transition to be blocked', () => typeof release === 'function');

    const quitting = sdk.quitRuntime({ gracefulTimeoutMs: 20, killTimeoutMs: 100 });
    await waitForWrite('shutdownRuntime');
    await waitFor('the sidecar kill escalation', () => harness.killCount === 1);
    harness.emitClose({ code: null, signal: 'SIGTERM' });
    await expect(quitting).resolves.toMatchObject({ termination: 'escalated-confirmed' });

    release();
    await blocked;
  });

  it('rejects new work before dispatch once runtime quit begins', async () => {
    const sdk = await loadSdk();
    const warmup = sdk.getEps();
    const warmupId = await waitForWrite('getEps');
    harness.emitStdout({ id: warmupId, result: [] });
    await warmup;

    const quitting = sdk.quitRuntime({ gracefulTimeoutMs: 100, killTimeoutMs: 100 });
    await waitForWrite('shutdownRuntime');
    const later = capture(sdk.deleteModel({ alias: 'late-model' } as any));
    await later.tracked;

    expect(later.box.err.certainty).toBe('cancelled');
    expect(harness.writes.filter((line) => line.includes('late-model'))).toHaveLength(0);

    harness.emitClose({ code: 0 });
    await quitting;
  });

  it('keeps service state unknown when Stop delivery is uncertain', async () => {
    const sdk = await loadSdk();
    const warmup = capture(sdk.getEps());
    const warmupId = await waitForWrite('getEps');
    harness.emitStdout({ id: warmupId, result: [] });
    await warmup.tracked;

    harness.failNextWrite('EPIPE');
    const stop = capture(sdk.stopService());
    const stopId = await waitForWrite('stopService');
    let snapshot: any;
    const unsubscribe = sdk.getSDKState().subscribe((state) => {
      snapshot = state;
    });
    await stop.tracked;
    expect(stop.box.err.certainty).toBe('unknown');
    expect(snapshot.runtime.service).toBe('unknown');
    expect(stopId).toBeGreaterThan(0);
    unsubscribe();
  });

  it('does not advertise the old endpoint after a failed restart', async () => {
    const sdk = await loadSdk();
    const start = sdk.startService(5272);
    const startId = await waitForWrite('startService');
    harness.emitStdout({ id: startId, endpoint: 'http://127.0.0.1:5272' });
    await start;

    const restart = capture(sdk.startService(5273));
    const restartId = await waitForWrite('startService', 1);
    harness.emitStdout({ id: restartId, error: 'address already in use' });
    await restart.tracked;

    const snapshot = getLastSdkSnapshot(sdk);
    expect(restart.box.err.certainty).toBe('failed');
    expect(snapshot.endpoint).toBeUndefined();
    expect(snapshot.serviceRunning).toBe(false);
    expect(snapshot.runtime.service).toBe('failed');
  });

  it('blocks a convenience start that was queued before the first outcome was known', async () => {
    const sdk = await loadSdk();
    // Warm the child so both starts queue against a live transport.
    const warmup = capture(sdk.getEps());
    const warmupId = await waitForWrite('getEps');
    harness.emitStdout({ id: warmupId, result: [] });
    await warmup.tracked;

    const before = harness.writes.filter((w) => w.includes('startService')).length;
    // Queued together: the second is behind the transition lock while the first is in flight,
    // so it cannot have consulted the latch before the first one set it.
    const first = capture(
      sdk.startService(5272, undefined, undefined, undefined, { convenience: true }),
    );
    const second = capture(
      sdk.startService(5272, undefined, undefined, undefined, { convenience: true }),
    );
    await settleStartup();
    expect(harness.writes.filter((w) => w.includes('startService')).length).toBe(before + 1);

    harness.emitClose({ code: 1 });
    await Promise.all([first.tracked, second.tracked]);
    // Still one write: the queued start saw the latch when it finally ran.
    expect(harness.writes.filter((w) => w.includes('startService')).length).toBe(before + 1);
    expect(second.box.err.certainty).toBe('unknown');
  });

  it('cancels a start queued before Stop without dispatching it', async () => {
    const sdk = await loadSdk();
    let release!: () => void;
    const hold = sdk.withServiceTransition(
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await waitFor('the transition lock to be held', () => typeof release === 'function');

    const start = capture(sdk.startService(5272));
    const stop = capture(sdk.stopService());
    release();
    await hold;
    await start.tracked;

    const starts = harness.writes.filter((w) => w.includes('startService'));
    expect(starts).toHaveLength(0);
    expect(start.box.err.certainty).toBe('cancelled');

    const stopId = await waitForWrite('stopService');
    harness.emitStdout({ id: stopId, result: {} });
    await stop.tracked;
  });

  it('cancels an ensure queued before Stop without dispatching a start', async () => {
    const sdk = await loadSdk();
    let release!: () => void;
    const hold = sdk.withServiceTransition(
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await waitFor('the transition lock to be held', () => typeof release === 'function');

    const ensure = capture(sdk.ensureServiceRunning(5272));
    const stop = capture(sdk.stopService());
    release();
    await hold;
    await ensure.tracked;

    expect(ensure.box.err.certainty).toBe('cancelled');
    expect(harness.writes.filter((w) => w.includes('startService'))).toHaveLength(0);
    const stopId = await waitForWrite('stopService');
    harness.emitStdout({ id: stopId, result: {} });
    await stop.tracked;
  });

  function getLastSdkSnapshot(sdk: { getSDKState: () => { subscribe: (fn: (state: any) => void) => () => void } }) {
    let snapshot: any;
    const unsubscribe = sdk.getSDKState().subscribe((state) => {
      snapshot = state;
    });
    unsubscribe();
    return snapshot;
  }
});

describe('initialization readiness recovery', () => {
  it('does not publish readiness when the initial child is lost during catalog refresh', async () => {
    const sdk = await loadSdk();
    const first = sdk.initializeSDK({ autoStartService: false });

    const initId = await waitForWrite('init');
    harness.emitStdout({ id: initId, result: 'initialized' });
    const logId = await waitForWrite('setLogLevel');
    harness.emitStdout({ id: logId, result: {} });
    const listId = await waitForWrite('listModels');
    harness.emitStdout({ id: listId, result: [] });
    const statusId = await waitForWrite('getStatus');
    harness.emitStdout({ id: statusId, result: { serviceRunning: false, endpoint: null } });
    await waitForWrite('poolStatus');
    harness.emitClose({ code: 1 });

    await expect(first).resolves.toBe(false);
  }, 15000);

  it('refreshes an initialized manager after catalog failure without sending init twice', async () => {
    const sdk = await loadSdk();
    const first = sdk.initializeSDK({ autoStartService: false });

    const initId = await waitForWrite('init');
    harness.emitStdout({ id: initId, result: 'initialized' });
    const logId = await waitForWrite('setLogLevel');
    harness.emitStdout({ id: logId, result: {} });
    const firstListId = await waitForWrite('listModels');
    harness.emitStdout({ id: firstListId, error: 'catalog unavailable' });
    await expect(first).resolves.toBe(false);

    const retry = sdk.initializeSDK({ autoStartService: false });
    const secondListId = await waitForWrite('listModels', 1);
    harness.emitStdout({ id: secondListId, result: [] });
    const refreshStatusId = await waitForWrite('getStatus');
    harness.emitStdout({ id: refreshStatusId, result: { serviceRunning: false, endpoint: null } });
    const poolId = await waitForWrite('poolStatus');
    harness.emitStdout({ id: poolId, result: { models: [] } });
    const startupStatusId = await waitForWrite('getStatus', 1);
    harness.emitStdout({ id: startupStatusId, result: { serviceRunning: false, endpoint: null } });
    await expect(retry).resolves.toBe(true);

    expect(harness.writes.filter((line) => line.includes('"cmd":"init"'))).toHaveLength(1);
  }, 15000);

  it('does not restore readiness when the sidecar is replaced during recovery', async () => {
    const sdk = await loadSdk();
    const first = sdk.initializeSDK({ autoStartService: false });

    const initId = await waitForWrite('init');
    harness.emitStdout({ id: initId, result: 'initialized' });
    const logId = await waitForWrite('setLogLevel');
    harness.emitStdout({ id: logId, result: {} });
    const firstListId = await waitForWrite('listModels');
    harness.emitStdout({ id: firstListId, error: 'catalog unavailable' });
    await expect(first).resolves.toBe(false);

    const retry = sdk.initializeSDK({ autoStartService: false });
    const secondListId = await waitForWrite('listModels', 1);
    harness.emitStdout({ id: secondListId, result: [] });
    const refreshStatusId = await waitForWrite('getStatus');
    harness.emitStdout({ id: refreshStatusId, result: { serviceRunning: false, endpoint: null } });
    await waitForWrite('poolStatus');
    harness.emitClose({ code: 1 });

    await expect(retry).resolves.toBe(false);
    let snapshot: any;
    const unsubscribe = sdk.getSDKState().subscribe((state) => {
      snapshot = state;
    });
    unsubscribe();
    expect(snapshot.ready).toBe(false);
  }, 15000);

  it('does not return success when the child is lost during the final status probe', async () => {
    const sdk = await loadSdk();
    const first = sdk.initializeSDK({ autoStartService: false });

    const initId = await waitForWrite('init');
    harness.emitStdout({ id: initId, result: 'initialized' });
    const logId = await waitForWrite('setLogLevel');
    harness.emitStdout({ id: logId, result: {} });
    const firstListId = await waitForWrite('listModels');
    harness.emitStdout({ id: firstListId, error: 'catalog unavailable' });
    await expect(first).resolves.toBe(false);

    const retry = sdk.initializeSDK({ autoStartService: false });
    const secondListId = await waitForWrite('listModels', 1);
    harness.emitStdout({ id: secondListId, result: [] });
    const refreshStatusId = await waitForWrite('getStatus');
    harness.emitStdout({ id: refreshStatusId, result: { serviceRunning: false, endpoint: null } });
    const poolId = await waitForWrite('poolStatus');
    harness.emitStdout({ id: poolId, result: { models: [] } });
    await waitForWrite('getStatus', 1);
    harness.emitClose({ code: 1 });

    await expect(retry).resolves.toBe(false);
  }, 15000);
});

describe('accelerator readiness ownership', () => {
  it('rejects a registration result when its sidecar exits before provider discovery', async () => {
    const sdk = await loadSdk();
    await completeInitialization(sdk);

    const readiness = sdk.ensureAccelerators();
    const registrationId = await waitForWrite('ensureAccelerators');
    harness.emitStdout({
      id: registrationId,
      result: {
        success: false,
        status: 'QNN registered; CUDA failed',
        registeredEps: ['QNNExecutionProvider'],
        failedEps: ['CUDAExecutionProvider'],
      },
    });
    harness.emitClose({ code: 1 });

    await expect(readiness).rejects.toThrow('lost after accelerator registration');
    expect(harness.writes.filter((line) => line.includes('"cmd":"getEps"'))).toHaveLength(0);
  }, 15000);

  it('rejects provider discovery completed by a sidecar that exits before confirmation', async () => {
    const sdk = await loadSdk();
    await completeInitialization(sdk);

    const readiness = sdk.ensureAccelerators();
    const registrationId = await waitForWrite('ensureAccelerators');
    harness.emitStdout({
      id: registrationId,
      result: {
        success: true,
        status: 'registered',
        registeredEps: ['QNNExecutionProvider'],
        failedEps: [],
      },
    });
    const epsId = await waitForWrite('getEps');
    harness.emitStdout({
      id: epsId,
      result: [{ name: 'QNNExecutionProvider', isRegistered: true }],
    });
    harness.emitClose({ code: 1 });

    await expect(readiness).rejects.toThrow('replaced while confirming accelerator readiness');
  }, 15000);

  it('binds accelerator readiness to the generation that received the registration request', async () => {
    const sdk = await loadSdk();
    await completeInitialization(sdk);
    let snapshot: any;
    const unsubscribe = sdk.getSDKState().subscribe((state) => {
      snapshot = state;
    });
    const dispatchedGeneration = snapshot.runtime.generation;

    const readiness = sdk.ensureAccelerators();
    const registrationId = await waitForWrite('ensureAccelerators');
    harness.emitStdout({
      id: registrationId,
      result: {
        success: true,
        status: 'registered',
        registeredEps: ['QNNExecutionProvider'],
        failedEps: [],
      },
    });
    const epsId = await waitForWrite('getEps');
    harness.emitStdout({
      id: epsId,
      result: [{ name: 'QNNExecutionProvider', isRegistered: true }],
    });

    await expect(readiness).resolves.toMatchObject({ generation: dispatchedGeneration });
    unsubscribe();
  }, 15000);

  it('does not start HTTP with readiness owned by an exited sidecar', async () => {
    const sdk = await loadSdk();
    await completeInitialization(sdk);

    const readinessPromise = sdk.ensureAccelerators();
    const registrationId = await waitForWrite('ensureAccelerators');
    harness.emitStdout({
      id: registrationId,
      result: {
        success: true,
        status: 'registered',
        registeredEps: ['QNNExecutionProvider'],
        failedEps: [],
      },
    });
    const epsId = await waitForWrite('getEps');
    harness.emitStdout({
      id: epsId,
      result: [{ name: 'QNNExecutionProvider', isRegistered: true }],
    });
    const readiness = await readinessPromise;
    expect(sdk.isAcceleratorReadinessCurrent(readiness)).toBe(true);

    harness.emitClose({ code: 1 });
    expect(sdk.isAcceleratorReadinessCurrent(readiness)).toBe(false);
    await expect(sdk.ensureServiceRunning(
      5272,
      undefined,
      undefined,
      undefined,
      { convenience: true, expectedGeneration: readiness.generation },
    )).rejects.toThrow('Runtime changed before the service could start');
    expect(harness.writes.filter((line) => line.includes('"cmd":"startService"'))).toHaveLength(0);
  }, 15000);

  it('does not adopt a running endpoint from a status probe answered by an exited sidecar', async () => {
    const sdk = await loadSdk();
    await completeInitialization(sdk);
    let snapshot: any;
    const unsubscribe = sdk.getSDKState().subscribe((state) => {
      snapshot = state;
    });

    const ensured = sdk.ensureServiceRunning(
      5272,
      undefined,
      undefined,
      undefined,
      { convenience: true, expectedGeneration: snapshot.runtime.generation },
    );
    const statusId = await waitForWrite('getStatus', 2);
    harness.emitStdout({
      id: statusId,
      result: { serviceRunning: true, endpoint: 'http://127.0.0.1:5272' },
    });
    harness.emitClose({ code: 1 });

    await expect(ensured).rejects.toThrow('Runtime changed before the service could start');
    expect(snapshot.serviceRunning).toBe(false);
    expect(snapshot.endpoint).toBeUndefined();
    unsubscribe();
  }, 15000);

  it('does not publish an endpoint when the sidecar exits after the start reply', async () => {
    const sdk = await loadSdk();
    await completeInitialization(sdk);
    let snapshot: any;
    const unsubscribe = sdk.getSDKState().subscribe((state) => {
      snapshot = state;
    });

    const ensured = sdk.ensureServiceRunning(
      5272,
      undefined,
      undefined,
      undefined,
      { convenience: true, expectedGeneration: snapshot.runtime.generation },
    );
    const statusId = await waitForWrite('getStatus', 2);
    harness.emitStdout({ id: statusId, result: { serviceRunning: false, endpoint: null } });
    const startId = await waitForWrite('startService');
    harness.emitStdout({ id: startId, endpoint: 'http://127.0.0.1:5272' });
    harness.emitClose({ code: 1 });

    await expect(ensured).rejects.toThrow('endpoint is no longer available');
    expect(snapshot.serviceRunning).toBe(false);
    expect(snapshot.endpoint).toBeUndefined();
    unsubscribe();
  }, 15000);

  it('does not report a model load after its sidecar exits before refresh', async () => {
    const sdk = await loadSdk();
    await completeInitialization(sdk);

    const load = sdk.loadModel({ alias: 'example' });
    const loadId = await waitForWrite('load');
    harness.emitStdout({ id: loadId, result: { alias: 'example', variantId: 'example-qnn-npu:1' } });
    harness.emitClose({ code: 1 });

    await expect(load).rejects.toThrow('lost after loading the model');
    expect(harness.writes.filter((line) => line.includes('"cmd":"listModels"'))).toHaveLength(1);
  }, 15000);

  it('does not report a model load when its refresh completes on an exited sidecar', async () => {
    const sdk = await loadSdk();
    await completeInitialization(sdk);

    const load = sdk.loadModel({ alias: 'example' });
    const loadId = await waitForWrite('load');
    harness.emitStdout({ id: loadId, result: { alias: 'example', variantId: 'example-qnn-npu:1' } });
    const listId = await waitForWrite('listModels', 1);
    harness.emitStdout({ id: listId, result: [] });
    const statusId = await waitForWrite('getStatus', 2);
    harness.emitStdout({ id: statusId, result: { serviceRunning: false, endpoint: null } });
    const poolId = await waitForWrite('poolStatus', 1);
    harness.emitStdout({ id: poolId, result: { models: [] } });
    harness.emitClose({ code: 1 });

    await expect(load).rejects.toThrow('replaced while confirming the loaded model');
  }, 15000);
});

describe('cancellation from inside onAssignedId', () => {
  it('settles the caller rather than leaving a promise nobody can answer', async () => {
    const sdk = await loadSdk();
    gateSpawn = true;

    // The id callback fires before the caller has the promise, so this is the earliest possible
    // cancellation. The entry must already carry its real reject handler by then.
    const { box, tracked } = capture(
      sdk.chatCompletionStream('m', [{ role: 'user', content: 'hi' }], () => {}, undefined, (id) => {
        sdk.cancelBeforeDispatch(id);
      }),
    );
    await tracked;
    expect(box.err.certainty).toBe('cancelled');

    harness.releaseSpawn?.();
    await settleStartup();
    expect(harness.writes.filter((w) => w.includes('chatCompletion'))).toHaveLength(0);
  });

  it('settles the caller when the id callback throws', async () => {
    const sdk = await loadSdk();
    gateSpawn = true;
    const { box, tracked } = capture(
      sdk.chatCompletionStream('m', [{ role: 'user', content: 'hi' }], () => {}, undefined, () => {
        throw new Error('callback exploded');
      }),
    );
    await tracked;
    // Never published to the child, so the negative is provable.
    expect(box.err.certainty).toBe('failed');

    harness.releaseSpawn?.();
    await settleStartup();
    expect(harness.writes.filter((w) => w.includes('chatCompletion'))).toHaveLength(0);
  });

  it('fences startNow when Stop is queued during the same transition', async () => {
    const sdk = await loadSdk();
    let stop!: Promise<void>;
    let start!: ReturnType<typeof capture>;
    await sdk.withServiceTransition(async ({ startNow }) => {
      stop = sdk.stopService();
      start = capture(startNow(5272));
      await start.tracked;
    });

    expect(start.box.err.certainty).toBe('cancelled');
    expect(harness.writes.filter((w) => w.includes('startService'))).toHaveLength(0);
    const stopId = await waitForWrite('stopService');
    harness.emitStdout({ id: stopId, result: {} });
    await stop;
  });
});
