/**
 * Opt in to Foundry's packaged shared host. Off by default. The manager is
 * created once per sidecar process, so a change applies the next time that
 * process starts. Flint still uses its own app cache and does not fall back
 * to an in-process manager when the host fails.
 */
export const SHARED_HOST_KEY = 'flint-shared-host';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function readSharedHost(storage: StorageLike | null | undefined): boolean {
  try {
    return storage?.getItem(SHARED_HOST_KEY) === '1';
  } catch {
    return false;
  }
}

/** Returns false when the choice could not be saved. */
export function writeSharedHost(storage: StorageLike | null | undefined, enabled: boolean): boolean {
  if (!storage) return false;
  try {
    if (enabled) storage.setItem(SHARED_HOST_KEY, '1');
    else storage.removeItem(SHARED_HOST_KEY);
    return true;
  } catch {
    return false;
  }
}

export interface SharedHostInitPayload {
  appName: string;
  logLevel: string;
  useSharedHost?: boolean;
}

/** Leave the field unset when the preference is off so the SDK default applies. */
export function initPayloadForSharedHost<T extends SharedHostInitPayload>(
  payload: T,
  enabled: boolean,
): T {
  const next = { ...payload };
  if (enabled) next.useSharedHost = true;
  else delete next.useSharedHost;
  return next;
}
