/**
 * 1v1 round-robin WIN-RATE MATRIX bench.
 *
 *   npm run matrix-bench [--versions=A,B] [--repeats=5] [--workers=N]
 *
 * Goal: per map, find the single strongest archetype — and where it's a true
 * toss-up, SAY so rather than crown a coin-flip winner. Eight agents (two AI
 * versions × four archetypes) play a full 1v1 round-robin: C(8,2)=28 pairings,
 * each pairing 5 forward + 5 reverse seatings (cancels spawn bias) on both maps
 * = 10×28×2 = 560 games at the default repeats=5.
 *
 * CRN (common random numbers): every pairing of a given (map, repeat) replays
 * under ONE shared scenario seed, forward and reverse alike — identical layout
 * and per-slot bot RNG, so a cell's deviation from 50% is pure skill. See
 * matrix-runner.ts `scenarioSeed` / `buildGameList`.
 *
 * Per map we print: the 8×8 win-share matrix, the overall ranking, the champion
 * verdict (single champion iff rank-1 beats rank-2 head-to-head ≥60% AND isn't
 * tangled in a top 3-cycle — else co-leaders), the full 3-cycle (rock-paper-
 * scissors) report, and a per-archetype vOld-vs-vNew regression check (the most
 * actionable feedback: the new version exists to BEAT the old one).
 *
 * Parallel via worker_threads (`--workers`), but the aggregate is reassembled in
 * fixed gameId order, so multi-core results are bit-identical to `--workers=1`.
 * Pure orchestration: no Date / Math.random / performance.
 */
import * as os from 'node:os';

import { AI_VERSIONS, LATEST_AI_VERSION } from '../../../client/src/ai/index';
import {
  ARCHETYPE_KEYS,
  MAPS,
  type Agent,
  type MapKind,
  capitalize,
  makeAgent,
  padL,
  padR,
} from './bench-utils';
import {
  type Game,
  type GameResult,
  buildGameList,
  runAllGames,
} from './matrix-runner';
import {
  type GameOutcome,
  type Verdict,
  type WinMatrix,
  buildWinMatrix,
  decideVerdict,
  findThreeCycles,
  overallScores,
  rankAgents,
} from './matrix-stats';

/** One run-time CLI configuration. */
interface Options {
  versions: number[];
  repeats: number;
  workers: number;
}

/** Scan process.argv for `--flag=value` (mirrors the old bench parseArgs). */
function parseArgs(argv: string[]): Options {
  let versions: number[] | null = null;
  let repeats = 5;
  let workers = os.cpus().length;

  for (const arg of argv) {
    if (arg.startsWith('--versions=')) {
      versions = arg
        .slice('--versions='.length)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => Number(s));
    } else if (arg.startsWith('--repeats=')) {
      repeats = Number(arg.slice('--repeats='.length));
    } else if (arg.startsWith('--workers=')) {
      workers = Number(arg.slice('--workers='.length));
    }
  }

  // Default versions = previous and latest (low first for a stable Δ direction).
  const defaultVersions = [LATEST_AI_VERSION - 1, LATEST_AI_VERSION];

  return {
    versions: versions ?? defaultVersions,
    repeats,
    workers,
  };
}

/** Validate options; return an error string or null. */
function validate(opts: Options): string | null {
  if (opts.versions.length !== 2) {
    return `--versions must be exactly 2 versions; got ${opts.versions.length} (${opts.versions.join(', ')}).`;
  }
  for (const v of opts.versions) {
    if (!Number.isInteger(v) || !AI_VERSIONS[v]) {
      const known = Object.keys(AI_VERSIONS).join(', ');
      return `Unknown AI version: ${v}. Registered versions: ${known}.`;
    }
  }
  if (opts.versions[0] === opts.versions[1]) {
    return `--versions must be two DIFFERENT versions; got ${opts.versions[0]} twice.`;
  }
  if (!Number.isInteger(opts.repeats) || opts.repeats < 1) {
    return `Invalid --repeats: ${opts.repeats} (must be a positive integer).`;
  }
  if (!Number.isInteger(opts.workers) || opts.workers < 1) {
    return `Invalid --workers: ${opts.workers} (must be a positive integer).`;
  }
  return null;
}

/**
 * Build the 8 agents in FIXED order: version-major, archetype-minor. With the
 * default two versions × four archetypes that's exactly 8 — v_lo's four
 * archetypes (indices 0..3) then v_hi's four (4..7).
 */
function buildAgents(versions: number[]): Agent[] {
  const lo = Math.min(versions[0]!, versions[1]!);
  const hi = Math.max(versions[0]!, versions[1]!);
  const agents: Agent[] = [];
  for (const v of [lo, hi]) {
    for (const key of ARCHETYPE_KEYS) agents.push(makeAgent(v, key));
  }
  return agents;
}

