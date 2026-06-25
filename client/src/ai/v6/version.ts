/**
 * AI version stamp for this version directory. Each client/src/ai/vN/ folder is
 * an independent, co-equal snapshot of the bot's decision logic; this constant
 * names which one. v6 is the current latest — to evolve the AI, copy this folder
 * to a new vN+1/ rather than rewriting it in place.
 *
 * v6 launch (2026-06-24): copied verbatim from v5 (the live Zoner backbone +
 * defensive escape-redundancy axis) and evolved to break the v5↔v5 classic mirror.
 *
 * The brief (per /goal) was a PROACTIVE-HUNTER doctrine: kill fast, develop only
 * until path-connected, and dig toward a passive foe to force the kill. That axis
 * was BUILT and MEASURED (a BFS proactive-approach pull, earlier huntStart, tighter
 * ring, heavier econ) and EMPIRICALLY REJECTED — every aggressive lever is net-
 * negative vs v5 (closing on a same-defence mirror just feeds the foe's seal: probe
 * 43–49% vs v5). This re-confirms the §八–§十 "aggression hits the zone-control
 * mirror ceiling" finding, now against v5 directly.
 *
 * The WIN came from the DEFENSIVE axis instead. v5-diag of the mirror shows its 38
 * losses are branch-collapse deaths — 27 TRAPPED (mid-game foe seal) + 20 shrink
 * squeeze — the bot dying in a dead-end (escape branches 0.29 at death vs 2.20 in
 * wins). v6 stacks two escape-redundancy levers that cover BOTH death modes:
 *   - entrapWeight 10→20 (the existing foe-triggered dead-end penalty, stronger);
 *   - shrinkEntrapWeight 30 (NEW, foe-INDEPENDENT): v5's entrap only fires with a
 *     foe in combat range, so it is OFF for the shrink deaths (foe far, the WALL is
 *     the sealer) — this penalises low-branch tiles during the sudden-death lead-in.
 * Result: classic 54.8–56.3% vs v5 direct CRN (~2 SD over 240–400 games); pirate
 * byte-unchanged (all knobs classic-only). Gated via
 * `npm run v5-probe -- --target=v6:zoner --opponents=v5:zoner --map=classic`.
 */
export const AI_VERSION = 6;
