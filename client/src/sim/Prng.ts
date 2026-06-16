/**
 * Mulberry32 — seeded deterministic PRNG for the simulation.
 *
 * The entire generator state is a single uint32 carried inside `SimState`.
 * All functions are pure: they return `[value, newState]` and the caller MUST
 * thread the new state back into the sim state. Floats produced by
 * `prngFloat` are ONLY for `< rate` comparisons — never store them.
 */

/** Advance the generator once. Returns `[uint32 output, new uint32 state]`. */
export function prngNext(state: number): [number, number] {
  const s = (state + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [(t ^ (t >>> 14)) >>> 0, s];
}

/**
 * Uniform float in [0, 1) — comparison use only (e.g. `v < SOFT_BRICK_RATE`).
 * The float must never be stored in sim state.
 */
export function prngFloat(state: number): [number, number] {
  const [v, s] = prngNext(state);
  return [v / 4294967296, s];
}

/** Uniform integer in [min, maxInclusive]. */
export function prngInt(
  state: number,
  min: number,
  maxInclusive: number,
): [number, number] {
  const [v, s] = prngNext(state);
  const span = maxInclusive - min + 1;
  return [min + (v % span), s];
}
