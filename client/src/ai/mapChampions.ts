import type { MapKind } from '../sim/Map';
/** Per-map champion = the strongest bot on that map, used as the DEFAULT solo
 *  bot. As of 2026-06-21 v5 shipped: it is the v4 Zoner backbone plus a NEW
 *  DEFENSIVE escape-redundancy axis (anti-entrapment penalty + robust refuge
 *  selection) that counters follow-up "seal" bombs — the mechanism that was v4's
 *  binding ceiling (v3:trapper) and the user-reported death mode. On the shared
 *  Bradley-Terry ladder v5:zoner is #1 on BOTH maps with v4:zoner #2, and beats
 *  v4 head-to-head on both maps (classic 55.6%, pirate 55.0%; v5-probe). See
 *  tools/sim-runner bt-rank + docs/ai-versions.md §九. Update if a future tuning
 *  pass changes the top row. */
export const MAP_CHAMPION: Readonly<Record<MapKind, { version: number; archetype: string }>> =
  Object.freeze({
    classic: { version: 5, archetype: 'zoner' },
    pirate:  { version: 5, archetype: 'zoner' },
  });
export function championFor(map: MapKind): { version: number; archetype: string } {
  return MAP_CHAMPION[map];
}