/** Turn this map's finished games into per-game outcomes for the matrix math. */
function outcomesForMap(
  games: Game[],
  resultById: Map<number, GameResult>,
  map: MapKind,
): GameOutcome[] {
  const outcomes: GameOutcome[] = [];
  for (const game of games) {
    if (game.mapKind !== map) continue;
    const res = resultById.get(game.gameId)!;
    outcomes.push({
      agentA: game.slot0Agent,
      agentB: game.slot1Agent,
      winnerAgent: res.record.winnerAgent,
    });
  }
  return outcomes;
}

/** Print the 8×8 win-share matrix: cell[i][j] = row i's win% vs col j. */
function printMatrix(agents: Agent[], matrix: WinMatrix): void {
  const n = agents.length;
  const labelW = Math.max(...agents.map((a) => a.label.length), 'agent'.length);
  const cellW = 6;

  // Column header: the column agent index (key printed below the matrix).
  const header =
    padR('', labelW) + '  ' + agents.map((_, j) => padL(String(j), cellW)).join('');
  console.log(header);
  for (let i = 0; i < n; i++) {
    const cells = matrix[i]!
      .map((v, j) => (i === j ? padL('—', cellW) : padL(`${(v * 100).toFixed(0)}%`, cellW)))
      .join('');
    console.log(`${padR(agents[i]!.label, labelW)}  ${cells}`);
  }
  console.log(
    `  (col key: ${agents.map((a, j) => `${j}=${a.label}`).join(', ')})`,
  );
}

/** Print the overall ranking table (agent / overall win% / rank). */
function printRanking(agents: Agent[], scores: number[], ranked: number[]): void {
  const headers = ['Rank', 'Agent', 'Overall', 'TotalWins'];
  const cells = ranked.map((idx, i) => [
    String(i + 1),
    agents[idx]!.label,
    `${(scores[idx]! * 100).toFixed(1)}%`,
    // 7 opponents × 10 games = 70 games; overall × 70 = total win-equivalent.
    (scores[idx]! * 70).toFixed(1),
  ]);
  const widths = headers.map((h, c) =>
    Math.max(h.length, ...cells.map((row) => row[c]!.length)),
  );
  const fmtRow = (row: string[]): string =>
    row.map((cell, c) => (c === 1 ? padR(cell, widths[c]!) : padL(cell, widths[c]!))).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  console.log(fmtRow(headers));
  console.log(sep);
  for (const row of cells) console.log(fmtRow(row));
}

/** Print the champion verdict (single vs co-leaders) with the reason. */
function printVerdict(agents: Agent[], verdict: Verdict): void {
  const champ = agents[verdict.champion]!.label;
  const runner = agents[verdict.runnerUp]!.label;
  const h2h = `${(verdict.headToHead * 100).toFixed(1)}%`;
  if (verdict.single) {
    console.log(
      `VERDICT: single champion = ${champ} ` +
        `(beats runner-up ${runner} head-to-head ${h2h} ≥ 60%).`,
    );
  } else {
    const reason = verdict.championCycles.some((c) => c.includes(verdict.runnerUp))
      ? `champion is tied with runner-up in a 3-cycle (no clear top), h2h ${h2h}`
      : `head-to-head ${h2h} < 60% gate`;
    console.log(
      `VERDICT: CO-LEADERS = ${champ} & ${runner} (${reason}). ` +
        'Too close to crown one — treat as a tie.',
    );
  }
}

/** Print the full 3-cycle (rock-paper-scissors) report for this map. */
function printCycles(
  agents: Agent[],
  cycles: ReturnType<typeof findThreeCycles>,
  verdict: Verdict,
): void {
  if (cycles.length === 0) {
    console.log('Cycle check: no 3-cycles (beat-relation is acyclic at the top).');
    return;
  }
  console.log(`Cycle check: ${cycles.length} rock-paper-scissors 3-cycle(s):`);
  for (const c of cycles) {
    const tag = c.includes(verdict.champion) ? '  <- includes champion' : '';
    console.log(
      `  ${agents[c[0]]!.label} → ${agents[c[1]]!.label} → ${agents[c[2]]!.label} → ${agents[c[0]]!.label}${tag}`,
    );
  }
  if (verdict.championInCycle) {
    console.log(
      `  NOTE: champion ${agents[verdict.champion]!.label} sits inside a 3-cycle — ` +
        'top of the table is non-transitive; see the verdict above.',
    );
  }
}

/**
 * Per-archetype old-vs-new regression check + which version owns this map.
 * Warns when vNew-k is beaten head-to-head by vOld-k (cell < 0.5) or ranks worse
 * overall — the new version was built to improve the old one, so being dominated
 * is a design red flag.
 */
