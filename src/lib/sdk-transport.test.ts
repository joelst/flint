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
};

let harness: Harness;
/** The live child's event hooks, replaced on every spawn; the harness delegates to these. */
let live: {
  emitStdout: (obj: unknown) => void;
  emitClose: (data?: unknown) => void;
  emitError: (err: string) => void;
} | null = null;
/** Module-scoped so it survives the child being replaced. */
let pendingWriteError: string | null = null;
/** When set, `spawn()` waits on this so a test can act while startup is still in flight. */
let gateSpawn = false;

function makeCommand() {
  const listeners: Record<string, Array<(arg: any) => void>> = {};
  const stdoutListeners: Array<(line: any) => void> = [];

  const child = {
    write: (line: string) => {
      harness.writes.push(line);
      if (pendingWriteError) {
        const e = pendingWriteError;
        pendingWriteError = null;
        return Promise.reject(new Error(e));
      }
      return Promise.resolve();
    },
    kill: () => {},
  };

  live = {
    emitStdout: (obj: unknown) => {
      const line = typeof obj === 'string' ? obj : JSON.stringify(obj);
      for (const fn of stdoutListeners) fn(line);
    },
    emitClose: (data: unknown = { code: 1 }) => {
      for (const fn of listeners.close ?? []) fn(data);
    },
    emitError: (err: string) => {
      for (const fn of listeners.error ?? []) fn(err);
    },
  };

  return {
    on(event: string, fn: (arg: any) => void) {
      (listeners[event] ??= []).push(fn);
    },
    stdout: {
      on(_event: string, fn: (line: any) => void) {
        stdoutListeners.push(fn);
      },
      listenerCount: () => stdoutListeners.length,
    },
    stderr: { on() {} },
    // The Node preflight runs `node --version` through the same Command API.
    async execute() {
      return { code: 0, stdout: 'v22.11.0', stderr: '' };
    },
    async spawn() {
      harness.spawnEntered = true;
      if (gateSpawn) {
        await new Promise<void>((resolve) => {
          harness.releaseSpawn = resolve;
        });
      }
      // The transport waits for a `{ready:true}` line before it will send anything. Delivered on
      // a later tick so it lands after `spawn()` resolves, as the real child's would.
      queueMicrotask(() => live?.emitStdout({ ready: true, protocolVersion: 1 }));
      return child;
    },
  };
}

vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: {
    create: () => makeCommand(),
    sidecar: () => makeCommand(),
  },
}));
vi.mock('@tauri-apps/api/path', () => ({
  resolveResource: async (k: string) => `/fake/${k}`,
  resourceDir: async () => '/fake',
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: async () => true,
}));

async function loadSdk() {
  vi.resetModules();
  harness = {
    writes: [],
    failNextWrite: (err: string) => {
      pendingWriteError = err;
    },
    emitStdout: (obj) => {
      if (!live) throw new Error('emitStdout before a child was spawned');
      live.emitStdout(obj);
    },
    emitClose: (data) => {
      if (!live) throw new Error('emitClose before a child was spawned');
      live.emitClose(data);
    },
    emitError: (err) => {
      if (!live) throw new Error('emitError before a child was spawned');
      live.emitError(err);
    },
    spawnEntered: false,
  };
  gateSpawn = false;
  pendingWriteError = null;
  live = null;
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
  vi.restoreAllMocks();
});

describe('settlement revokes permission to dispatch', () => {
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

describe('one answer per request', () => {
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
});

describe('service start uncertainty', () => {
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
});
