/**
 * Strategies — named, clearly-distinct bot AI archetypes built from the
 * `BotTuning` knobs (see BotConfig.ts). Three archetypes — Aggressor, 亂V/ChaosV,
 * and 調溫/Tempering — occupy different corners of the tuning space; ChaosV and
 * Tempering add the OPTIONAL 亂V chain knobs (vChainBombs/vChainChance/
 * vChainFoeRange). Those extra knobs are purely deterministic — they only change
 * bomb-drop PRIORITY, never the safety gate — so every archetype stays fully
 * lockstep-safe, and any archetype that omits them keeps the exact single-bomb
 * behavior. Tempering embodies the v3 CONNECTIVITY DOCTRINE: develop fully while
 * isolated, then strike relentlessly the instant a path to a foe opens.
 *
 * Reaction is in ticks at the fixed 60 Hz timestep; the bomb fuse is 180 ticks.
 */
import type { BotTuning } from './BotConfig';

export const STRATEGIES: ReadonlyArray<{
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
  // 調溫/Tempering — the purest expression of the connectivity doctrine: while
  // isolated (no open path to any foe) it develops fully — bombing/farming at
  // nearly every opportunity with a slightly longer escape budget so the long
  // farm never self-traps — then, the instant a path to a foe opens, it strikes
  // relentlessly, converting its material lead into kills with 亂V wall-off chains.
  Object.freeze({
    key: 'tempering',
    name: '調溫/Tempering',
    tuning: Object.freeze({
      reactionDelayTicks: 3,
      mistakeChance: 0.03,
      replanIntervalTicks: 8,
      maxEscapeLen: 5,
      bombChance: 0.98,
      aggression: 1.8,
      recklessBombChance: 0,
      vChainBombs: 3,
      vChainChance: 0.85,
      vChainFoeRange: 4,
      combatRangeTiles: 6,
    }),
  }),
]);

/**
 * Resolve a named strategy by key (case-insensitive, whitespace-trimmed) to its
 * tuning + display name. Returns undefined for any key that isn't a known
 * archetype (callers fall back to difficulty tuning).
 */
export function resolveStrategy(
  key: string,
): { tuning: BotTuning; name: string } | undefined {
  const k = key.toLowerCase().trim();
  const s = STRATEGIES.find((e) => e.key === k);
  return s === undefined ? undefined : { tuning: s.tuning, name: s.name };
}

/**
 * Deterministically pick a strategy for a given index (mix mode): cycles
 * through STRATEGIES by `index mod STRATEGIES.length`. Fully deterministic —
 * no nondeterministic randomness / wall-clock — safe for lockstep / backfill.
 */
export function strategyForSlot(index: number): { tuning: BotTuning; name: string } {
  const n = STRATEGIES.length;
  // Normalize to a non-negative index even for negative inputs.
  const i = ((Math.trunc(index) % n) + n) % n;
  // STRATEGIES is a non-empty frozen literal, so this index is always in range.
  const s = STRATEGIES[i] as { key: string; name: string; tuning: BotTuning };
  return { tuning: s.tuning, name: s.name };
}
