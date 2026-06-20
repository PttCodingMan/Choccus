import type { MapKind } from '../sim/Map';
/** Per-map v3-bench best archetype (the "champion") used as the DEFAULT solo
 *  bot. Picked under the live rules (sudden-death + timeout=challenger loss):
 *  classic→farmer 69.2%, pirate→zoner 81.7% (see tools/sim-runner v3-bench +
 *  docs/ai-versions.md). Update if a future tuning pass changes the best row. */
export const MAP_CHAMPION: Readonly<Record<MapKind, { version: number; archetype: string }>> =
  Object.freeze({
    classic: { version: 3, archetype: 'farmer' },
    pirate:  { version: 3, archetype: 'zoner' },
  });
export function championFor(map: MapKind): { version: number; archetype: string } {
  return MAP_CHAMPION[map];
}
