import type { MapKind } from '../sim/Map';
/** Per-map champion = the live default bot, used in solo / spectate / net backfill.
 *  ALL maps = v6:hunter (the AGGRESSIVE archetype) as of 2026-06-25.
 *
 *  v6:hunter = the v6 Zoner defensive backbone (stacked escape-redundancy:
 *  entrapWeight 20 + the new foe-independent shrinkEntrapWeight) PLUS a VERY
 *  aggressive front — aggression 1.5 / bombChance 0.9 / combatRange 7 and two
 *  pressure traits: `digToFoeWeight` (炸光周遭: strip the nearest foe's surrounding
 *  bricks into open space) and `sealPredictWeight` (擊殺預判: anticipate the foe's
 *  advancing vChain counter-seal and reach open ground first, so it can press
 *  without being sealed). The player should face a relentless attacker.
 *
 *  Why hunter is the live default (per the user's call — aggressive playstyle):
 *  under the BnB lenient hitbox (HIT_COVER 2/3, merged 2026-06-25) aggression is
 *  no longer self-defeating — survivable edge-dodging means pressing the foe stops
 *  feeding its seal. Direct CRN vs the prior champion v5:zoner (v5-probe, 240 duels
 *  each, lenient hitbox): classic 57.7%, pirate 51.0% — beats v5 on BOTH maps while
 *  being far more aggressive than the defensive v6:zoner. Decomposition: the lenient
 *  hitbox un-breaks aggression (hunter-alone already 52%+); seal-prediction adds a
 *  small protective bump; the aggression crank (1.4→1.5) lifts classic further.
 *
 *  See tools/sim-runner v5-probe + docs/ai-versions.md §十一. Update if a future
 *  tuning pass changes the direct-CRN top row. */
export const MAP_CHAMPION: Readonly<Record<MapKind, { version: number; archetype: string }>> =
  Object.freeze({
    classic: { version: 6, archetype: 'hunter' },
    pirate:  { version: 6, archetype: 'hunter' },
    village: { version: 6, archetype: 'hunter' },
  });
export function championFor(map: MapKind): { version: number; archetype: string } {
  // New/unknown maps (added via the editor) reuse the live default champion.
  return MAP_CHAMPION[map] ?? { version: 6, archetype: 'hunter' };
}
