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
export async function registerDiscoveredExecutionProviders(manager, onProgress) {
  if (typeof manager?.downloadAndRegisterEps !== 'function') return null;

  const initial = discoveredProviders(manager);
  if (initial.length === 0) {
    return await manager.downloadAndRegisterEps(onProgress);
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

  return {
    success: failedEps.length === 0,
    status: failedEps.length === 0
      ? `Registered ${registeredEps.length} execution provider${registeredEps.length === 1 ? '' : 's'}`
      : `Registered ${registeredEps.length}; failed ${failedEps.length}: ${
          failedEps.map((name) => `${name} (${failures.get(name)})`).join('; ')
        }`,
    registeredEps,
    failedEps,
  };
}

/**
 * One registration for the process. Every catalog read has to share it: the native
 * catalog is fixed by whichever read arrives first, and a second registration after
 * that read cannot put the missing GPU variants back.
 *
 * A later `onProgress` replaces the previous one so the startup call still hears
 * progress if a catalog read started the work first. A thrown registration clears
 * the latch; a returned result, including partial failure, does not, because
 * retrying after the catalog has already been read cannot change that snapshot.
 */
export function createCatalogRegistrationGate(register) {
  let pending = null;
  let progress = null;
  return {
    ensure(onProgress) {
      if (typeof onProgress === 'function') progress = onProgress;
      if (!pending) {
        // Start synchronously so a second caller in the same turn joins this
        // attempt instead of passing the catalog read before registration exists.
        let started;
        try {
          started = Promise.resolve(register((name, pct) => progress?.(name, pct)));
        } catch (error) {
          return Promise.reject(error);
        }
        pending = started.catch((error) => {
          pending = null;
          throw error;
        });
      }
      return pending;
    },
  };
}
