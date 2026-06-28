import type { MapKind } from '../sim/Map';
/** Per-map champion = the live default bot, used in solo / spectate / net backfill.
 *  ALL maps = v8:hunter (the AGGRESSIVE archetype) as of 2026-06-28.
 *
 *  v8 = the v6 champion roster (Zoner backbone + aggressive Hunter front) evolved
 *  by adopting the two BnB three-map tactic rules prototyped on the v7 yardstick
 *  engine (docs/bnb-map-tactics.md, docs/ai-versions.md §十三):
 *    1. 「聯通之前不要停止發育」 — while walled off from every foe, keep developing to
 *       completion (the isolated dev floor no longer fades with clock urgency).
 *    2. 「縮圈開始之後，佔據中心」 — once the shrink is live, hard-prioritise holding
 *       the late-hardening centre (per-map shrinkCenterPriorityWeight: classic +
 *       village 20, pirate 0).
 *  On the frozen v7 BT yardstick, v8:zoner is byte-identical to the #1 v7:zoner and
 *  so ranks #1 on all three maps; the live champion is the aggressive v8:hunter.
 *
 *  v8:hunter = the Zoner defensive backbone (stacked escape-redundancy:
 *  entrapWeight 20 + the foe-independent shrinkEntrapWeight) PLUS the two new rules
 *  PLUS a VERY aggressive front — aggression 1.5 / bombChance 0.9 / combatRange 7
 *  and two pressure traits: `digToFoeWeight` (炸光周遭: strip the nearest foe's
 *  surrounding bricks into open space) and `sealPredictWeight` (擊殺預判: anticipate
 *  the foe's advancing vChain counter-seal and reach open ground first, so it can
 *  press without being sealed). The player should face a relentless attacker.
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
 *  See tools/sim-runner v5-probe + docs/ai-versions.md §十一/§十三. Update if a
 *  future tuning pass changes the direct-CRN top row. */
export const MAP_CHAMPION: Readonly<Record<MapKind, { version: number; archetype: string }>> =
  Object.freeze({
    classic: { version: 8, archetype: 'hunter' },
    pirate:  { version: 8, archetype: 'hunter' },
    village: { version: 8, archetype: 'hunter' },
  });
export function championFor(map: MapKind): { version: number; archetype: string } {
  // New/unknown maps (added via the editor) reuse the live default champion.
  return MAP_CHAMPION[map] ?? { version: 8, archetype: 'hunter' };
}
