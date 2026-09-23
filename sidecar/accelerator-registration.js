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

// Module-private and non-enumerable so callers receive the SDK-shaped result while
// the gate can distinguish an empty-discovery fallback failure from other retries.
// The register callback must return this result object unchanged.
const retryLegacyFallback = Symbol('retryLegacyFallback');

function markLegacyFallbackRetry(result) {
  const retryableFallback = { ...result, retry: true };
  Object.defineProperty(retryableFallback, retryLegacyFallback, { value: true });
  return retryableFallback;
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

  let usedLegacyFallback = false;
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
    usedLegacyFallback = true;
    if (!discoveredProviders(manager).some((provider) => providerName(provider))) {
      if (fallback?.success === false) {
        return markLegacyFallbackRetry(fallback);
      }
      return fallback;
    }
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
  const result = {
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
  return !success && usedLegacyFallback ? markLegacyFallbackRetry(result) : result;
}

/** Discovery attempts before a catalog read. A failed final fallback gets one additional bounded fallback retry. */
const CATALOG_REGISTRATION_ATTEMPTS = 3;

/**
 * The bounded attempts are spent. Callers must be able to read the catalog anyway.
 * A thrown last attempt used to clear the gate, so every later list, load, and
 * service start ran the same bounded failures and never got that far. Providers
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
 * Registration before the first catalog read, including one final bounded retry
 * when the delayed no-discovery fallback itself fails.
 *
 * Catalog readers share one cycle: an empty discovery or a failed download is tried
 * again inside that cycle, and a terminal failure is kept so later readers are not
 * sent through the same failures. Once a catalog read commits, the
 * snapshot cannot gain providers, so `ensure` does not run again.
 *
 * Settings can call `rerun` before or after that commit. Startup's
 * `ensureAccelerators` is that same command, and the button calls it again. Before
 * commitment, the result can affect the catalog snapshot. After commitment, the
 * provider update still runs, but callers must treat new catalog variants as
 * restart-bound because the current snapshot cannot gain them. If a native listener
 * was exposed without a confirmed read, updates are deferred instead: the listener
 * may be freezing the snapshot outside this queue.
 *
 * Work is serialized through the actual first catalog read. A read queued behind
 * an explicit retry waits for it, and an update queued behind that read cannot
 * register providers while the runtime freezes its snapshot.
 */
export function createCatalogRegistrationGate(register, commitCatalog) {
  let settled = null;
  let hasSettled = false;
  let committed = false;
  let commitConfirmed = false;
  /** @type {Promise<unknown>} */
  let tail = Promise.resolve();
  /** @type {Set<Promise<unknown>>} */
  const activeReads = new Set();

  // `report` is the caller that queued this cycle. A later Settings click must not
  // steal these events: the UI stall watchdog for the in-flight command only resets
  // when progress arrives on that command's id.
  async function attempts(report) {
    const notify = typeof report === 'function' ? report : () => {};
    let last = null;
    for (let attempt = 1; attempt <= CATALOG_REGISTRATION_ATTEMPTS; attempt++) {
      try {
        const current = await register(
          (name, pct) => notify(name, pct),
          { allowLegacyFallback: attempt === CATALOG_REGISTRATION_ATTEMPTS },
        );
        last = preserveRegisteredProviders(last, current);
      } catch (error) {
        if (attempt === CATALOG_REGISTRATION_ATTEMPTS) {
          try {
            const finalRetry = await register(
              (name, pct) => notify(name, pct),
              { allowLegacyFallback: true },
            );
            return preserveRegisteredProviders(last, finalRetry);
          } catch (retryError) {
            return terminalRegistrationResult(last, retryError);
          }
        }
        continue;
      }
      if (!last?.retry) return last;
    }
    if (last?.[retryLegacyFallback]) {
      try {
        const fallbackRetry = await register(
          (name, pct) => notify(name, pct),
          { allowLegacyFallback: true },
        );
        return preserveRegisteredProviders(last, fallbackRetry);
      } catch (error) {
        return terminalRegistrationResult(last, error);
      }
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

  function trackRead(read) {
    activeReads.add(read);
    void read.then(
      () => activeReads.delete(read),
      () => activeReads.delete(read),
    );
    return read;
  }

  function runTrackedReadAfter(waitFor, operation) {
    let read;
    read = waitFor.then(() => {
      activeReads.add(read);
      return operation();
    });
    void read.then(
      () => activeReads.delete(read),
      () => activeReads.delete(read),
    );
    return read;
  }

  function runTrackedReadNow(operation) {
    return trackRead(Promise.resolve().then(() => operation()));
  }

  function preserveRegisteredProviders(previous, current) {
    if (!current || typeof current !== 'object') {
      return previous && typeof previous === 'object' ? previous : current;
    }
    if (!previous || typeof previous !== 'object') {
      return current;
    }
    const currentRegistered = new Set(
      Array.isArray(current.registeredEps) ? current.registeredEps : [],
    );
    const currentFailed = new Set(
      (Array.isArray(current.failedEps) ? current.failedEps : [])
        .filter((name) => !currentRegistered.has(name)),
    );
    const registeredEps = [...new Set([
      ...(Array.isArray(previous.registeredEps) ? previous.registeredEps : [])
        .filter((name) => !currentFailed.has(name)),
      ...currentRegistered,
    ])];
    const failedEps = [...currentFailed];
    const merged = {
      ...current,
      registeredEps,
      failedEps,
    };
    if (
      typeof current.status === 'string' &&
      (
        registeredEps.length !== currentRegistered.size ||
        failedEps.length !== (Array.isArray(current.failedEps) ? current.failedEps.length : 0)
      )
    ) {
      if (current.success === true) {
        merged.status = `Registered ${registeredEps.length} execution provider${
          registeredEps.length === 1 ? '' : 's'
        }`;
      } else {
        const generatedFailure = current.status.match(/^Registered \d+; failed \d+:(.*)$/);
        if (generatedFailure) {
          merged.status = `Registered ${registeredEps.length}; failed ${failedEps.length}:${
            generatedFailure[1]
          }`;
        }
      }
    }
    if (current[retryLegacyFallback]) {
      Object.defineProperty(merged, retryLegacyFallback, { value: true });
    }
    return merged;
  }

  async function ensureSettled(report) {
    if (!hasSettled) {
      settled = await attempts(report);
      hasSettled = true;
    }
    return settled;
  }

  async function confirmCatalogCommit() {
    if (commitConfirmed || typeof commitCatalog !== 'function') return;
    await commitOperation(commitCatalog);
  }

  async function commitOperation(operation) {
    try {
      const result = await operation();
      commitConfirmed = true;
      return result;
    } finally {
      // A rejected native read does not establish whether the immutable
      // snapshot was taken. Treat any attempted read as committed for
      // restart reporting, but retry it inside this queue until one is
      // confirmed so no later catalog caller races provider setup.
      committed = true;
    }
  }

  return {
    ensure(onProgress) {
      const report = typeof onProgress === 'function' ? onProgress : null;
      return enqueue(async () => {
        return ensureSettled(report);
      });
    },
    rerun(onProgress) {
      const report = typeof onProgress === 'function' ? onProgress : null;
      return enqueue(async () => {
        const catalogRefreshRequiresRestart = committed;
        if (committed && !commitConfirmed) {
          return {
            ...(settled && typeof settled === 'object' ? settled : {}),
            success: false,
            status: 'Accelerator update deferred because Flint cannot confirm whether the model catalog snapshot has already been taken. Restart Flint to apply provider changes.',
            catalogRefreshRequiresRestart: true,
            registrationDeferredUntilRestart: true,
          };
        }
        settled = preserveRegisteredProviders(settled, await attempts(report));
        hasSettled = true;
        if (
          catalogRefreshRequiresRestart &&
          settled &&
          typeof settled === 'object'
        ) {
          settled = { ...settled, catalogRefreshRequiresRestart: true };
        }
        return settled;
      });
    },
    commit(onProgress) {
      const report = typeof onProgress === 'function' ? onProgress : null;
      return enqueue(async () => {
        await ensureSettled(report);
        await confirmCatalogCommit();
        return settled;
      });
    },
    read(operation, onProgress) {
      if (typeof operation !== 'function') {
        return Promise.reject(new TypeError('read requires a catalog operation'));
      }
      // Confirmed reads run concurrently, but remain ordered against local mutations.
      if (commitConfirmed) {
        return runTrackedReadAfter(tail, operation);
      }
      const report = typeof onProgress === 'function' ? onProgress : null;
      return enqueue(async () => {
        await ensureSettled(report);
        if (commitConfirmed) return { runOutsideQueue: true };
        return { runOutsideQueue: false, result: await commitOperation(operation) };
      }).then((outcome) => (
        outcome.runOutsideQueue ? runTrackedReadNow(operation) : outcome.result
      ));
    },
    isCommitConfirmed() {
      return commitConfirmed;
    },
    mutateAndCommit(operation, onCommitError, onProgress) {
      if (typeof onCommitError !== 'function') {
        return Promise.reject(new TypeError('mutateAndCommit requires an onCommitError handler'));
      }
      const report = typeof onProgress === 'function' ? onProgress : null;
      return enqueue(async () => {
        await ensureSettled(report);
        const readsBeforeMutation = [...activeReads];
        await Promise.allSettled(readsBeforeMutation);
        let catalogRefreshRequiresRestart = committed;
        const result = await operation();
        try {
          await confirmCatalogCommit();
        } catch (error) {
          // The local mutation is already durable. Report snapshot uncertainty
          // separately so callers do not mistake a read failure for a failed mutation.
          onCommitError(error);
          catalogRefreshRequiresRestart = true;
        }
        return {
          result,
          ...(catalogRefreshRequiresRestart ? { catalogRefreshRequiresRestart: true } : {}),
        };
      });
    },
    seal(onProgress) {
      const report = typeof onProgress === 'function' ? onProgress : null;
      return enqueue(async () => {
        await ensureSettled(report);
        // The native listener can perform the first read outside this process.
        // Close the provider boundary without contacting the registry. Until a
        // later JS read confirms the snapshot, rerun must defer rather than
        // registering beside a possible listener-owned first read.
        committed = true;
        return settled;
      });
    },
  };
}
