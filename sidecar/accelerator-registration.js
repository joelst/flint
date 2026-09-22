function errorMessage(error) {
  return error?.message || String(error);
}

function discoveredProviders(manager) {
  if (typeof manager?.discoverEps !== 'function') return [];
  const providers = manager.discoverEps();
  return Array.isArray(providers) ? providers : [];
}

/**
 * Register every provider the runtime discovered before the catalog is first read.
 *
 * SDK 2.0.1's no-argument registration selects one preferred provider. The native
 * catalog is then fixed on first access, so aliases without that provider's build
 * permanently fall back to CPU for the process. Register providers independently
 * so one failure does not hide successful accelerators.
 */
export async function registerDiscoveredExecutionProviders(manager, onProgress) {
  if (typeof manager?.downloadAndRegisterEps !== 'function') return null;

  const initial = discoveredProviders(manager);
  if (initial.length === 0) {
    return await manager.downloadAndRegisterEps(onProgress);
  }

  const registered = new Set(
    initial.filter((provider) => provider?.isRegistered).map((provider) => provider.name),
  );
  const failures = new Map();

  for (const provider of initial) {
    const name = String(provider?.name || '').trim();
    if (!name || registered.has(name)) continue;

    try {
      const result = await manager.downloadAndRegisterEps([name], onProgress);
      for (const registeredName of result?.registeredEps ?? []) {
        registered.add(registeredName);
        failures.delete(registeredName);
      }
      for (const failedName of result?.failedEps ?? []) {
        failures.set(failedName, result?.status || 'registration failed');
      }
      if (result?.success === false && !registered.has(name) && !failures.has(name)) {
        failures.set(name, result.status || 'registration failed');
      }
    } catch (error) {
      failures.set(name, errorMessage(error));
    }

    for (const current of discoveredProviders(manager)) {
      if (current?.isRegistered && current.name) {
        registered.add(current.name);
        failures.delete(current.name);
      }
    }
  }

  for (const provider of discoveredProviders(manager)) {
    const name = String(provider?.name || '').trim();
    if (!name) continue;
    if (provider.isRegistered) {
      registered.add(name);
      failures.delete(name);
    } else if (!failures.has(name)) {
      failures.set(name, 'runtime did not confirm registration');
    }
  }

  const registeredEps = [...registered];
  const failedEps = [...failures.keys()];
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
