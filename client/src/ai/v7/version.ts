/**
 * AI version stamp for this version directory. Each client/src/ai/vN/ folder is
 * an independent, co-equal snapshot of the bot's decision logic; this constant
 * names which one.
 *
 * v7 is NOT a champion line — it is the FROZEN BRADLEY-TERRY YARDSTICK (rebuilt
 * 2026-06-28). The previous yardstick (the frozen v3 7-archetype roster, seeded
 * into tools/sim-runner/bt-history) went stale after the sim overhaul (3 maps:
 * classic/pirate/village, PUSH crates on every map, free-movement corner
 * rework): v3 is frozen code that predates PUSH and freezes in crate deathboxes,
 * so beating it is meaningless. v7 ports that deliberately NON-TRANSITIVE
 * (rock-paper-scissors) roster — hunter/farmer/zoner/runner/trapper/reactive +
 * the out-of-pool noise floor — onto the CURRENT engine (copied verbatim from
 * v6: the Zoner backbone + defensive escape-redundancy stack + PUSH-aware blast
 * + lenient hitbox), then FREEZES it. It is the fixed reference field the BT /
 * α-Rank / Nash-averaging benches rate new versions against; it is never the
 * live champion and never evolves in place.
 *
 * Division of roles (see docs/ai-versions.md): the LIVE CHAMPION stays v6:hunter
 * (mapChampions.ts) and evolves by copying to v8+; v7 stays frozen as the yard-
 * stick. Keeping champion and yardstick in separate versions is the whole point
 * — the yardstick must not move when the champion does.
 *
 * Only the roster (Strategies.ts) differs from v6; the BotController / BotConfig
 * / MapProfile / core engine are byte-for-byte v6, so every archetype runs on
 * the shipping engine (village reuses the classic MapProfile, as v6 does live).
 */
export const AI_VERSION = 7;