function printVersionCompare(
  agents: Agent[],
  matrix: WinMatrix,
  ranked: number[],
  versions: number[],
  verdict: Verdict,
): void {
  const lo = Math.min(versions[0]!, versions[1]!);
  const hi = Math.max(versions[0]!, versions[1]!);
  const idxOf = (ver: number, key: string): number =>
    agents.findIndex((a) => a.version === ver && a.archetypeKey === key);
  const rankOf = (idx: number): number => ranked.indexOf(idx) + 1;

  console.log(`v${lo} (old) vs v${hi} (new), per archetype:`);
  const headers = ['Archetype', `v${hi} vs v${lo} (h2h)`, `v${lo} rank`, `v${hi} rank`, 'flag'];
  const cells: string[][] = [];
  for (const key of ARCHETYPE_KEYS) {
    const oldIdx = idxOf(lo, key);
    const newIdx = idxOf(hi, key);
    if (oldIdx < 0 || newIdx < 0) continue;
    const h2h = matrix[newIdx]![oldIdx]!; // new's win share vs old.
    const oldRank = rankOf(oldIdx);
    const newRank = rankOf(newIdx);
    const dominated = h2h < 0.5;
    const rankWorse = newRank > oldRank;
    const flag =
      dominated || rankWorse
        ? `⚠ v${hi}-${capitalize(key)} regressed` +
          (dominated ? ' (lost h2h)' : '') +
          (rankWorse ? ' (worse rank)' : '')
        : 'ok';
    cells.push([
      capitalize(key),
      `${(h2h * 100).toFixed(1)}%`,
      `#${oldRank}`,
      `#${newRank}`,
      flag,
    ]);
  }
  const widths = headers.map((h, c) =>
    Math.max(h.length, ...cells.map((row) => row[c]!.length)),
  );
  const fmtRow = (row: string[]): string =>
    row.map((cell, c) => (c === 0 || c === 4 ? padR(cell, widths[c]!) : padL(cell, widths[c]!))).join('  ');
  console.log(fmtRow(headers));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of cells) console.log(fmtRow(row));

  const champVer = agents[verdict.champion]!.version;
  console.log(
    `Champion ${agents[verdict.champion]!.label} belongs to ${champVer === hi ? `v${hi} (new)` : `v${lo} (old)`}.`,
  );
}

/** Render one map's full report. */
function reportMap(
  map: MapKind,
  agents: Agent[],
  outcomes: GameOutcome[],
  versions: number[],
): void {
  const n = agents.length;
  const matrix = buildWinMatrix(outcomes, n);
  const scores = overallScores(matrix);
  const ranked = rankAgents(scores);
  const cycles = findThreeCycles(matrix);
  const verdict = decideVerdict(matrix, ranked, cycles);

  console.log('');
  console.log(`================= MAP: ${map} =================`);
  console.log(`8×8 win-share matrix (row i's win% vs col j, ${outcomes.length} games):`);
  printMatrix(agents, matrix);
  console.log('');
  console.log('Overall ranking (total wins / 70):');
  printRanking(agents, scores, ranked);
  console.log('');
  printVerdict(agents, verdict);
  console.log('');
  printCycles(agents, cycles, verdict);
  console.log('');
  printVersionCompare(agents, matrix, ranked, versions, verdict);
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const err = validate(opts);
  if (err) {
    console.error(err);
    return 2;
  }

  const agents = buildAgents(opts.versions);
  const lo = Math.min(opts.versions[0]!, opts.versions[1]!);
  const hi = Math.max(opts.versions[0]!, opts.versions[1]!);

  const games = buildGameList(agents, opts.repeats);
  const pairs = (agents.length * (agents.length - 1)) / 2;

  console.log(
    '1v1 round-robin win-rate matrix bench (CRN-seeded, worker-parallel).',
  );
  console.log(`Agents (${agents.length}): ${agents.map((a) => a.label).join(', ')}`);
  console.log(
    `Schedule: C(${agents.length},2)=${pairs} pairings × ` +
      `(${opts.repeats} fwd + ${opts.repeats} rev) × ${MAPS.length} maps = ` +
      `${games.length} games. workers=${opts.workers}.`,
  );
  console.log(`Comparing v${lo} (old) vs v${hi} (new).`);

  const results = await runAllGames(games, agents, { workers: opts.workers });

  const resultById = new Map<number, GameResult>();
  for (const r of results) resultById.set(r.gameId, r);

  for (const map of MAPS) {
    const outcomes = outcomesForMap(games, resultById, map);
    reportMap(map, agents, outcomes, opts.versions);
  }

  console.log('');
  console.log(
    `Done: ${games.length} games across ${opts.workers} worker(s) ` +
      '(result is bit-identical regardless of worker count).',
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e);
    process.exit(1);
  },
);
