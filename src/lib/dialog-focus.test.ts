import { describe, expect, it } from 'vitest';
import {
  consentKeyGate,
  consentPointerAllows,
  dialogFocusable,
  dialogTabTrap,
  latchConsentPointer,
  releaseConsentKey,
  restoreDialogFocus,
} from './dialog-focus';

function dialog(): HTMLElement {
  document.body.innerHTML = [
    '<button id="outside"></button>',
    '<div id="dialog" tabindex="-1">',
    '<button id="first"></button>',
    '<button id="middle"></button>',
    '<button id="last"></button>',
    '<button id="disabled" disabled></button>',
    '<a id="skip" tabindex="-1" href="https://example.com/">skip</a>',
    '<a id="link" href="https://example.com/">link</a>',
    '</div>',
  ].join('');
  const element = document.getElementById('dialog');
  if (!element) throw new Error('missing dialog');
  return element;
}

describe('dialog focus', () => {
  it('lists operable controls and skips disabled or untabbable ones', () => {
    const root = dialog();
    expect(dialogFocusable(root).map((element) => element.id)).toEqual([
      'first',
      'middle',
      'last',
      'link',
    ]);
  });

  it('wraps Tab at the ends and pulls outside focus back in', () => {
    const root = dialog();
    const [first, middle, last, link] = dialogFocusable(root);
    const outside = document.getElementById('outside');
    expect(dialogTabTrap(last, root, [first, middle, last, link], false)).toEqual({
      action: 'default',
    });
    expect(dialogTabTrap(link, root, [first, middle, last, link], false)).toEqual({
      action: 'focus',
      element: first,
    });
    expect(dialogTabTrap(first, root, [first, middle, last, link], true)).toEqual({
      action: 'focus',
      element: link,
    });
    expect(dialogTabTrap(outside, root, [first, middle, last, link], false)).toEqual({
      action: 'focus',
      element: first,
    });
    expect(dialogTabTrap(outside, root, [first, middle, last, link], true)).toEqual({
      action: 'focus',
      element: link,
    });
    expect(dialogTabTrap(root, root, [first, middle, last, link], false)).toEqual({
      action: 'focus',
      element: first,
    });
    expect(dialogTabTrap(root, root, [first, middle, last, link], true)).toEqual({
      action: 'focus',
      element: link,
    });
    expect(dialogTabTrap(middle, root, [first, middle, last, link], false)).toEqual({
      action: 'default',
    });
    expect(dialogTabTrap(middle, root, [first, middle, last, link], true)).toEqual({
      action: 'default',
    });
    expect(dialogTabTrap(null, root, [], false)).toEqual({ action: 'focus', element: root });
    expect(dialogTabTrap(null, root, [first, middle, last, link], true)).toEqual({
      action: 'focus',
      element: link,
    });
    const text = document.createTextNode('x');
    root.appendChild(text);
    expect(dialogTabTrap(text, root, [first, middle, last, link], false)).toEqual({
      action: 'focus',
      element: first,
    });
  });

  it('returns focus to an enabled control after the opener is disabled', () => {
    document.body.innerHTML = [
      '<button id="search" disabled>Search</button>',
      '<form>',
      '<button id="stop" class="stop" type="button">Stop</button>',
      '<button id="also-disabled" class="stop" type="button" disabled>Stop</button>',
      '</form>',
      '<div hidden><button id="hidden-stop" class="stop" type="button">Stop</button></div>',
    ].join('');
    const search = document.getElementById('search');
    const stop = document.getElementById('stop');
    const disabledStop = document.getElementById('also-disabled');
    const hiddenStop = document.getElementById('hidden-stop');
    if (!search || !stop || !disabledStop || !hiddenStop) throw new Error('missing controls');
    const fallbacks = [disabledStop, hiddenStop, stop];
    expect(restoreDialogFocus(search, fallbacks)).toBe(stop);
    search.removeAttribute('disabled');
    expect(restoreDialogFocus(search, fallbacks)).toBe(search);
    search.remove();
    expect(restoreDialogFocus(search, fallbacks)).toBe(stop);
    expect(restoreDialogFocus(null, [disabledStop, hiddenStop])).toBeNull();
  });

  it('requires a fresh key and a later click for the next consent prompt', () => {
    const first = consentKeyGate(new Set(), 'Enter', false);
    expect(first.allow).toBe(true);
    expect(first.held.has('Enter')).toBe(true);
    expect(consentKeyGate(first.held, 'Enter', true).allow).toBe(false);
    expect(consentKeyGate(first.held, 'Enter', false).allow).toBe(false);
    const released = releaseConsentKey(first.held, 'Enter');
    expect(consentKeyGate(released, 'Enter', false).allow).toBe(true);
    expect(consentKeyGate(new Set(), 'Escape', true).allow).toBe(false);
    const space = consentKeyGate(new Set(), ' ', false);
    expect(space.allow).toBe(true);
    expect(consentKeyGate(space.held, ' ', true).allow).toBe(false);
    expect(consentKeyGate(new Set(), 'Tab', false)).toEqual({ allow: true, held: new Set() });

    expect(consentPointerAllows(0, 1_000)).toBe(true);
    const latched = latchConsentPointer(1_000);
    expect(consentPointerAllows(latched, 1_499)).toBe(false);
    expect(consentPointerAllows(latched, 1_500)).toBe(true);
  });
});
