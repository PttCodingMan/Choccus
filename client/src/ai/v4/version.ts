/**
 * AI version stamp for this version directory. Each client/src/ai/vN/ folder is
 * an independent, co-equal snapshot of the bot's decision logic; this constant
 * names which one. v4 is the current latest — to evolve the AI, copy this folder
 * to a new vN+1/ rather than rewriting it in place.
 *
 * v4 launch (2026-06-21): copied verbatim from v3 and reduced to a SINGLE
 * BACKBONE STRATEGY (Zoner — the strongest single strategy under the BT
 * yardstick, now the metric of record) per the single-strategy version workflow
 * in docs/ai-versions.md §七. v3 stays the frozen intransitive ROSTER yardstick;
 * v4 evolves one line on top of it (first focus: classic, the weaker map) and is
 * placed on the Bradley-Terry ladder via
 * `npm run bt-rank -- --target=v4:zoner`.
 */
export const AI_VERSION = 4;
