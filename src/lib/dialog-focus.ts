/**
 * Keep keyboard focus inside one open dialog.
 * `default` means the browser's own Tab move stays inside the dialog.
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export type DialogTabTrap =
  | { action: 'default' }
  | { action: 'focus'; element: HTMLElement };

export function dialogFocusable(container: ParentNode): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter((element) => (
    !element.hasAttribute('disabled') && element.tabIndex >= 0
  ));
}

function canHoldFocus(element: EventTarget | null): element is HTMLElement {
  return element instanceof HTMLElement
    && element.isConnected
    && !element.hasAttribute('disabled')
    && element.tabIndex >= 0
    && !element.closest('[hidden]');
}

/**
 * The control that opened the dialog may be disabled once the action starts.
 * A disabled control cannot keep focus, so an enabled fallback is used instead.
 */
export function restoreDialogFocus(
  saved: EventTarget | null,
  fallbacks: readonly HTMLElement[] = [],
): HTMLElement | null {
  if (canHoldFocus(saved)) return saved;
  return fallbacks.find((element) => canHoldFocus(element)) ?? null;
}

export function dialogTabTrap(
  active: EventTarget | null,
  container: HTMLElement,
  focusable: readonly HTMLElement[],
  shiftKey: boolean,
): DialogTabTrap {
  if (focusable.length === 0) return { action: 'focus', element: container };
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const inside = active instanceof Node && container.contains(active);
  if (!inside) return { action: 'focus', element: shiftKey ? last : first };
  const index = active instanceof HTMLElement ? focusable.indexOf(active) : -1;
  if (index < 0) return { action: 'focus', element: shiftKey ? last : first };
  if (shiftKey && index === 0) return { action: 'focus', element: last };
  if (!shiftKey && index === focusable.length - 1) return { action: 'focus', element: first };
  return { action: 'default' };
}

/** A second click inside this window still belongs to the gesture that answered the previous prompt. */
export const CONSENT_POINTER_LATCH_MS = 500;

const CONSENT_ACTIVATION_KEYS = new Set(['Enter', ' ', 'Escape']);

/**
 * The first press may activate the focused consent control.
 * That key stays held until keyup, so a repeat cannot approve the next prompt.
 */
export function consentKeyGate(
  held: ReadonlySet<string>,
  key: string,
  repeat: boolean,
): { allow: boolean; held: Set<string> } {
  const next = new Set(held);
  if (!CONSENT_ACTIVATION_KEYS.has(key)) return { allow: true, held: next };
  next.add(key);
  return { allow: !repeat && !held.has(key), held: next };
}

export function releaseConsentKey(held: ReadonlySet<string>, key: string): Set<string> {
  if (!held.has(key)) return new Set(held);
  const next = new Set(held);
  next.delete(key);
  return next;
}

export function latchConsentPointer(now: number, windowMs = CONSENT_POINTER_LATCH_MS): number {
  return now + windowMs;
}

export function consentPointerAllows(latchedUntil: number, now: number): boolean {
  return now >= latchedUntil;
}
