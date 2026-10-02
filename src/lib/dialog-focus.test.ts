import { describe, expect, it } from 'vitest';
import { dialogFocusable, dialogTabTrap } from './dialog-focus';

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
});
