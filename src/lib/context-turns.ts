/**
 * Context-turns bounds and recommendation math, extracted so it is unit-testable independent
 * of `+page.svelte` (which is `@ts-nocheck` and unverified by the compiler).
 *
 * The Context control is a continuous slider bounded by [MIN_CONTEXT_TURNS, MAX_CONTEXT_TURNS];
 * a fixed set of preset options (the old <select>) could not represent every value this
 * recommendation produces, which left the control showing blank whenever a model's recommended
 * turn count fell outside the preset list.
 */

export const MIN_CONTEXT_TURNS = 4;
export const MAX_CONTEXT_TURNS = 40;

/**
 * Rough recommended turn count from a model's context length (very conservative).
 * Returns a fallback of 12 when the context length is unknown.
 */
export function recommendedMaxTurns(contextLength: number | null | undefined): number {
  if (!contextLength) return 12;
  // Very rough: assume ~250-350 tokens per turn (user + assistant avg).
  const estTokensPerTurn = 300;
  const safeBudget = Math.floor(contextLength * 0.6); // leave headroom for system + generation
  return clampContextTurns(Math.floor(safeBudget / estTokensPerTurn));
}

/** Clamp a turn count to the slider's supported range. */
export function clampContextTurns(turns: number): number {
  return Math.max(MIN_CONTEXT_TURNS, Math.min(MAX_CONTEXT_TURNS, turns));
}
