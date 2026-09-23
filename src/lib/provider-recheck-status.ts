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
  const registered = new Set(
    providers
      .filter((provider) => provider.isRegistered && provider.name)
      .map((provider) => providerKey(String(provider.name))),
  );
  const removed = uniqueProviders(registration?.removedProviderCaches ?? []);
  const busy = uniqueProviders(registration?.busyProviderCaches ?? []);
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
    return {
      failed: true,
      message: `Provider rebuild failed for ${stillFailed.join(', ')}.${locked}`,
    };
  }
  if (removed.length) {
    return { failed: false, message: `Rebuilt ${removed.join(', ')}.${locked}` };
  }
  return {
    failed: false,
    message: `${providers.filter((provider) => provider.isRegistered === true).length} execution providers ready.${locked}`,
  };
}
