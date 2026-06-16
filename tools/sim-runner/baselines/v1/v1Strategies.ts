// FROZEN AI v1 — DO NOT EDIT.
// Immutable snapshot of the live BotController (dypm-style single-scoring loop) at the v1 milestone.
// Used only as a versioned benchmark opponent. Never import the live BotController/Strategies here.
/**
 * V1_STRATEGIES — the FROZEN v1 snapshot of the live bot archetypes. The four
 * preset tunings (aggressor/turtle/gambler/chaosv) are inlined VERBATIM from the
 * live Strategies.ts at the v1 milestone. They are deep-frozen so the benchmark
 * opponent's numeric knobs can never drift; the golden lock pins behaviour.
 *
 * This file self-declares the snapshot's version (AI_VERSION = 1) and MUST NOT
 * import the live version.ts.
 */
import type { BotTuning } from '../../../../client/src/ai/BotConfig';

/** The v1 snapshot self-declares its AI version (does NOT import live version.ts). */
export const AI_VERSION = 1;

export const V1_STRATEGIES: ReadonlyArray<{
  key: string;
  name: string;
  tuning: BotTuning;
}> = Object.freeze([
  // Aggressor — bombs at almost every opportunity with sharp reactions and a
  // short escape budget: relentless pressure, trades safety margin for tempo.
  Object.freeze({
    key: 'aggressor',
    name: 'Aggressor',
    tuning: Object.freeze({
      reactionDelayTicks: 3,
      mistakeChance: 0.03,
      replanIntervalTicks: 8,
      maxEscapeLen: 4,
      bombChance: 0.95,
      aggression: 1.8, // relentless pressure.
      recklessBombChance: 0,
    }),
  }),
  // Turtle/Survivor — rarely bombs and demands the longest escape route:
  // plays for outlasting opponents rather than killing them.
  Object.freeze({
    key: 'turtle',
    name: 'Turtle',
    tuning: Object.freeze({
      reactionDelayTicks: 3,
      mistakeChance: 0.04,
      replanIntervalTicks: 8,
      maxEscapeLen: 6,
      bombChance: 0.15,
      aggression: 0.3, // survival-first: minimal attack pull.
      recklessBombChance: 0,
    }),
  }),
  // Gambler/Reckless — sluggish reactions, frequent mistakes, and a real
  // chance of blind-bombing with no escape: high-variance boom-or-bust play.
  Object.freeze({
    key: 'gambler',
    name: 'Gambler',
    tuning: Object.freeze({
      reactionDelayTicks: 12,
      mistakeChance: 0.2,
      replanIntervalTicks: 18,
      maxEscapeLen: 4,
      bombChance: 0.9,
      aggression: 1.3, // high-variance aggression.
      recklessBombChance: 0.25,
    }),
  }),
  // 亂V/ChaosV — instead of single-bomb-and-retreat, lays a short V/zigzag
  // sequence of bombs (paced one per detonation so it never blows itself up)
  // when an enemy is close, walling off escape lanes to corner a fleeing foe.
  // Each chain bomb still passes the FULL escape validation single bombs use;
  // the chain only changes PRIORITY (bomb-again-now vs wander), never safety.
  Object.freeze({
    key: 'chaosv',
    name: '亂V/ChaosV',
    tuning: Object.freeze({
      reactionDelayTicks: 3,
      mistakeChance: 0.04,
      replanIntervalTicks: 8,
      maxEscapeLen: 5,
      bombChance: 0.9,
      aggression: 1.8, // relentless wall-off pressure.
      recklessBombChance: 0,
      vChainBombs: 3,
      vChainChance: 0.8,
      vChainFoeRange: 4,
    }),
  }),
]);

/** The frozen v1 Aggressor preset. */
export const V1_AGGRESSOR = V1_STRATEGIES.find((s) => s.key === 'aggressor')!;
/** The frozen v1 Turtle preset. */
export const V1_TURTLE = V1_STRATEGIES.find((s) => s.key === 'turtle')!;
/** The frozen v1 Gambler preset. */
export const V1_GAMBLER = V1_STRATEGIES.find((s) => s.key === 'gambler')!;
/** The frozen v1 ChaosV preset. */
export const V1_CHAOSV = V1_STRATEGIES.find((s) => s.key === 'chaosv')!;
