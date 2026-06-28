/**
 * Shared plumbing for the Bradley-Terry ladder benches (bt-seed, bt-rank).
 *
 * Both benches run 1v1 duels under CRN, fold each MatchRecord into a win/loss/
 * draw, and accumulate per-map head-to-head tallies that feed the persistent
 * history store + the BT fit. The duels reuse the matrix-runner's parallel,
 * gameId-ordered scheduler so results are byte-identical regardless of worker
 * count, and run on the SAME sim the game ships (post-merge: sudden death is
 * live, so a duel resolves by a kill — bomb or arena-shrink crush — before the
 * cap; `timedOut` is effectively impossible and a residual draw counts 0.5).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAPS,
  type Agent,
  type MapKind,
  type MatchRecord,
  makeAgent,
} from './bench-utils';
import { type Game, type GameResult, runAllGames, scenarioSeed } from './matrix-runner';
import {
  type History,
  emptyHistory,
  formatAgentId,
  parseHistory,
  serializeHistory,
  upsertPair,
} from './bt-history';

/** Which frozen AI version is the Bradley-Terry yardstick (rebuilt 2026-06-28:
 *  v3 went stale after the 3-map/PUSH/movement sim overhaul → v7 re-ports the
 *  same non-transitive roster onto the current engine). See client/src/ai/v7. */
export const YARDSTICK_VERSION = 7;

/** The yardstick pool: the six gate archetypes (the non-transitive RPS roster). */
export const YARDSTICK_POOL: readonly string[] = [
  'hunter',
  'farmer',
  'zoner',
  'runner',
  'trapper',
  'reactive',
];

/** The strength-floor judge, added to the pool only with --include-noise. */
export const YARDSTICK_NOISE = 'noise';

/** "v7:hunter" → "hunter" (archetype without the version prefix). */
export function stripVer(id: string): string {
  const i = id.indexOf(':');
  return i < 0 ? id : id.slice(i + 1);
}

/** True for a yardstick-pool agent id ("v7:<gate archetype>"), used to anchor
 *  the BT fit / meta-rank to the reference set. Both checks matter: the version
 *  prefix excludes placed challengers that reuse a pool archetype key (e.g.
 *  v8:zoner), and the pool membership excludes the out-of-pool noise judge. */
export function isYardstickPoolId(id: string): boolean {
  return id.startsWith(`v${YARDSTICK_VERSION}:`) && YARDSTICK_POOL.includes(stripVer(id));
}

/** Directory holding the committed per-map history files. */
export function historyDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, '..', 'bt-history');
}

/** Path to a map's history file. */
export function historyPath(map: MapKind): string {
  return path.join(historyDir(), `${map}.json`);
}

/** Load a map's history, or an empty one if the file does not exist yet. */
export function loadHistory(map: MapKind): History {
  const p = historyPath(map);
  if (!fs.existsSync(p)) return emptyHistory(map);
  return parseHistory(fs.readFileSync(p, 'utf8'));
}

/** Write a map's history as stable, sorted JSON (creates the dir if needed). */
export function saveHistory(history: History): void {
  const dir = historyDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(historyPath(history.map as MapKind), serializeHistory(history));
}

/**
 * One side's result of a 1v1 from the winner's perspective, as BT credit:
 * 1 = `agentInSlot0` (the row agent) won, 0 = lost, 0.5 = draw. Reads the
 * MatchRecord's `winnerAgent` (a pool index) against the slot-0 agent index.
 * Under sudden death `timedOut` is effectively dead; a residual draw is 0.5.
 */
export function duelCredit(record: MatchRecord, slot0Agent: number): number {
  if (record.winnerAgent === null) return 0.5; // draw / mutual KO
  return record.winnerAgent === slot0Agent ? 1 : 0;
}

/** A per-unordered-pair tally accumulated across both seatings and repeats. */
export interface PairTally {
  /** Win credit of the lower pool-index agent. */
  winsLo: number;
  /** Win credit of the higher pool-index agent. */
  winsHi: number;
  draws: number;
}

/**
 * Build a CHALLENGER-vs-pool game list: the challenger (pool index 0) plays each
 * opponent over both seatings × repeats × all maps, under the shared CRN
 * scenario seed. v3-internal duels are NOT scheduled — they already live in the
 * history. gameId increments in fixed order so results reassemble deterministically.
 */
