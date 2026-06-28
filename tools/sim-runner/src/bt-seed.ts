/**
 * Seed the Bradley-Terry history with the yardstick (one-time, re-run on a
 * yardstick-version change). Runs the frozen v7 pool's internal 1v1 round-robin
 * — every unordered pair, both seatings, all maps, R repeats, under CRN — on the
 * SHIPPING sim (sudden death live, PUSH crates, free-movement), folds the
 * results into per-map head-to-head tallies and writes the committed
 * bt-history/{classic,pirate,village}.json from scratch.
 *
 *   npm run bt-seed -- [--repeats=150] [--workers=8] [--include-noise]
 *
 * These files are the fixed reference field: bt-rank drops a new version's
 * strategy into them and the joint fit anchors the yardstick pool mean to Elo
 * 1500, so v8+ ratings stay comparable. Re-seeding REPLACES the yardstick pairs
 * (fresh), so the file always reflects the current frozen v7 code.
 */

import { BASE, MAPS, type MapKind } from './bench-utils';
import { buildGameList } from './matrix-runner';
import { agentIds, toTally } from './bt-history';
import { fitBradleyTerry } from './bradley-terry';
import {
  arg,
  idOf,
  mergeIntoHistories,
  runAndTally,
  saveHistory,
  yardstickPoolAgents,
} from './bt-common';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const repeats = Number(arg(argv, 'repeats', '150'));
  const workers = Number(arg(argv, 'workers', '8'));
  const includeNoise = argv.includes('--include-noise');
  // --map re-seeds only the given map(s) (default: all). Only the selected maps'
  // history files are written, so the others are left intact (NOT overwritten
  // with empty data). CRN preserved (seeds key off the global map index).
  const mapArg = arg(argv, 'map', '');
  const selMaps = mapArg
    ? (mapArg.split(',').map((s) => s.trim()) as MapKind[]).filter((m) => MAPS.includes(m))
    : MAPS;

  const agents = yardstickPoolAgents(includeNoise);
  console.log(
    `Seeding BT history: yardstick pool [${agents.map(idOf).join(', ')}]\n` +
      `  ${repeats} repeats × 2 seatings × ${selMaps.length} map(s) [${selMaps.join(', ')}], workers=${workers}`,
  );

  const games = buildGameList(agents, repeats, undefined, selMaps);
  console.log(`  scheduling ${games.length} duels…`);
  const t0 = Date.now();
  const byMap = await runAndTally(games, agents, workers);
  console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Write fresh histories (v3-only) for the SELECTED maps only, then show their
  // per-map ladder. Unselected maps' committed history files are left untouched.
  const histories = mergeIntoHistories(byMap, agents, { repeats, seedBase: BASE }, true);
  for (const map of selMaps) {
    const history = histories.get(map)!;
    saveHistory(history);
    const ids = agentIds(history);
    const r = fitBradleyTerry(toTally(history, ids));
    const ranked = ids
      .map((id, i) => ({ id, elo: r.elo[i]! }))
      .sort((a, b) => b.elo - a.elo);
    console.log(`\n${map} v7 yardstick (anchor: pool mean = 1500):`);
    for (const row of ranked) console.log(`  ${row.id.padEnd(14)} ${row.elo.toFixed(0)}`);
    console.log(`  wrote ${ids.length} agents, ${history.pairs.length} pairs`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
