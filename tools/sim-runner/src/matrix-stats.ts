/**
 * Pure matrix math for the 1v1 round-robin matrix bench (matrix-bench.ts).
 *
 * Everything here is a pure function of head-to-head outcomes: same input ⇒ same
 * output, no sim, no RNG, no Date / performance. Splitting the math out lets the
 * verdict logic (ranking / 3-cycle detection / champion gate) be unit-tested
 * without spinning up a single match.
 *
 * The data model: for n agents we accumulate `winShare[i][j]` = the win rate of
 * agent i against agent j over their shared games (a draw counts 0.5 to each
 * side). `buildWinMatrix` turns per-game results into that n×n matrix; the rest
 * derive rankings and the per-map verdict from it.
 */

/** One game's outcome, attributed to the two AGENT indices that played it. */
export interface GameOutcome {
  /** Agent index occupying slot 0. */
  agentA: number;
  /** Agent index occupying slot 1. */
  agentB: number;
  /** Winner agent index, or null for a genuine draw (no tiebreak resolved it). */
  winnerAgent: number | null;
}

/**
 * n×n win-share matrix. `cell[i][j]` = agent i's win rate vs agent j over their
 * shared games (draws = 0.5 each). The diagonal is meaningless (left at 0) and
 * `cell[j][i] === 1 - cell[i][j]` holds for any pair that actually played.
 * Cells for pairs that never met are 0.
 */
export type WinMatrix = number[][];

/**
 * Fold per-game outcomes into the n×n win-share matrix. Each game adds a
 * head-to-head result between its two agents; a win is 1/0, a draw is 0.5/0.5.
 * The two agents must differ (a game is always between two distinct agents).
 *
 * Iteration is in fixed game order with integer accumulation, so the result is
 * bit-deterministic regardless of how games were scheduled or which thread ran
 * each one.
 */
export function buildWinMatrix(outcomes: GameOutcome[], n: number): WinMatrix {
  // wins[i][j] / games[i][j] accumulate the head-to-head tally; we divide at the
  // end so the final cell is an exact win share over the shared games.
  const wins: number[][] = Array.from({ length: n }, () =>
    new Array<number>(n).fill(0),
  );
  const games: number[][] = Array.from({ length: n }, () =>
    new Array<number>(n).fill(0),
  );

  for (const o of outcomes) {
    const { agentA, agentB } = o;
    games[agentA]![agentB]! += 1;
    games[agentB]![agentA]! += 1;
    if (o.winnerAgent === null) {
      wins[agentA]![agentB]! += 0.5;
      wins[agentB]![agentA]! += 0.5;
    } else if (o.winnerAgent === agentA) {
      wins[agentA]![agentB]! += 1;
    } else {
      wins[agentB]![agentA]! += 1;
    }
  }

  const matrix: WinMatrix = Array.from({ length: n }, () =>
    new Array<number>(n).fill(0),
  );
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const g = games[i]![j]!;
      matrix[i]![j] = g === 0 ? 0 : wins[i]![j]! / g;
    }
  }
  return matrix;
}

/**
 * Each agent's overall score = total wins over its 7 opponents / 70 (= the mean
 * of its 7 head-to-head win shares). Equivalent to averaging row i's off-
 * diagonal cells over the opponents it actually faced. Pure read of the matrix.
 */
export function overallScores(matrix: WinMatrix): number[] {
  const n = matrix.length;
  const scores = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let opponents = 0;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      sum += matrix[i]![j]!;
      opponents += 1;
    }
    scores[i] = opponents === 0 ? 0 : sum / opponents;
  }
  return scores;
}

/**
 * Agent indices sorted by overall score DESC, ties broken by lower index (so the
 * order is total and deterministic). `ranked[0]` is the champion, `ranked[1]`
 * the runner-up.
 */
export function rankAgents(scores: number[]): number[] {
  return Array.from({ length: scores.length }, (_, i) => i).sort(
    (a, b) => scores[b]! - scores[a]! || a - b,
  );
}

/**
 * A directed beat-relation 3-cycle A→B→C→A, where "x beats y" means
 * `matrix[x][y] > 0.5`. Stored as a length-3 agent-index tuple in cycle order,
 * canonicalized to start at its smallest member so duplicates collapse.
 */
export type ThreeCycle = [number, number, number];

/**
 * Find ALL distinct directed 3-cycles in the beat-relation (`cell > 0.5`). Each
 * cycle is canonicalized (rotated to start at its minimum index) and deduped, so
 * the returned list is order-independent and free of rotations of the same ring.
 * Returned sorted for a stable, deterministic listing.
 */
export function findThreeCycles(matrix: WinMatrix): ThreeCycle[] {
  const n = matrix.length;
  const beats = (x: number, y: number): boolean => matrix[x]![y]! > 0.5;

  const seen = new Set<string>();
  const cycles: ThreeCycle[] = [];
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      if (b === a) continue;
      for (let c = 0; c < n; c++) {
        if (c === a || c === b) continue;
        if (beats(a, b) && beats(b, c) && beats(c, a)) {
          // Canonicalize: rotate so the smallest index leads (keeps the
          // directed order, drops the 3 rotations of one ring to one key).
          const ring = [a, b, c];
          const minPos = ring.indexOf(Math.min(a, b, c));
          const canon: ThreeCycle = [
            ring[minPos]!,
            ring[(minPos + 1) % 3]!,
            ring[(minPos + 2) % 3]!,
          ];
          const key = canon.join('>');
          if (!seen.has(key)) {
            seen.add(key);
            cycles.push(canon);
          }
        }
      }
    }
  }
  cycles.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
  return cycles;
}

/** The champion gate: a direct-duel win share ≥ this is a SINGLE champion. */
export const CHAMPION_GATE = 0.6;

/** How the per-map headline was decided. */
export interface Verdict {
  /** Champion agent index (rank 1). */
  champion: number;
  /** Runner-up agent index (rank 2). */
  runnerUp: number;
  /** Champion's direct-duel win share vs the runner-up (matrix[champ][run]). */
  headToHead: number;
  /** true = clear single champion; false = champion/runner-up are co-leaders. */
  single: boolean;
  /** true when the champion sits inside at least one detected 3-cycle. */
  championInCycle: boolean;
  /** The 3-cycles the champion participates in (subset of findThreeCycles). */
  championCycles: ThreeCycle[];
}

/**
 * Decide the per-map headline from the matrix + ranking + cycle list.
 *
 * Single champion ⇔ the rank-1 agent beats the rank-2 agent head-to-head with a
 * win share ≥ CHAMPION_GATE (0.60) AND the champion is not tangled in a 3-cycle
 * with the runner-up. Otherwise it's a TIE (co-leaders) — the gate didn't clear
 * or a rock-paper-scissors ring sits at the top, so we refuse to crown one.
 */
export function decideVerdict(
  matrix: WinMatrix,
  ranked: number[],
  cycles: ThreeCycle[],
): Verdict {
  const champion = ranked[0]!;
  const runnerUp = ranked[1]!;
  const headToHead = matrix[champion]![runnerUp]!;
  const championCycles = cycles.filter((c) => c.includes(champion));
  const championInCycle = championCycles.length > 0;
  // The champion is tangled with the runner-up specifically if any of its cycles
  // also contains the runner-up — that's the case the spec says NOT to crown.
  const tangledWithRunnerUp = championCycles.some((c) => c.includes(runnerUp));

  const single = headToHead >= CHAMPION_GATE && !tangledWithRunnerUp;
  return {
    champion,
    runnerUp,
    headToHead,
    single,
    championInCycle,
    championCycles,
  };
}
