/** One provider, ignoring ExecutionProvider spelling differences. */
function providerKey(name: string): string {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/executionprovider$/i, '')
    .replace(/[^a-z0-9]/g, '');
}

function uniqueProviders(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const name of names) {
    const key = providerKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(name);
  }
  return unique;
}

export interface ProviderRecheckRegistration {
  success?: boolean;
  status?: string;
  failedEps?: string[];
  removedProviderCaches?: string[];
  attemptedProviderRebuilds?: string[];
  busyProviderCaches?: string[];
  catalogRefreshRequiresRestart?: boolean;
  registrationDeferredUntilRestart?: boolean;
}

export interface ProviderRecheckRow {
  name?: string | null;
  isRegistered?: boolean;
}

export interface ProviderRecheckStatus {
  message: string;
  failed: boolean;
}

/**
 * Status after Recheck's follow-up provider read. The registration envelope is
 * what was attempted; the refreshed list is who is registered now.
 */
export function providerRecheckStatus(
  registration: ProviderRecheckRegistration | null | undefined,
  providers: readonly ProviderRecheckRow[],
): ProviderRecheckStatus {
  if (registration?.registrationDeferredUntilRestart) {
    return {
      failed: true,
      message: 'Provider rebuild was deferred because the catalog snapshot is unconfirmed. Restart Flint before rechecking providers.',
    };
  }
  const restart = registration?.catalogRefreshRequiresRestart
    ? ' Restart Flint to refresh the model catalog.'
    : '';
  const registered = new Set(
    providers
      .filter((provider) => provider.isRegistered && provider.name)
      .map((provider) => providerKey(String(provider.name))),
  );
  const removed = uniqueProviders(registration?.removedProviderCaches ?? []);
  const busy = uniqueProviders(registration?.busyProviderCaches ?? []);
  const rebuilt = uniqueProviders(
    [...(registration?.attemptedProviderRebuilds ?? []), ...removed].filter((name) =>
      registered.has(providerKey(name)),
    ),
  );
  const stillFailed = uniqueProviders(
    [
      ...(registration?.failedEps ?? []),
      ...(registration?.attemptedProviderRebuilds ?? []),
      ...removed,
      ...busy,
    ].filter((name) => !registered.has(providerKey(name))),
  );
  const locked = busy.length
    ? ` Left in place because a file is in use: ${busy.join(', ')}.`
    : '';
  if (stillFailed.length) {
    const considered = new Set(
      [...(registration?.attemptedProviderRebuilds ?? []), ...removed, ...busy].map(providerKey),
    );
    const repairFailed = stillFailed.filter((name) => considered.has(providerKey(name)));
    const unavailable = stillFailed.filter((name) => !considered.has(providerKey(name)));
    const details = [
      ...(rebuilt.length ? [`Rebuilt ${rebuilt.join(', ')}.`] : []),
      ...(repairFailed.length ? [`Provider rebuild failed for ${repairFailed.join(', ')}.`] : []),
      ...(unavailable.length ? [`Providers still unavailable: ${unavailable.join(', ')}.`] : []),
    ].join(' ');
    return {
      failed: true,
      message: `${details}${locked}${restart}`,
    };
  }
  if (rebuilt.length) {
    return { failed: false, message: `Rebuilt ${rebuilt.join(', ')}.${locked}${restart}` };
  }
  const ready = providers.filter((provider) => provider.isRegistered === true).length;
  return {
    failed: false,
    message: `${ready} execution provider${ready === 1 ? '' : 's'} ready.${locked}${restart}`,
  };
}
