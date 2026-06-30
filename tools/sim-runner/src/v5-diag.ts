/**
 * v5-diag — FAILURE-TRAJECTORY diagnostic for the v5 bot.
 *
 * The probes (v5-probe / bt-rank) tell you WHETHER v5 wins; this tells you WHY it
 * LOSES, and — per the design brief — that the cause of a death is usually visible
 * ~10 seconds (600 ticks) earlier. It runs target vs an opponent under the SAME
 * CRN seeds the probes use, and for every game traces the TARGET's trajectory:
 * per tick it records the target's escape-branch count (dead-end detector), its
 * BFS distance to the foe, its safe free-space, and the development gap. When the
 * target dies it classifies the death (SEALED in a low-branch pocket vs caught in
 * the OPEN vs TRAPPED-then-shell-broken) and snapshots the trajectory at death,
 * 1 s before, and 10 s before — so a systematic early sign (already cornered /
 * already low-branch / already behind on dev ten seconds out) shows up in the
 * aggregate.
 *
 *   npm run v5-diag -- --target=v5:zoner [--opponent=v3:trapper] [--map=classic]
 *                      [--repeats=40]
 *
 * Pure analysis (no BT, no history). Deterministic CRN seeds (scenarioSeed).
 */
import { GamePhase, TileKind } from '../../../shared/types';
import { FUSE_TICKS, MAP_COLS, MAP_ROWS, SPARK_TICKS, SUDDEN_DEATH_START_TICK } from '../../../shared/constants';
import { makeFeelParams } from '../../../client/src/config/FeelParams';
import { type InputFrame } from '../../../client/src/sim/InputBuffer';
import { DIRECTION_ORDER } from '../../../client/src/sim/InputBuffer';
import { tick, createInitialState, type SimState } from '../../../client/src/sim/Sim';
import { idx, inBounds } from '../../../client/src/sim/Map';
import { dirDX, dirDY, tileOf } from '../../../client/src/sim/Player';
import { openPassable, bfsFirstStep } from '../../../client/src/ai/common/grid';
import { buildDangerMap, type IntervalDanger } from '../../../client/src/ai/common/dangerMap';
import { MAPS, type MapKind, makeController } from './bench-utils';
import { scenarioSeed } from './matrix-runner';
import { arg, parseChallenger } from './bt-common';

const STEP_DANGER_HORIZON = SPARK_TICKS + 4;
const SURV_SAFE_HORIZON = FUSE_TICKS;
const WINDOW = 600; // 10 s @ 60 Hz — the WIN-game "last 10 s mean" baseline window.
/** Seconds-before-death to snapshot the target's trajectory at: per-second through
 *  the 0–10 s window, which is where the seal collapses escape branches (the coarse
 *  1 s/10 s endpoints couldn't locate WHEN). The sparse 12–20 s tail was dropped —
 *  it carried no signal (branches stable, devGap flat that far out). */
const TRACE_SECONDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
/** Per-tick trajectory ring cap: must cover the furthest TRACE_SECONDS offset. */
const RING_CAP = (Math.max(...TRACE_SECONDS) + 2) * 60; // 22 s of history.
const FLOOD_CAP = 12;
const FREE_CAP = 24;

/** Escape-branch count — the SAME metric the v5 bot's anti-entrapment term uses. */
function escapeBranches(state: SimState, danger: IntervalDanger, rx: number, ry: number): number {
  const base = openPassable(state);
  const selfIdx = idx(rx, ry);
  let branches = 0;
  for (const d of DIRECTION_ORDER) {
    const nx = rx + dirDX(d);
    const ny = ry + dirDY(d);
    if (!inBounds(nx, ny) || !base(nx, ny)) continue;
    const nIdx = idx(nx, ny);
    const ne = danger.earliestLethal(nIdx);
    if (ne !== undefined && ne <= STEP_DANGER_HORIZON) continue;
    const seen = new Set<number>([selfIdx, nIdx]);
    const queue = [nIdx];
    let head = 0;
    let reached = false;
    let visited = 0;
    while (head < queue.length && visited < FLOOD_CAP) {
      const cur = queue[head]!;
      head += 1;
      visited += 1;
      const e = danger.earliestLethal(cur);
      if (e === undefined || e > SURV_SAFE_HORIZON) {
        reached = true;
        break;
      }
      const cx = cur % MAP_COLS;
      const cy = (cur - cx) / MAP_COLS;
      for (const dd of DIRECTION_ORDER) {
        const mx = cx + dirDX(dd);
        const my = cy + dirDY(dd);
        if (!inBounds(mx, my) || !base(mx, my)) continue;
        const mi = idx(mx, my);
        if (seen.has(mi)) continue;
        const me = danger.earliestLethal(mi);
        if (me !== undefined && me <= STEP_DANGER_HORIZON) continue;
        seen.add(mi);
        queue.push(mi);
      }
    }
    if (reached) branches += 1;
  }
  return branches;
}

