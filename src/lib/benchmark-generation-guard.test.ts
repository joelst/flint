import { describe, expect, it } from 'vitest';
import { SidecarOperationError } from './operation-outcome';
import { assertBenchmarkGeneration, BENCHMARK_GENERATION_MISMATCH_MESSAGE } from './benchmark-generation-guard';
import { createSidecarBenchmarkTransport } from './benchmark-lifecycle';

describe('assertBenchmarkGeneration', () => {
  it('does not throw when the current generation still matches the bound one', () => {
    expect(() => assertBenchmarkGeneration(5, 5)).not.toThrow();
    expect(() => assertBenchmarkGeneration(0, 0)).not.toThrow();
  });

  it('throws a SidecarOperationError with certainty "unknown" when the generation has changed', () => {
    let thrown: unknown;
    try {
      assertBenchmarkGeneration(6, 5);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SidecarOperationError);
    expect((thrown as SidecarOperationError).certainty).toBe('unknown');
    expect((thrown as SidecarOperationError).message).toContain(BENCHMARK_GENERATION_MISMATCH_MESSAGE);
  });

  it('throws regardless of the direction of the change (respawn count can only increase, but the check is symmetric)', () => {
    expect(() => assertBenchmarkGeneration(5, 6)).toThrow(SidecarOperationError);
  });
});

describe('assertBenchmarkGeneration wired into the chat transport (mid-run respawn)', () => {
  it('halts the run instead of recording a per-attempt failure when the sidecar generation changes between attempts', async () => {
    // Simulates a run bound to generation 1, where a respawn bumps the live generation to 2
    // partway through -- e.g. between two dispatched attempts against an already-loaded target.
    let liveGeneration = 1;
    const boundGeneration = 1;
    const chatCompletion = async () => {
      assertBenchmarkGeneration(liveGeneration, boundGeneration);
      const result = { choices: [{ message: { content: 'ok' } }], servedVariantId: null, usage: undefined };
      assertBenchmarkGeneration(liveGeneration, boundGeneration);
      return result;
    };
    const transport = createSidecarBenchmarkTransport(chatCompletion);
    const request = {
      alias: 'a',
      requestedVariantId: null,
      messages: [{ role: 'user' as const, content: 'hi' }],
    };

    // First attempt: generation still matches -- proceeds normally.
    const first = await transport(request);
    expect(first.ok).toBe(true);

    // Sidecar respawns between attempts (nothing in the transport itself would ever notice this
    // without the generation guard -- chatCompletion has no per-call check of its own).
    liveGeneration = 2;

    const second = await transport(request);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.haltRun).toBe('stopped');
      expect(second.errorMessage).toContain(BENCHMARK_GENERATION_MISMATCH_MESSAGE);
    }
  });
});
