import type { MapKind } from '../sim/Map';
/** Per-map champion = the live default bot, used in solo / spectate / net backfill.
 *  ALL maps = v8:zoner (the 控場流 / zone-control archetype) as of 2026-06-28.
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
 *  so ranks #1 on all three maps.
 *
 *  Why ZONER is the live default (per the user's call, 2026-06-28): the two rules
 *  are a develop-and-control doctrine that only the Zoner can actually honour — it
 *  FARMS (so Rule 1 「發育到聯通」 is live) and HOLDS CENTRE (so Rule 2 「縮圈佔中心」
 *  is live). The aggressive Hunter is `pureHunt` — it never farms, so Rule 1 is
 *  structurally inert for it, and the ship-gate measured Rule 2 REGRESSING it on the
 *  cramped classic map (v8:hunter vs v6:hunter, v5-probe 60×2×3: classic 46.3%,
 *  pirate 50.0%, village 65.8% — fails the ≥50%-everywhere gate). So the bot that is
 *  genuinely #1 on all three maps AND embodies both rules is the Zoner; it is the
 *  live champion. The aggressive Hunter stays SELECTABLE via `?strategy=hunter` for
 *  players who want a relentless attacker, but it is no longer the default.
 *
 *  v8:zoner = the Zoner defensive backbone (stand-off ring, escape-redundancy stack:
 *  entrapWeight 20 + robustRefuge + the foe-independent shrinkEntrapWeight) PLUS the
 *  two new rules. aggression 1.4 / bombChance 0.85 / combatRange 7 / zoneStandoff 4 —
 *  it compresses the foe toward a corner from a stand-off ring and lets the shrink do
 *  the closing, rather than diving in.
 *
 *  See tools/sim-runner v5-probe / bt-rank + docs/ai-versions.md §十三. Update if a
 *  future tuning pass changes the direct-CRN / BT top row. */
export const MAP_CHAMPION: Readonly<Record<MapKind, { version: number; archetype: string }>> =
  Object.freeze({
    classic: { version: 8, archetype: 'zoner' },
    pirate:  { version: 8, archetype: 'zoner' },
    village: { version: 8, archetype: 'zoner' },
  });
export function championFor(map: MapKind): { version: number; archetype: string } {
  // New/unknown maps (added via the editor) reuse the live default champion.
  return MAP_CHAMPION[map] ?? { version: 8, archetype: 'zoner' };
}
