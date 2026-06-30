/**
 * Strategies — the v4 BACKBONE. Unlike v3 (a deliberately non-transitive ROSTER
 * kept frozen as the Bradley-Terry yardstick), a version under active evolution
 * develops ONE line at a time (see docs/ai-versions.md §七). v4's trunk is the
 * 控場流 / Zoner archetype — the strongest single strategy under the BT yardstick,
 * which is now the metric of record (we stop reading the v3-bench KILL-EDGE gate
 * / fair-duel lenses):
 *   - pirate Bradley-Terry rank-1 by a clear margin (Elo 1757–1762, above farmer
 *     1733–1740 and trapper 1726);
 *   - classic top of the near-tied {zoner ≈ trapper ≈ farmer} cluster (Elo
 *     1658–1671) — i.e. zoner out-rates farmer on BOTH maps;
 *   - zone control synergises with the sudden-death shrink: it holds a stand-off
 *     ring and herds the foe toward a corner while the shrink does the closing,
 *     so it wins by compression without diving into self-destruction (the side
 *     the shrink rewards).
 *
 * v5 keeps this Zoner archetype tuning VERBATIM and evolves on a separate,
 * orthogonal DEFENSIVE axis instead (per-map MapProfile.entrapWeight +
 * robust refuge selection in BotController) — escape-route redundancy that
 * counters follow-up "seal" bombs, the mechanism that capped v4. The shared
 * `BotTuning` knobs live in BotConfig.ts; the new per-map knob is in MapProfile.ts.
 *
 * Reaction is in ticks at the fixed 60 Hz timestep; the bomb fuse is 180 ticks.
 */
import type { BotTuning } from './BotConfig';

export const STRATEGIES: ReadonlyArray<{
  key: string;
  name: string;
  tuning: BotTuning;
}> = Object.freeze([
  // 控場流 Zoner — hold the centre and compress the foe from a STAND-OFF ring:
  // bomb to wall off lanes and herd the foe toward a corner / dead-end, but never
  // close inside `zoneStandoff`. The v4 backbone.
  Object.freeze({
    key: 'zoner',
    name: '控場流/Zoner',
    tuning: Object.freeze({
      reactionDelayTicks: 3,
      mistakeChance: 0.03,
      replanIntervalTicks: 8,
      maxEscapeLen: 5,
      bombChance: 0.85,
      aggression: 1.4,
      recklessBombChance: 0,
      combatRangeTiles: 7,
      zoneStandoff: 4, // hold the ring ~4 tiles out; compress, don't dive.
      voronoi: true, // opt in to the territory-squeeze (the control-style lever).
    }),
  }),
  // 獵殺流 Hunter — the AGGRESSIVE v6 variant (goal #3 "主動開路過去擊殺消極對手").
  // SAME defensive Zoner backbone (the escape-redundancy stack stays on) PLUS the
  // "strip the foe's surroundings" farm bias (digToFoeWeight): while not in close
  // combat it clears the bricks around the nearest foe into OPEN space, stripping
  // its cover and proactively approaching — rather than orbiting a near-peer to a
  // sudden-death coin-flip. Measured ~break-even vs v5 (49.7%): it does NOT lose
  // (the only proactive form that holds ≥50%), but it trades away the defensive
  // zoner's clear 56.3% edge. Ships as a SELECTABLE archetype (?strategy=hunter),
  // NOT the champion — for an aggressive / human-play feel. See docs §十一.
  Object.freeze({
    key: 'hunter',
    name: '獵殺流/Hunter',
    tuning: Object.freeze({
      reactionDelayTicks: 3,
      mistakeChance: 0.03,
      replanIntervalTicks: 8,
      maxEscapeLen: 5,
      bombChance: 0.88, // VERY aggressive: take almost every bomb chance.
      aggression: 1.5, // VERY aggressive: strong attack pull (still gated by survivability).
      recklessBombChance: 0,
      combatRangeTiles: 7,
      zoneStandoff: 4,
      digToFoeWeight: 3, // strip the foe's surroundings — both-map-safe (4 over-exposes on pirate).
      sealPredictWeight: 12, // anticipate the foe's vChain counter-seal → press safely.
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
 * v4 has a single backbone, so every index resolves to the Trapper trunk.
 */
export function strategyForSlot(index: number): { tuning: BotTuning; name: string } {
  const n = STRATEGIES.length;
  // Normalize to a non-negative index even for negative inputs.
  const i = ((Math.trunc(index) % n) + n) % n;
  // STRATEGIES is a non-empty frozen literal, so this index is always in range.
  const s = STRATEGIES[i] as { key: string; name: string; tuning: BotTuning };
  return { tuning: s.tuning, name: s.name };
}
