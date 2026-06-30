import type { MapKind } from '../sim/Map';
/** Per-map champion = the live default bot, used in solo / spectate / net backfill.
 *  classic = v8:zoner (控場流), village + pirate = v8:hunter (獵殺流) as of 2026-06-30.
 *  SPLIT rationale: direct CRN h2h v8:hunter vs v8:zoner (80-rep ×2 seatings) is
 *  classic 44.1% (zoner decisively wins — its Voronoi squeeze upgrade counters the
 *  dive), but a COIN-FLIP on the open/symmetric maps — village 50.9%, pirate 47.8%
 *  (both inside noise; BT also ties them there). On the two maps where strength is
 *  indistinguishable we ship the AGGRESSIVE hunter as the default for play feel;
 *  classic keeps zoner where it genuinely wins. See docs/ai-versions.md §十五/§十六.
 *
 *  v8 = the v6 champion roster (Zoner backbone + aggressive Hunter front) evolved
 *  by adopting the two BnB three-map tactic rules prototyped on the v7 yardstick
 *  engine (docs/bnb-map-tactics.md, docs/ai-versions.md §十三):
 *    1. 「聯通之前不要停止發育」 — while walled off from every foe, keep developing to
 *       completion (the isolated dev floor no longer fades with clock urgency).
 *    2. 「縮圈開始之後，佔據中心」 — once the shrink is live, hard-prioritise holding
 *       the late-hardening centre (per-map shrinkCenterPriorityWeight: classic +
 *       village 20, pirate 0).
 *  PLUS (2026-06-29) the dypm-report VORONOI TERRITORY SQUEEZE (docs/ai-versions.md
 *  §十五): a multi-source-BFS reachable-tile differential added as a root-level
 *  potential (zoner-only `voronoi` flag; per-map voronoiWeight/Lambda/ShrinkOff).
 *  It models attack as structural squeeze (not phantom-kill) and counters the
 *  squeeze-death the per-second v5-diag exposed. On the frozen v7 BT yardstick this
 *  lifts v8:zoner from a tie to STRICT #1 on ALL THREE maps. A 2026-06-30 refine
 *  (§十六) adds CENTRALITY weighting to the Voronoi diff (voronoiCentralW=30, classic
 *  only — own profile for village/pirate at 0) for a further +20 Elo on classic via
 *  centre-control beating the trapper-sealer:
 *    classic 1710 (+45 over v7:zoner), village 1669 (+8), pirate 1523 (+8).
 *  classic is decisive; village/pirate are modest-but-real (near coin-flip maps —
 *  centralW>0 regresses them, so it is classic-only via the split profile).
 *
 *  Why this split (per the user's call, 2026-06-30, superseding the 2026-06-28
 *  all-zoner default): on CLASSIC the develop-and-control Zoner decisively wins the
 *  h2h (zoner 55.9% vs hunter) — its Voronoi territory-squeeze upgrade (§十五/§十六)
 *  directly counters the aggressor's dive — so classic keeps zoner. On VILLAGE/PIRATE
 *  the two are statistically TIED (open/symmetric maps wash any deterministic edge to
 *  ~50%: hunter h2h 50.9% / 47.8%, BT also ties them), so we ship the AGGRESSIVE
 *  Hunter there for a livelier play feel at no measured bench cost. NOTE: the live
 *  `?strategy=hunter` (Strategies.ts) is NOT `pureHunt` — it keeps the Zoner
 *  development backbone (farms + growUntilConnected) and adds `digToFoeWeight` to
 *  proactively open a path toward the foe; the pure-aggression `pureHunt` bot is only
 *  the v7 BT-yardstick archetype (a different bot), so the older "Hunter never farms"
 *  framing does NOT describe the shipped Hunter.
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
    pirate:  { version: 8, archetype: 'hunter' },
    village: { version: 8, archetype: 'hunter' },
  });
export function championFor(map: MapKind): { version: number; archetype: string } {
  // New/unknown maps (added via the editor) reuse the live default champion.
  return MAP_CHAMPION[map] ?? { version: 8, archetype: 'zoner' };
}
