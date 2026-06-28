/**
 * AI version stamp for this version directory. Each client/src/ai/vN/ folder is
 * an independent, co-equal snapshot of the bot's decision logic; this constant
 * names which one. v8 is the current LIVE CHAMPION line — to evolve the AI, copy
 * this folder to a new vN+1/ rather than rewriting it in place.
 *
 * v8 launch (2026-06-28): the champion line (v6: the Zoner backbone + the v6
 * aggressive Hunter front + the defensive escape-redundancy stack) evolved by
 * adopting the two map-tactic rules that were prototyped on the v7 YARDSTICK
 * engine and validated there. v7 itself stays frozen as the Bradley-Terry
 * yardstick (its roster is the non-transitive reference field); v8 ports v7's
 * two engine mechanisms onto the SHIPPING champion roster so the live bot honours
 * them too. Both rules come from the public BnB three-map tactics survey
 * (docs/bnb-map-tactics.md): all three maps are item-race → trap-kill maps where
 * (1) you keep developing until you can actually reach a foe, and (2) the safe
 * ground in the shrink endgame is the late-hardening centre.
 *
 *   - POINT 1 「聯通之前不要停止發育」 (BotController.ts): while genuinely ISOLATED
 *     (no open walkable path to any foe — combat is impossible), the development
 *     floor no longer FADES with clock urgency. The old urgency fade was a farm-
 *     to-timeout guard that made the bot stop developing while still walled off;
 *     since sudden-death is guaranteed to force the connection later, the bot
 *     should farm to completion until an open path to a foe exists, then snap back
 *     to the normal readiness / kill doctrine the instant it connects.
 *   - POINT 2 「縮圈開始之後，佔據中心」 (MapProfile.shrinkCenterPriorityWeight):
 *     the moment the shrink is ACTUALLY live (tick ≥ SUDDEN_DEATH_START_TICK) the
 *     centre-survival term switches to a large per-map weight so grabbing / holding
 *     the late-hardening centre DOMINATES the hunt/seal pulls. classic + village
 *     (shared profile) 20, pirate 0 (its tuned soft pull is stronger left alone).
 *     Still gated by the hard refuge/safety net — only biases WHICH safe tile.
 *
 * Both mechanisms are the byte-for-byte v6→v7 engine delta; v8 is otherwise the
 * v6 champion roster verbatim (zoner backbone + aggressive hunter front). On the
 * v7 yardstick, v8:zoner is byte-identical to the BT #1 v7:zoner and so ranks #1
 * on all three maps; the live champion is the aggressive v8:hunter (ship-gated by
 * direct CRN vs the outgoing v6:hunter on all three maps).
 */
export const AI_VERSION = 8;
