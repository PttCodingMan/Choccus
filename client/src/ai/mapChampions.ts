import type { MapKind } from '../sim/Map';
/** Per-map champion = the strongest bot on that map, used as the DEFAULT solo
 *  bot. As of 2026-06-21 evaluation moved to the Bradley-Terry yardstick and v4
 *  shipped: v4:zoner is #1 on BOTH maps (classic 1720 = +42 over #2, pirate 1789
 *  = +48 over #2; see tools/sim-runner bt-rank + docs/ai-versions.md §八), so it
 *  is the champion on both. Update if a future tuning pass changes the top row. */
export const MAP_CHAMPION: Readonly<Record<MapKind, { version: number; archetype: string }>> =
  Object.freeze({
    classic: { version: 4, archetype: 'zoner' },
    pirate:  { version: 4, archetype: 'zoner' },
  });
export function championFor(map: MapKind): { version: number; archetype: string } {
  return MAP_CHAMPION[map];
}
