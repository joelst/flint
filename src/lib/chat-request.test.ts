import { describe, it, expect } from 'vitest';
import {
  toPromptParts,
  fromPromptParts,
  mergePromptParts,
  normalizeForAlternatingChat,
  isEmptyAssistantPlaceholder,
  hasSendableContent,
  DEFAULT_INSTRUCTION_PREFIX,
  type PromptPart,
} from './chat-request';
import { OPAQUE_PART_TYPE } from './conversation-store';

const text = (t: string): PromptPart => ({ type: 'text', text: t });
const image = (url: string): PromptPart => ({ type: 'image_url', image_url: { url } });

describe('toPromptParts', () => {
  it('wraps a string as a single text part', () => {
    expect(toPromptParts('hello')).toEqual([text('hello')]);
  });

  it('trims the ends of a string but keeps interior formatting', () => {
    expect(toPromptParts('  line one\n\n    indented  ')).toEqual([text('line one\n\n    indented')]);
  });

  it('drops empty and whitespace-only content', () => {
    expect(toPromptParts('')).toEqual([]);
    expect(toPromptParts('   \n ')).toEqual([]);
    expect(toPromptParts([])).toEqual([]);
  });

  it('keeps text and image parts in order', () => {
    expect(toPromptParts([text('what is this'), image('data:image/png;base64,AAA')])).toEqual([
      text('what is this'),
      image('data:image/png;base64,AAA'),
    ]);
  });

  it('drops a part a newer build stored that this one cannot describe to a model', () => {
    const parts = toPromptParts([
      text('keep'),
      { type: OPAQUE_PART_TYPE, original: { type: 'audio_url', audio_url: { url: 'x' } } },
    ]);
    expect(parts).toEqual([text('keep')]);
  });

  it('skips a malformed text part instead of coercing it', () => {
    // `String(123)` would invent text the user never wrote.
    expect(toPromptParts([{ type: 'text', text: 123 }, text('real')])).toEqual([text('real')]);
  });

  it('keeps array text parts byte for byte', () => {
    // A part is a fragment of a larger message; trimming one re-indents code split across
    // parts, and dropping a whitespace-only one deletes a deliberate blank line.
    expect(toPromptParts([text('  indented  '), text('\n\n'), text('next')])).toEqual([
      text('  indented  '),
      text('\n\n'),
      text('next'),
    ]);
  });

  it('drops only an empty-string text part', () => {
    expect(toPromptParts([text(''), text('kept')])).toEqual([text('kept')]);
  });

  it('skips an image part with no usable url', () => {
    for (const bad of [{ type: 'image_url' }, { type: 'image_url', image_url: {} }, { type: 'image_url', image_url: { url: '' } }]) {
      expect(toPromptParts([bad, text('real')])).toEqual([text('real')]);
    }
  });

  it('skips a part that is not an object at all', () => {
    expect(toPromptParts([null, 'loose string', 7, text('real')])).toEqual([text('real')]);
  });

  it('returns nothing for content that is neither a string nor an array', () => {
    for (const bad of [null, undefined, 7, true, { type: 'text', text: 'x' }]) {
      expect(toPromptParts(bad)).toEqual([]);
    }
  });
});

describe('fromPromptParts', () => {
  it('collapses text-only content to a string', () => {
    // A text-only model is entitled to reject a parts array, so the narrowest shape wins.
    expect(fromPromptParts([text('hello')])).toBe('hello');
  });

  it('concatenates text parts of one message without adding a separator', () => {
    // These are fragments of a single message, not separate turns. Any real turn boundary was
    // already fused into one part by `mergePromptParts`.
    expect(fromPromptParts([text('a'), text('b')])).toBe('ab');
  });

  it('preserves indentation across split parts', () => {
    // Inserting a blank line here would silently re-indent the code the user pasted.
    expect(fromPromptParts([text('if enabled:\n'), text('    execute()\n')]))
      .toBe('if enabled:\n    execute()\n');
  });

  it('keeps a whitespace-only part between two text parts', () => {
    expect(fromPromptParts([text('a'), text('\n\n'), text('b')])).toBe('a\n\nb');
  });

  it('returns null when the parts hold only whitespace', () => {
    expect(fromPromptParts([text('  '), text('\n')])).toBeNull();
  });

  it('keeps structure when an image is present', () => {
    const parts = [text('a'), image('u')];
    expect(fromPromptParts(parts)).toEqual(parts);
  });

  it('keeps structure for an image with no text', () => {
    expect(fromPromptParts([image('u')])).toEqual([image('u')]);
  });

  it('returns null for nothing to send', () => {
    expect(fromPromptParts([])).toBeNull();
  });
});