export function buildChallengerGames(
  challenger: number,
  opponents: number[],
  repeats: number,
  maps: readonly MapKind[] = MAPS,
): Game[] {
  const games: Game[] = [];
  let gameId = 0;
  // Iterate the GLOBAL map index m (0=classic, 1=pirate, 2=village) so scenarioSeed(m, r) is
  // identical whether or not a map is filtered out — CRN stays byte-stable. The
  // `maps` filter only skips scheduling, it never renumbers seeds.
  for (let m = 0; m < MAPS.length; m++) {
    const mapKind = MAPS[m]!;
    if (!maps.includes(mapKind)) continue;
    for (const opp of opponents) {
      for (let r = 0; r < repeats; r++) {
        const seed = scenarioSeed(m, r);
        games.push({ gameId: gameId++, mapKind, seed, slot0Agent: challenger, slot1Agent: opp });
        games.push({ gameId: gameId++, mapKind, seed, slot0Agent: opp, slot1Agent: challenger });
      }
    }
  }
  return games;
}

/**
 * Run a game list and fold the results into per-map, per-unordered-pair tallies
 * keyed by the canonical "lo|hi" pool-index pair. `games` and the returned
 * results are both gameId-ordered, so they zip directly.
 */
export async function runAndTally(
  games: Game[],
  agents: Agent[],
  workers: number,
): Promise<Map<MapKind, Map<string, PairTally>>> {
  const results: GameResult[] = await runAllGames(games, agents, { workers });
  const byMap = new Map<MapKind, Map<string, PairTally>>();
  for (const map of MAPS) byMap.set(map, new Map());

  for (let i = 0; i < games.length; i++) {
    const g = games[i]!;
    const res = results[i]!; // same gameId order
    const lo = Math.min(g.slot0Agent, g.slot1Agent);
    const hi = Math.max(g.slot0Agent, g.slot1Agent);
    const key = `${lo}|${hi}`;
    const tallies = byMap.get(g.mapKind)!;
    let t = tallies.get(key);
    if (!t) {
      t = { winsLo: 0, winsHi: 0, draws: 0 };
      tallies.set(key, t);
    }
    const credit0 = duelCredit(res.record, g.slot0Agent); // credit to slot-0 agent
    if (res.record.winnerAgent === null) {
      t.draws += 1;
      t.winsLo += 0.5;
      t.winsHi += 0.5;
    } else if (g.slot0Agent === lo) {
      t.winsLo += credit0;
      t.winsHi += 1 - credit0;
    } else {
      t.winsHi += credit0;
      t.winsLo += 1 - credit0;
    }
  }
  return byMap;
}

/**
 * Fold per-map pair tallies into the corresponding histories via upsert-by-pair,
 * mapping pool indices back to "v<N>:<arch>" ids. Returns the updated histories.
 */
export function mergeIntoHistories(
  byMap: Map<MapKind, Map<string, PairTally>>,
  agents: Agent[],
  meta: { repeats: number; seedBase: number },
  fresh = false,
): Map<MapKind, History> {
  const out = new Map<MapKind, History>();
  for (const map of MAPS) {
    const history = fresh ? emptyHistory(map) : loadHistory(map);
    const tallies = byMap.get(map)!;
    for (const [key, t] of tallies) {
      const [lo, hi] = key.split('|').map(Number) as [number, number];
      const idLo = idOf(agents[lo]!);
      const idHi = idOf(agents[hi]!);
      upsertPair(history, idLo, idHi, t.winsLo, t.winsHi, t.draws, meta);
    }
    out.set(map, history);
  }
  return out;
}

/** "v<version>:<archetype>" id for an Agent. */
export function idOf(agent: Agent): string {
  return formatAgentId(agent.version, agent.archetypeKey);
}

/** Build the yardstick pool agents (optionally including noise). */
export function yardstickPoolAgents(includeNoise: boolean): Agent[] {
  const arches = includeNoise ? [...YARDSTICK_POOL, YARDSTICK_NOISE] : [...YARDSTICK_POOL];
  return arches.map((a) => makeAgent(YARDSTICK_VERSION, a));
}

/** Parse `--key=value` style args with a default. */
export function arg(argv: string[], key: string, dflt: string): string {
  const a = argv.find((x) => x.startsWith(`--${key}=`));
  return a ? a.slice(key.length + 3) : dflt;
}

/** Parse a "v<N>:<arch>" challenger spec into an Agent. */
export function parseChallenger(spec: string): Agent {
  const m = /^v(\d+):([a-z0-9_]+)$/i.exec(spec);
  if (!m) throw new Error(`bad --target "${spec}" (want "v<N>:<archetype>", e.g. v4:hunter)`);
  return makeAgent(Number(m[1]), m[2]!.toLowerCase());
}
