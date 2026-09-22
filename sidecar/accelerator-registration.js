function errorMessage(error) {
  return error?.message || String(error);
}

function discoveredProviders(manager) {
  if (typeof manager?.discoverEps !== 'function') return [];
  const providers = manager.discoverEps();
  return Array.isArray(providers) ? providers : [];
}

function providerName(provider) {
  return String(provider?.name || '').trim();
}

/**
 * Register every provider the runtime discovered before the catalog is first read.
 *
 * SDK 2.0.1's no-argument registration selects one preferred provider, and its
 * `registeredEps` list is the names requested, not a confirmation. The native catalog
 * is then fixed on first access, so a provider this function reports as registered
 * has to be one `discoverEps` still marks registered. One failure must not hide the
 * others, and a provider that appears only after another registration still has to
 * be registered before that catalog read.
 */
export async function registerDiscoveredExecutionProviders(manager, onProgress, options = {}) {
  if (typeof manager?.downloadAndRegisterEps !== 'function') return null;

  const initial = discoveredProviders(manager);
  if (initial.length === 0) {
    // An empty list is not proof the machine has no GPU. Discovery can be empty
    // for a moment after the manager exists. The one-provider fallback is only
    // for a caller that has already decided not to look again.
    if (options.allowLegacyFallback === false) {
      return {
        success: false,
        status: 'No execution providers discovered yet',
        registeredEps: [],
        failedEps: [],
        retry: true,
      };
    }
    // No-argument registration selects one preferred provider and reports success
    // with an empty registeredEps list. Returning that result seals the gate, so
    // the catalog can be read before any provider that is visible after the call
    // gets an explicit registration.
    const fallback = await manager.downloadAndRegisterEps(onProgress);
    if (!discoveredProviders(manager).some((provider) => providerName(provider))) return fallback;
  }

  const failures = new Map();
  const attempted = new Set();
  // Bounded so a discovery list that keeps growing cannot register forever.
  // Eight covers the providers this machine can surface (CPU, CUDA, WebGPU,
  // TensorRT, DML, QNN, OpenVINO) with one spare pass.
  for (let pass = 0; pass < 8; pass++) {
    const pending = discoveredProviders(manager).filter((provider) => {
      const name = providerName(provider);
      return name && !provider.isRegistered && !attempted.has(name);
    });
    if (pending.length === 0) break;
    for (const provider of pending) {
      const name = providerName(provider);
      attempted.add(name);
      try {
        await manager.downloadAndRegisterEps([name], onProgress);
      } catch (error) {
        failures.set(name, errorMessage(error));
      }
    }
  }

  const registeredEps = [];
  const failedEps = [];
  const seen = new Set();
  for (const provider of discoveredProviders(manager)) {
    const name = providerName(provider);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    if (provider.isRegistered) {
      registeredEps.push(name);
      failures.delete(name);
    } else {
      failedEps.push(name);
      if (!failures.has(name)) failures.set(name, 'runtime did not confirm registration');
    }
  }
  for (const name of attempted) {
    if (seen.has(name)) continue;
    failedEps.push(name);
    if (!failures.has(name)) failures.set(name, 'runtime did not confirm registration');
  }

  const success = failedEps.length === 0;
  return {
    success,
    status: success
      ? `Registered ${registeredEps.length} execution provider${registeredEps.length === 1 ? '' : 's'}`
      : `Registered ${registeredEps.length}; failed ${failedEps.length}: ${
          failedEps.map((name) => `${name} (${failures.get(name)})`).join('; ')
        }`,
    registeredEps,
    failedEps,
    // A failed provider can still be registered on a later call, until the catalog
    // is read. After that read the snapshot cannot gain the missing build.
    ...(success ? {} : { retry: true }),
  };
}

/** Attempts before a catalog read, including the first. A provider that keeps failing must not block the catalog forever. */
const CATALOG_REGISTRATION_ATTEMPTS = 3;

/**
 * The bounded attempts are spent. Callers must be able to read the catalog anyway.
 * A thrown last attempt used to clear the gate, so every later list, load, and
 * service start ran the same three failures and never got that far. Providers
 * that registered on an earlier attempt stay in the result; another pass cannot
 * add them after this result is kept and the snapshot is taken.
 */
function terminalRegistrationResult(previous, error) {
  const registeredEps = Array.isArray(previous?.registeredEps) ? previous.registeredEps : [];
  const failedEps = Array.isArray(previous?.failedEps) ? previous.failedEps : [];
  const message = errorMessage(error);
  return {
    success: false,
    status: registeredEps.length > 0
      ? `Registered ${registeredEps.length}; last attempt failed: ${message}`
      : message,
    registeredEps,
    failedEps,
  };
}

/**
 * Registration before the first catalog read, plus one explicit retry before that
 * read is committed.
 *
 * Catalog readers share one cycle: an empty discovery or a failed download is tried
 * again inside that cycle, and a throw on the last attempt is kept so later readers
 * are not sent through the same three failures. Once a catalog read commits, the
 * snapshot cannot gain providers, so `ensure` does not run again.
 *
 * Settings can call `rerun` before that commit. Startup's `ensureAccelerators` is
 * that same command, and the button calls it again. A kept startup failure must not
 * make the button a no-op while the catalog is still unread. After the commit,
 * `rerun` returns the kept result.
 *
 * Work is serialized. A catalog read queued behind an explicit retry waits for it,
 * so the snapshot is not taken between the two.
 */
export function createCatalogRegistrationGate(register) {
  let settled = null;
  let committed = false;
  /** @type {Promise<unknown>} */
  let tail = Promise.resolve();

  // `report` is the caller that queued this cycle. A later Settings click must not
  // steal these events: the UI stall watchdog for the in-flight command only resets
  // when progress arrives on that command's id.
  async function attempts(report) {
    const notify = typeof report === 'function' ? report : () => {};
    let last = null;
    for (let attempt = 1; attempt <= CATALOG_REGISTRATION_ATTEMPTS; attempt++) {
      try {
        last = await register(
          (name, pct) => notify(name, pct),
          { allowLegacyFallback: attempt === CATALOG_REGISTRATION_ATTEMPTS },
        );
      } catch (error) {
        if (attempt === CATALOG_REGISTRATION_ATTEMPTS) return terminalRegistrationResult(last, error);
        continue;
      }
      if (!last?.retry) return last;
    }
    return last;
  }

  // One chain. A catalog read queued behind an explicit retry waits for that retry,
  // and a second caller cannot start another registration beside the first.
  function enqueue(task) {
    const run = tail.then(() => task());
    tail = run.then(() => {}, () => {});
    return run;
  }

  return {
    ensure(onProgress) {
      const report = typeof onProgress === 'function' ? onProgress : null;
      return enqueue(async () => {
        if (!settled) settled = await attempts(report);
        return settled;
      });
    },
    rerun(onProgress) {
      const report = typeof onProgress === 'function' ? onProgress : null;
      return enqueue(async () => {
        if (committed) return settled;
        settled = await attempts(report);
        return settled;
      });
    },
    commit(onProgress) {
      const report = typeof onProgress === 'function' ? onProgress : null;
      return enqueue(async () => {
        if (!settled) settled = await attempts(report);
        committed = true;
        return settled;
      });
    },
  };
}