/** Count of safe-dwell tiles reachable from (x,y) (a free-space proxy). */
function freeSpace(state: SimState, danger: IntervalDanger, x: number, y: number): number {
  const base = openPassable(state);
  const start = idx(x, y);
  const seen = new Set<number>([start]);
  const queue = [start];
  let head = 0;
  let count = 0;
  while (head < queue.length && count < FREE_CAP) {
    const cur = queue[head]!;
    head += 1;
    const e = danger.earliestLethal(cur);
    if (e === undefined || e > SURV_SAFE_HORIZON) count += 1;
    const cx = cur % MAP_COLS;
    const cy = (cur - cx) / MAP_COLS;
    for (const d of DIRECTION_ORDER) {
      const nx = cx + dirDX(d);
      const ny = cy + dirDY(d);
      if (!inBounds(nx, ny) || !base(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (seen.has(ni)) continue;
      const ne = danger.earliestLethal(ni);
      if (ne !== undefined && ne <= STEP_DANGER_HORIZON) continue;
      seen.add(ni);
      queue.push(ni);
    }
  }
  return count;
}

interface Sample {
  tick: number;
  branches: number;
  foeMan: number;
  free: number;
  devGap: number; // (myFire+myCannon) - (foeFire+foeCannon)
  enemyBombsNear: number;
  board?: BoardSnap; // full map state for this tick (only when --boards is on).
}

/** Full per-tick map state for the ASCII board render — every tile + every bomb
 *  (with fuse) + the flame/danger footprint, so a LOSS can be replayed visually
 *  second-by-second to see HOW the seal closes (which tiles the bombs deny). */
interface BoardSnap {
  map: Uint8Array; // clone of state.map (TileKind per tile).
  bombs: { x: number; y: number; fire: number; fuse: number; mine: boolean }[];
  items: { x: number; y: number }[];
  meX: number;
  meY: number;
  foeX: number;
  foeY: number;
  foeShown: boolean; // foe alive & not trapped (else don't draw it).
  /** Per-tile danger: 0 safe, 1 will burn within the fuse (~3 s), 2 burning now. */
  lethal: Uint8Array;
}

/** Render a BoardSnap as 13 rows of 15 chars. Legend:
 *  @ target · E foe · B bomb · X flame-now · x danger-soon · # wall · : soft
 *  % crate · i item · · safe-open */
function renderBoard(b: BoardSnap): string[] {
  const bombAt = new Set<number>(b.bombs.map((bm) => bm.y * MAP_COLS + bm.x));
  const itemAt = new Set<number>(b.items.map((it) => it.y * MAP_COLS + it.x));
  const lines: string[] = [];
  for (let y = 0; y < MAP_ROWS; y++) {
    let row = '';
    for (let x = 0; x < MAP_COLS; x++) {
      const t = y * MAP_COLS + x;
      if (x === b.meX && y === b.meY) row += '@';
      else if (b.foeShown && x === b.foeX && y === b.foeY) row += 'E';
      else if (bombAt.has(t)) row += 'B';
      else if (itemAt.has(t)) row += 'i';
      else if (b.map[t] === TileKind.HARD) row += '#';
      else if (b.map[t] === TileKind.SOFT) row += ':';
      else if (b.map[t] === TileKind.PUSH) row += '%';
      else row += b.lethal[t] === 2 ? 'X' : b.lethal[t] === 1 ? 'x' : '·';
    }
    lines.push('      ' + row);
  }
  return lines;
}

interface Loss {
  deathTick: number;
  cause: 'SEALED' | 'OPEN' | 'TRAPPED';
  atDeath: Sample;
  /** Trajectory snapshots, parallel to TRACE_SECONDS (null = before game start). */
  trace: (Sample | null)[];
}

function devSum(p: { fire: number; cannon: number }): number {
  return p.fire + p.cannon;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const target = parseChallenger(arg(argv, 'target', 'v5:zoner'));
  const opponent = parseChallenger(arg(argv, 'opponent', 'v3:trapper'));
  const repeats = Number(arg(argv, 'repeats', '40'));
  // --boards=N: also dump the per-second ASCII MAP STATE (bombs, flame, walls,
  // both players) for the first N LOSS games per map, so the seal can be read
  // tile-by-tile. 0 = off (aggregate scalars only). Heavy → keep N small (1-3).
  const boardsN = Number(arg(argv, 'boards', '0'));
  const mapArg = arg(argv, 'map', '');
  const selMaps = mapArg
    ? (mapArg.split(',').map((s) => s.trim()) as MapKind[]).filter((m) => MAPS.includes(m))
    : MAPS;

  console.log(
    `v5-diag: ${target.label} vs ${opponent.label}  ${repeats} repeats × 2 seatings × ${selMaps.length} map(s) [${selMaps.join(', ')}]`,
  );

  for (const map of selMaps) {
    const mapIndex = MAPS.indexOf(map);
    let wins = 0;
    let losses = 0;
    let draws = 0;
    const lossRecords: Loss[] = [];
    // For comparison: target's window-mean features sampled at game end in WINS.
    const winWindowBranches: number[] = [];
    const winWindowFoeMan: number[] = [];
    // --boards: capture map snapshots until N losses have been dumped this map.
    let boardsRendered = 0;

    for (let r = 0; r < repeats; r++) {
      const seed = scenarioSeed(mapIndex, r);
      for (let seat = 0; seat < 2; seat++) {
        // seat 0: target in slot 0, opponent slot 1; seat 1: swapped.
        const targetSlot = seat === 0 ? 0 : 1;
        const oppSlot = seat === 0 ? 1 : 0;
        const agents = [target, opponent];
        const slotAgent = seat === 0 ? [0, 1] : [1, 0];

        let state: SimState = createInitialState(seed, makeFeelParams(), 2, {
          pvp: true,
          teams: [0, 1],
          map,
        });
        const ctrls = [0, 1].map((s) => {
          const a = agents[slotAgent[s]!]!;
          return makeController(a.version, a.archetypeKey, seed, s);
        });

        const ring: Sample[] = [];
        let targetDeathTick = -1;
        let wasTrappedRecently = false;

        while (state.phase === GamePhase.PLAYING && state.tick < 10800) {
          const frame: InputFrame[] = [0, 1].map((s) => ctrls[s]!.sample(state, s));
          // Sample the target's features BEFORE advancing (state the bot saw).
          const me = state.players[targetSlot]!;
          const foe = state.players[oppSlot]!;
          if (me.alive && !me.trapped) {
            const danger = buildDangerMap(state);
            const mx = tileOf(me.posX);
            const my = tileOf(me.posY);
            const fx = tileOf(foe.posX);
            const fy = tileOf(foe.posY);
            let foeMan = Math.abs(mx - fx) + Math.abs(my - fy);
            if (foe.alive && !foe.trapped) {
              const hit = bfsFirstStep(state, mx, my, (x, y) => x === fx && y === fy, openPassable(state));
              if (hit !== null) foeMan = hit.dist;
            }
            let enemyBombsNear = 0;
            for (const b of state.bombs) {
              if (b.ownerSlot === targetSlot) continue;
              if (Math.abs(b.tileX - mx) + Math.abs(b.tileY - my) <= b.fire + 2) enemyBombsNear += 1;
            }
            // Capture the full map state only while we still owe board dumps —
            // once N losses are rendered this map, stop the per-tick clone cost.
            let board: BoardSnap | undefined;
            if (boardsN > 0 && boardsRendered < boardsN) {
              const lethal = new Uint8Array(MAP_COLS * MAP_ROWS);
              for (let t = 0; t < lethal.length; t++) {
                const e = danger.earliestLethal(t);
                lethal[t] = e === undefined ? 0 : e <= SPARK_TICKS ? 2 : e <= FUSE_TICKS ? 1 : 0;
              }
              board = {
                map: Uint8Array.from(state.map),
                bombs: state.bombs.map((b) => ({
                  x: b.tileX, y: b.tileY, fire: b.fire, fuse: b.fuseTicks,
                  mine: b.ownerSlot === targetSlot,
                })),
                items: state.items.map((it) => ({ x: it.tileX, y: it.tileY })),
                meX: mx, meY: my, foeX: fx, foeY: fy,
                foeShown: foe.alive && !foe.trapped,
                lethal,
              };
            }
            ring.push({
              tick: state.tick,
              branches: escapeBranches(state, danger, mx, my),
              foeMan,
              free: freeSpace(state, danger, mx, my),
              devGap: devSum(me) - devSum(foe),
              enemyBombsNear,
              board,
            });
            if (ring.length > RING_CAP) ring.shift();
          }
          if (me.trapped) wasTrappedRecently = true;
          state = tick(state, frame);
          if (targetDeathTick === -1 && !state.players[targetSlot]!.alive) {
            targetDeathTick = state.tick;
            break;
          }
        }

        const targetAlive = state.players[targetSlot]!.alive;
        const oppAlive = state.players[oppSlot]!.alive;
        if (targetAlive && !oppAlive) {
          wins += 1;
          if (ring.length > 0) {
            const w = ring.slice(-Math.min(ring.length, WINDOW));
            winWindowBranches.push(mean(w.map((s) => s.branches)));
            winWindowFoeMan.push(mean(w.map((s) => s.foeMan)));
          }
        } else if (!targetAlive && oppAlive) {
          losses += 1;
          const atDeath = ring[ring.length - 1] ?? null;
          if (atDeath !== null) {
            const cause: Loss['cause'] = wasTrappedRecently
              ? 'TRAPPED'
              : atDeath.branches <= 1
                ? 'SEALED'
                : 'OPEN';
            const trace = TRACE_SECONDS.map((s) => sampleAt(ring, targetDeathTick - s * 60));
            lossRecords.push({ deathTick: targetDeathTick, cause, atDeath, trace });
            // --boards: dump the per-second map for this loss (seal close-up).
            if (boardsN > 0 && boardsRendered < boardsN) {
              boardsRendered += 1;
              console.log(
                `\n  ┌─ LOSS #${boardsRendered} on ${map} (${cause}, death tick ${targetDeathTick}, seat ${seat}) ` +
                  `— @ target  E foe  B bomb  X flame-now  x danger-soon  # wall  : soft  % crate  i item  · safe`,
              );
              for (let i = TRACE_SECONDS.length - 1; i >= 0; i--) {
                const s = trace[i];
                if (!s?.board) continue;
                console.log(
                  `  t−${String(TRACE_SECONDS[i]).padStart(2)}s  branches=${s.branches} free=${s.free} foeDist=${s.foeMan} enemyBmbNear=${s.enemyBombsNear}`,
                );
                for (const line of renderBoard(s.board)) console.log(line);
              }
            }
          }
        } else if (!targetAlive && !oppAlive) {
          draws += 1;
        } else {
          // Both alive at cap: tiebreak — count by dev for a rough W/L (not a kill).
          const me = state.players[targetSlot]!;
          const foe = state.players[oppSlot]!;
          if (devSum(me) > devSum(foe)) wins += 1;
          else if (devSum(me) < devSum(foe)) losses += 1;
          else draws += 1;
        }
      }
    }

    report(map, wins, losses, draws, lossRecords, winWindowBranches, winWindowFoeMan);
  }
}

function sampleAt(ring: Sample[], atTick: number): Sample | null {
  let best: Sample | null = null;
  for (const s of ring) {
    if (s.tick <= atTick) best = s;
    else break;
  }
  return best;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function report(
  map: MapKind,
  wins: number,
  losses: number,
  draws: number,
  lossRecords: Loss[],
  winBranches: number[],
  winFoeMan: number[],
): void {
  const total = wins + losses + draws;
  const winPct = total === 0 ? 0 : (wins / total) * 100;
  console.log(`\n===== ${map} =====`);
  console.log(`games=${total}  target W/L/D = ${wins}/${losses}/${draws}  (winPct ${winPct.toFixed(1)}%)`);
  if (lossRecords.length === 0) {
    console.log('  no kill-losses recorded.');
  } else {
    const byCause: Record<string, number> = { SEALED: 0, OPEN: 0, TRAPPED: 0 };
    let preHunt = 0;
    let mid = 0;
    let shrink = 0;
    for (const l of lossRecords) {
      byCause[l.cause] = (byCause[l.cause] ?? 0) + 1;
      if (l.deathTick < 1200) preHunt += 1;
      else if (l.deathTick < SUDDEN_DEATH_START_TICK) mid += 1;
      else shrink += 1;
    }
    console.log(
      `  LOSS CAUSES: SEALED(dead-end) ${byCause.SEALED}  OPEN(timing) ${byCause.OPEN}  TRAPPED(shell) ${byCause.TRAPPED}`,
    );
    console.log(
      `  DEATH PHASE: pre-hunt(<20s) ${preHunt}  mid ${mid}  shrink(>=120s) ${shrink}`,
    );
    // Dense per-second trajectory: each column is a TRACE_SECONDS offset (0 =
    // death), so the seal's onset is visible as the column where branches/free
    // collapse — and a slower strategic drift shows as a gentle slope further out.
    console.log('  TARGET trajectory before a LOSS (mean; columns = seconds before death):');
    console.log('    sec→death' + TRACE_SECONDS.map((s) => String(s).padStart(6)).join(''));
    const row = (label: string, f: (s: Sample) => number): void => {
      const cells = TRACE_SECONDS.map((_, i) => {
        const vals = lossRecords
          .map((l) => l.trace[i])
          .filter((s): s is Sample => s != null)
          .map(f);
        return (vals.length === 0 ? '-' : mean(vals).toFixed(1)).padStart(6);
      });
      console.log(`    ${label.padEnd(9)}` + cells.join(''));
    };
    row('branches', (s) => s.branches);
    row('freeSpace', (s) => s.free);
    row('foeDist', (s) => s.foeMan);
    row('devGap', (s) => s.devGap);
    row('enemyBmb', (s) => s.enemyBombsNear);
    console.log(
      `    (WIN-game last-10s mean: branches ${mean(winBranches).toFixed(2)}  foeDist ${mean(winFoeMan).toFixed(2)})`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