describe('mergePromptParts', () => {
  it('joins adjacent text into one part rather than leaving two', () => {
    // Parts are concatenated without a separator downstream, so leaving them apart would run
    // the end of one turn into the start of the next.
    expect(mergePromptParts([text('a')], [text('b')])).toEqual([text('a\n\nb')]);
  });

  it('does not merge across an image boundary', () => {
    expect(mergePromptParts([text('a'), image('u')], [text('b')])).toEqual([
      text('a'),
      image('u'),
      text('b'),
    ]);
  });

  it('concatenates when the second side starts with an image', () => {
    expect(mergePromptParts([text('a')], [image('u'), text('b')])).toEqual([
      text('a'),
      image('u'),
      text('b'),
    ]);
  });

  it('handles an empty side', () => {
    expect(mergePromptParts([], [text('b')])).toEqual([text('b')]);
    expect(mergePromptParts([text('a')], [])).toEqual([text('a')]);
    expect(mergePromptParts([], [])).toEqual([]);
  });

  it('does not mutate either input', () => {
    const a = [text('a')];
    const b = [text('b')];
    mergePromptParts(a, b);
    expect(a).toEqual([text('a')]);
    expect(b).toEqual([text('b')]);
  });
});

describe('normalizeForAlternatingChat', () => {
  it('passes a clean alternating thread through unchanged', () => {
    const out = normalizeForAlternatingChat([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' },
    ]);
    expect(out).toEqual([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' },
    ]);
  });

  describe('multipart content is never stringified', () => {
    it('folds a system instruction into a vision turn without destroying it', () => {
      // The original bug: interpolating the array produced "[object Object]", losing the text
      // and the image together, on every vision request that had a system prompt.
      const out = normalizeForAlternatingChat(
        [{ role: 'user', content: [text('what is this?'), image('data:image/png;base64,AAA')] }],
        { systemInstruction: 'Be concise' },
      );
      expect(out).toEqual([
        {
          role: 'user',
          content: [
            text(`${DEFAULT_INSTRUCTION_PREFIX}\nBe concise\n\nwhat is this?`),
            image('data:image/png;base64,AAA'),
          ],
        },
      ]);
      expect(JSON.stringify(out)).not.toContain('[object Object]');
    });

    it('merges two consecutive vision turns structurally', () => {
      // Reachable whenever a failed turn is filtered out from between two user turns.
      const out = normalizeForAlternatingChat([
        { role: 'user', content: [text('first'), image('a')] },
        { role: 'user', content: [text('second'), image('b')] },
      ]);
      expect(out).toEqual([
        { role: 'user', content: [text('first'), image('a'), text('second'), image('b')] },
      ]);
      expect(JSON.stringify(out)).not.toContain('[object Object]');
    });

    it('merges a string turn into a vision turn', () => {
      const out = normalizeForAlternatingChat([
        { role: 'user', content: 'describe this' },
        { role: 'user', content: [image('a')] },
      ]);
      expect(out).toEqual([{ role: 'user', content: [text('describe this'), image('a')] }]);
    });

    it('merges a vision turn into a string turn and keeps the image', () => {
      const out = normalizeForAlternatingChat([
        { role: 'user', content: [text('look'), image('a')] },
        { role: 'user', content: 'and tell me why' },
      ]);
      expect(out).toEqual([
        { role: 'user', content: [text('look'), image('a'), text('and tell me why')] },
      ]);
    });

    it('collapses a text-only array to a string', () => {
      const out = normalizeForAlternatingChat([{ role: 'user', content: [text('only text')] }]);
      expect(out).toEqual([{ role: 'user', content: 'only text' }]);
    });

    it('drops an opaque part before it can reach the model', () => {
      const out = normalizeForAlternatingChat([
        { role: 'user', content: [text('hi'), { type: OPAQUE_PART_TYPE, original: { x: 1 } }] },
      ]);
      expect(out).toEqual([{ role: 'user', content: 'hi' }]);
    });
  });

  describe('system instructions', () => {
    it('folds into the first user turn rather than sending a system role', () => {
      const out = normalizeForAlternatingChat(
        [{ role: 'user', content: 'hi' }],
        { systemInstruction: 'Be brief' },
      );
      expect(out).toEqual([
        { role: 'user', content: `${DEFAULT_INSTRUCTION_PREFIX}\nBe brief\n\nhi` },
      ]);
    });

    it('collects system turns from the thread as well', () => {
      const out = normalizeForAlternatingChat(
        [
          { role: 'system', content: 'From the thread' },
          { role: 'user', content: 'hi' },
        ],
        { systemInstruction: 'From the prompt' },
      );
      expect(out[0].content).toBe(
        `${DEFAULT_INSTRUCTION_PREFIX}\nFrom the prompt\n\nFrom the thread\n\nhi`,
      );
      expect(out).toHaveLength(1);
    });

    it('creates a leading user turn when the thread opens with an assistant turn', () => {
      const out = normalizeForAlternatingChat(
        [{ role: 'assistant', content: 'greeting' }],
        { systemInstruction: 'Be brief' },
      );
      expect(out).toEqual([
        { role: 'user', content: `${DEFAULT_INSTRUCTION_PREFIX}\nBe brief` },
        { role: 'assistant', content: 'greeting' },
      ]);
    });

    it('ignores a blank instruction rather than sending an empty preamble', () => {
      const out = normalizeForAlternatingChat([{ role: 'user', content: 'hi' }], {
        systemInstruction: '   ',
      });
      expect(out).toEqual([{ role: 'user', content: 'hi' }]);
    });

    it('keeps only the text of a system turn that somehow carries an image', () => {
      const out = normalizeForAlternatingChat([
        { role: 'system', content: [text('rules'), image('u')] },
        { role: 'user', content: 'hi' },
      ]);
      expect(out).toEqual([
        { role: 'user', content: `${DEFAULT_INSTRUCTION_PREFIX}\nrules\n\nhi` },
      ]);
    });

    it('honours a custom prefix', () => {
      const out = normalizeForAlternatingChat([{ role: 'user', content: 'hi' }], {
        systemInstruction: 'x',
        instructionPrefix: 'System:',
      });
      expect(out[0].content).toBe('System:\nx\n\nhi');
    });

    it('does not fold into a leading assistant turn', () => {
      const out = normalizeForAlternatingChat(
        [
          { role: 'assistant', content: 'a' },
          { role: 'user', content: 'u' },
        ],
        { systemInstruction: 'rules' },
      );
      // The leading assistant turn is dropped by the alternation rule, and the instruction
      // becomes the opening user turn rather than being lost with it.
      expect(out).toEqual([
        { role: 'user', content: `${DEFAULT_INSTRUCTION_PREFIX}\nrules` },
        { role: 'assistant', content: 'a' },
        { role: 'user', content: 'u' },
      ]);
    });
  });

  describe('roles that cannot be replayed', () => {
    it('drops a tool turn', () => {
      // A faithful tool turn carries call linkage this build does not model, so replaying it
      // would produce a structurally invalid request.
      const out = normalizeForAlternatingChat([
        { role: 'user', content: 'u' },
        { role: 'tool', content: '{"result":1}' },
        { role: 'assistant', content: 'a' },
      ]);
      expect(out).toEqual([
        { role: 'user', content: 'u' },
        { role: 'assistant', content: 'a' },
      ]);
    });

    it('drops a role from a newer build rather than guessing at it', () => {
      const out = normalizeForAlternatingChat([
        { role: 'user', content: 'u' },
        { role: 'developer', content: 'unknown meaning' },
      ]);
      expect(out).toEqual([{ role: 'user', content: 'u' }]);
    });

    it('merges the turns a dropped role was sitting between', () => {
      const out = normalizeForAlternatingChat([
        { role: 'user', content: 'first' },
        { role: 'tool', content: 'ignored' },
        { role: 'user', content: 'second' },
      ]);
      expect(out).toEqual([{ role: 'user', content: 'first\n\nsecond' }]);
    });

    it('drops a message with no usable role', () => {
      const out = normalizeForAlternatingChat([
        { content: 'no role' },
        { role: null, content: 'x' },
        { role: 'user', content: 'u' },
      ]);
      expect(out).toEqual([{ role: 'user', content: 'u' }]);
    });
  });

  describe('alternation', () => {
    it('drops a leading assistant turn', () => {
      const out = normalizeForAlternatingChat([
        { role: 'assistant', content: 'orphan' },
        { role: 'user', content: 'u' },
      ]);
      expect(out).toEqual([{ role: 'user', content: 'u' }]);
    });

    it('merges consecutive assistant turns', () => {
      const out = normalizeForAlternatingChat([
        { role: 'user', content: 'u' },
        { role: 'assistant', content: 'one' },
        { role: 'assistant', content: 'two' },
      ]);
      expect(out).toEqual([
        { role: 'user', content: 'u' },
        { role: 'assistant', content: 'one\n\ntwo' },
      ]);
    });

    it('produces strict alternation from a heavily damaged thread', () => {
      const out = normalizeForAlternatingChat([
        { role: 'assistant', content: 'lead' },
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
        { role: 'assistant', content: 'c' },
        { role: 'tool', content: 'x' },
        { role: 'assistant', content: 'd' },
        { role: 'user', content: 'e' },
      ]);
      expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
      expect(out[0].content).toBe('a\n\nb');
      expect(out[1].content).toBe('c\n\nd');
    });

    it('does not leave an empty turn behind when content vanishes', () => {
      const out = normalizeForAlternatingChat([
        { role: 'user', content: 'u' },
        { role: 'assistant', content: '   ' },
        { role: 'user', content: 'v' },
      ]);
      // The blank assistant turn is not sent as an empty message; the two user turns merge.
      expect(out).toEqual([{ role: 'user', content: 'u\n\nv' }]);
    });
  });

  it('returns nothing for an empty or missing thread', () => {
    expect(normalizeForAlternatingChat([])).toEqual([]);
    expect(normalizeForAlternatingChat(undefined as any)).toEqual([]);
  });

  it('never mutates the input messages', () => {
    const messages = [
      { role: 'user', content: [text('a'), image('u')] },
      { role: 'user', content: 'b' },
    ];
    const snapshot = JSON.parse(JSON.stringify(messages));
    normalizeForAlternatingChat(messages, { systemInstruction: 'rules' });
    expect(messages).toEqual(snapshot);
  });
});

