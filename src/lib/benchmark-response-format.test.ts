import { describe, expect, it } from 'vitest';
import { extractThinkingTrace } from './message-rendering';
import { presentBenchmarkResponse } from './benchmark-response-format';

const thought = 'The airspeed depends on whether the swallow is African or European.';

describe('presentBenchmarkResponse', () => {
  it('wraps an untagged Qwen reply so the formatted view shows it as thinking', () => {
    const presented = presentBenchmarkResponse(thought, ['qwen3.5-9b', null]);
    const trace = extractThinkingTrace(presented);
    expect(trace.thinkingContent).toEqual([thought]);
    expect(trace.visibleContent).toBe('');
    expect(presented).not.toBe(thought);
  });

  it('does not wrap Qwen2 or a name that only mentions qwen later', () => {
    expect(presentBenchmarkResponse(thought, ['qwen2.5-7b'])).toBe(thought);
    expect(presentBenchmarkResponse(thought, [
      'deepseek-r1-14b',
      'deepseek-r1-distill-qwen-14b-cuda-gpu:4',
    ])).toBe(thought);
  });

  it('wraps an untagged QwQ reply', () => {
    const presented = presentBenchmarkResponse(thought, ['qwq-32b', null]);
    const trace = extractThinkingTrace(presented);
    expect(trace.thinkingContent).toEqual([thought]);
    expect(trace.visibleContent).toBe('');
  });

  it('leaves a Qwen reply that already has think tags unchanged', () => {
    const closed = `${thought}</think>\nBetween 9 and 12 m/s`;
    const open = `<think>${thought}`;
    const thinking = `<thinking>${thought}</thinking> answer`;
    expect(presentBenchmarkResponse(closed, ['Qwen3.5-9b'])).toBe(closed);
    expect(presentBenchmarkResponse(open, ['qwen3.5-9b'])).toBe(open);
    expect(presentBenchmarkResponse(thinking, ['qwen3.5-9b'])).toBe(thinking);
  });

  it('does not treat an ordinary answer as thinking', () => {
    expect(presentBenchmarkResponse(thought, ['deepseek-r1-14b', null, undefined])).toBe(thought);
    expect(presentBenchmarkResponse('   ', ['qwen3.5-9b'])).toBe('   ');
    expect(presentBenchmarkResponse('', ['qwen3.5-9b'])).toBe('');
  });
});
