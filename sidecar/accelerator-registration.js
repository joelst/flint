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
 * One registration cycle for the process, retried before the first catalog read.
 *
 * An empty discovery or a failed provider download used to be kept forever. The
 * next catalog read then froze the snapshot without the providers a later attempt
 * would have found. Callers share this promise, so none of them read the catalog
 * until the retries are finished. A finished result is kept: another registration
 * after that read cannot put the missing variants back.
 *
 * A later `onProgress` replaces the previous one so the startup call still hears
 * progress if another caller started the work. A thrown registration is not kept,
 * so a later read can try again. A returned result is kept, including a partial
 * failure on the last attempt.
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
          started = (async () => {
            let last = null;
            for (let attempt = 1; attempt <= CATALOG_REGISTRATION_ATTEMPTS; attempt++) {
              try {
                last = await register(
                  (name, pct) => progress?.(name, pct),
                  { allowLegacyFallback: attempt === CATALOG_REGISTRATION_ATTEMPTS },
                );
              } catch (error) {
                if (attempt === CATALOG_REGISTRATION_ATTEMPTS) throw error;
                continue;
              }
              if (!last?.retry) return last;
            }
            return last;
          })();
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