describe('isEmptyAssistantPlaceholder', () => {
  it('recognizes the placeholder inserted before a stream starts', () => {
    expect(isEmptyAssistantPlaceholder({ role: 'assistant', content: '' })).toBe(true);
    expect(isEmptyAssistantPlaceholder({ role: 'assistant', content: '  ' })).toBe(true);
    expect(isEmptyAssistantPlaceholder({ role: 'assistant', content: [] })).toBe(true);
  });

  it('does not treat a real assistant turn as a placeholder', () => {
    expect(isEmptyAssistantPlaceholder({ role: 'assistant', content: 'hi' })).toBe(false);
  });

  it('does not throw on multipart content', () => {
    // `content?.trim()` threw here: an array has no `trim`.
    expect(() =>
      isEmptyAssistantPlaceholder({ role: 'assistant', content: [text('a')] }),
    ).not.toThrow();
    expect(isEmptyAssistantPlaceholder({ role: 'assistant', content: [text('a')] })).toBe(false);
  });

  it('is false for any other role', () => {
    expect(isEmptyAssistantPlaceholder({ role: 'user', content: '' })).toBe(false);
    expect(isEmptyAssistantPlaceholder({} as any)).toBe(false);
  });
});

describe('within-message text is never reformatted', () => {
  // A message may hold several text parts. They are fragments of one piece of writing, so the
  // builder must join them exactly as written — while still separating genuine turns.

  it('sends code split across parts with its indentation intact', () => {
    const out = normalizeForAlternatingChat([
      { role: 'user', content: [text('if enabled:\n'), text('    execute()\n')] },
    ]);
    expect(out).toEqual([{ role: 'user', content: 'if enabled:\n    execute()\n' }]);
  });

  it('still separates two merged turns with a blank line', () => {
    const out = normalizeForAlternatingChat([
      { role: 'user', content: [text('def a():\n'), text('    pass\n')] },
      { role: 'user', content: 'and explain it' },
    ]);
    expect(out).toEqual([
      { role: 'user', content: 'def a():\n    pass\n\n\nand explain it' },
    ]);
  });

  it('keeps a whitespace-only part that separates two fragments', () => {
    const out = normalizeForAlternatingChat([
      { role: 'user', content: [text('para one'), text('\n\n'), text('para two')] },
    ]);
    expect(out).toEqual([{ role: 'user', content: 'para one\n\npara two' }]);
  });

  it('drops a turn whose parts are all whitespace', () => {
    const out = normalizeForAlternatingChat([
      { role: 'user', content: 'real' },
      { role: 'assistant', content: [text('  '), text('\n')] },
      { role: 'user', content: 'also real' },
    ]);
    expect(out).toEqual([{ role: 'user', content: 'real\n\nalso real' }]);
  });

  it('concatenates a multi-part system turn without reformatting it', () => {
    const out = normalizeForAlternatingChat([
      { role: 'system', content: [text('Rules:\n'), text('  - be brief')] },
      { role: 'user', content: 'hi' },
    ]);
    expect(out[0].content).toBe(`${DEFAULT_INSTRUCTION_PREFIX}\nRules:\n  - be brief\n\nhi`);
  });

  it('separates the app prompt from a system turn with a blank line', () => {
    // These come from different sources, so they are turn boundaries and do take a separator.
    const out = normalizeForAlternatingChat(
      [
        { role: 'system', content: 'From the thread' },
        { role: 'user', content: 'hi' },
      ],
      { systemInstruction: 'From the prompt' },
    );
    expect(out[0].content).toBe(
      `${DEFAULT_INSTRUCTION_PREFIX}\nFrom the prompt\n\nFrom the thread\n\nhi`,
    );
  });

  it('folds an instruction into a vision turn without touching the turn text', () => {
    const out = normalizeForAlternatingChat(
      [{ role: 'user', content: [text('  spaced  '), image('u')] }],
      { systemInstruction: 'Be brief' },
    );
    expect(out).toEqual([
      {
        role: 'user',
        content: [text(`${DEFAULT_INSTRUCTION_PREFIX}\nBe brief\n\n  spaced  `), image('u')],
      },
    ]);
  });
});

describe('hasSendableContent', () => {
  it('is false for nothing and for whitespace only', () => {
    expect(hasSendableContent([])).toBe(false);
    expect(hasSendableContent([text('  '), text('\n')])).toBe(false);
  });

  it('is true when any text carries characters', () => {
    expect(hasSendableContent([text('  '), text('x')])).toBe(true);
  });

  it('is true for an image with no text at all', () => {
    expect(hasSendableContent([image('u')])).toBe(true);
  });
});
