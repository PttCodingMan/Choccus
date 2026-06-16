/**
 * Closed-loop scripting bot used ONLY by gen-fixtures.ts to author replay
 * fixtures. Scripts are generators that yield once per tick after setting the
 * desired inputs on the BotCtx; the recorder (gen-fixtures) advances the sim
 * and captures the inputs as a sparse event list. The committed fixtures are
 * plain open-loop input lists — this bot never runs at test time.
 *
 * Helpers throw GenFail on timeout / no-path / unexpected trap so the
 * generator can discard a seed and try the next one (seed search is a fixed
 * ascending scan → fully reproducible).
 */
import { FUSE_TICKS, MAP_COLS, SPARK_TICKS } from '../../../shared/constants';
import { ActionFlags, Direction, TileKind } from '../../../shared/types';
import { type BombState, bombAt } from '../../../client/src/sim/Bomb';
import { DIRECTION_ORDER } from '../../../client/src/sim/InputBuffer';
import { idx, inBounds } from '../../../client/src/sim/Map';
import {
  dirDX,
  dirDY,
  isOpen,
  tileOf,
} from '../../../client/src/sim/Player';
import { prngFloat, prngInt } from '../../../client/src/sim/Prng';
import type { SimState } from '../../../client/src/sim/Sim';

export class GenFail extends Error {}

export interface BotCtx {
  /** Pre-tick state; the recorder replaces it after every tick(). */
  state: SimState;
  /** Set this tick's input for a slot (defaults reset to NO_INPUT each tick). */
  setInput(slot: number, dir?: number, action?: number): void;
}

export type Script = Generator<void, void, void>;

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function playerTile(state: SimState, slot: number): [number, number] {
  const p = state.players[slot];
  if (p === undefined) throw new GenFail(`no player in slot ${slot}`);
  return [tileOf(p.posX), tileOf(p.posY)];
}

type Passable = (x: number, y: number) => boolean;

export function openPassable(state: SimState): Passable {
  return (x, y) => isOpen(state.map, state.bombs, x, y);
}

interface BfsHit {
  /** Direction bit of the first step (Direction.NONE when already at goal). */
  firstDir: number;
  /** Full tile path, start..target inclusive. */
  path: Array<[number, number]>;
  target: [number, number];
}

/**
 * BFS over tiles from (fromX, fromY) to the nearest tile satisfying `isGoal`.
 * The start tile is exempt from `passable` (the bot may stand on its own
 * bomb). Neighbor order is fixed U,D,L,R. Returns null when unreachable.
 */
export function bfs(
  state: SimState,
  fromX: number,
  fromY: number,
  isGoal: (x: number, y: number) => boolean,
  passable: Passable,
): BfsHit | null {
  const cols = MAP_COLS;
  const start = idx(fromX, fromY);
  const prev = new Map<number, number>([[start, -1]]);
  const queue: number[] = [start];
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi]!;
    const cx = cur % cols;
    const cy = (cur - cx) / cols;
    if (isGoal(cx, cy)) {
      const path: Array<[number, number]> = [];
      for (let n = cur; n !== -1; n = prev.get(n)!) {
        const nx = n % cols;
        path.unshift([nx, (n - nx) / cols]);
      }
      let firstDir: number = Direction.NONE;
      if (path.length > 1) {
        const [sx, sy] = path[0]!;
        const [nx, ny] = path[1]!;
        for (const d of DIRECTION_ORDER) {
          if (sx + dirDX(d) === nx && sy + dirDY(d) === ny) firstDir = d;
        }
      }
      return { firstDir, path, target: [cx, cy] };
    }
    for (const d of DIRECTION_ORDER) {
      const nx = cx + dirDX(d);
      const ny = cy + dirDY(d);
      if (!inBounds(nx, ny) || !passable(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (prev.has(ni)) continue;
      prev.set(ni, cur);
      queue.push(ni);
    }
  }
  return null;
}

/**
 * Union of every tile covered if all `state.bombs` (+ hypothetical extras)
 * detonated: bomb tile + cross arms, stopping at hard bricks / map edge and
 * stopping ON (inclusive) soft bricks. Conservative enough for retreat
 * planning — chains only re-cover tiles already in the union of crosses.
 */
export function predictBlastSet(
  state: SimState,
  extra: readonly BombState[] = [],
): Set<number> {
  const blast = new Set<number>();
  for (const b of [...state.bombs, ...extra]) {
    blast.add(idx(b.tileX, b.tileY));
    for (const d of DIRECTION_ORDER) {
      for (let step = 1; step <= b.fire; step++) {
        const tx = b.tileX + dirDX(d) * step;
        const ty = b.tileY + dirDY(d) * step;
        if (!inBounds(tx, ty) || state.map[idx(tx, ty)] === TileKind.HARD) break;
        blast.add(idx(tx, ty));
        if (state.map[idx(tx, ty)] === TileKind.SOFT) break;
      }
    }
  }
  return blast;
}

export function findNearestSafe(
  state: SimState,
  slot: number,
  extra: readonly BombState[] = [],
): [number, number] | null {
  const blast = predictBlastSet(state, extra);
  const [cx, cy] = playerTile(state, slot);
  const hit = bfs(state, cx, cy, (x, y) => !blast.has(idx(x, y)), openPassable(state));
  return hit === null ? null : hit.target;
}

// ---------------------------------------------------------------------------
// Script primitives (each yield = one tick)
// ---------------------------------------------------------------------------

export function* idle(ticks: number): Script {
  for (let i = 0; i < ticks; i++) yield;
}

export function* waitUntil(
  ctx: BotCtx,
  pred: (s: SimState) => boolean,
  maxTicks: number,
  what: string,
): Script {
  for (let i = 0; i < maxTicks; i++) {
    if (pred(ctx.state)) return;
    yield;
  }
  if (pred(ctx.state)) return;
  throw new GenFail(`waitUntil timeout (${maxTicks} ticks): ${what}`);
}

/** Walk slot to tile (tx, ty) via BFS over open tiles, re-planned every tick. */
export function* goTo(ctx: BotCtx, slot: number, tx: number, ty: number): Script {
  let lastX = -1;
  let lastY = -1;
  let stuck = 0;
  for (;;) {
    const p = ctx.state.players[slot];
    if (p === undefined || !p.alive) throw new GenFail(`goTo: player ${slot} dead`);
    if (p.trapped) throw new GenFail(`goTo: player ${slot} trapped`);
    const [cx, cy] = playerTile(ctx.state, slot);
    if (cx === tx && cy === ty) return;
    const hit = bfs(
      ctx.state,
      cx,
      cy,
      (x, y) => x === tx && y === ty,
      openPassable(ctx.state),
    );
    if (hit === null || hit.firstDir === Direction.NONE) {
      throw new GenFail(`goTo: no path for slot ${slot} to (${tx},${ty})`);
    }
    ctx.setInput(slot, hit.firstDir);
    if (p.posX === lastX && p.posY === lastY) {
      stuck += 1;
      if (stuck > 60) throw new GenFail(`goTo: slot ${slot} stuck at (${cx},${cy})`);
    } else {
      stuck = 0;
    }
    lastX = p.posX;
    lastY = p.posY;
    yield;
  }
}

/** One-tick BOMB press (rising edge; the next tick reverts to NO_INPUT). */
export function* pressBomb(ctx: BotCtx, slot: number): Script {
  ctx.setInput(slot, Direction.NONE, ActionFlags.BOMB);
  yield;
}

/**
 * Place a bomb at the current tile, retreat to the nearest blast-safe tile,
 * and (by default) wait until ALL bombs and explosions are gone.
 */
export function* bombAndRetreat(
  ctx: BotCtx,
  slot: number,
  opts: { waitClear?: boolean } = {},
): Script {
  const before = ctx.state.bombs.length;
  yield* pressBomb(ctx, slot);
  if (ctx.state.bombs.length <= before) throw new GenFail(`bomb not placed by ${slot}`);
  const safe = findNearestSafe(ctx.state, slot);
  if (safe === null) throw new GenFail(`no safe tile for slot ${slot}`);
  yield* goTo(ctx, slot, safe[0], safe[1]);
  if (opts.waitClear !== false) {
    yield* waitUntil(
      ctx,
      (s) => s.bombs.length === 0 && s.explosions.length === 0,
      FUSE_TICKS + SPARK_TICKS + 90,
      'blast cleared',
    );
  }
}

/**
 * Reach (tx, ty), bombing through soft bricks when no open path exists:
 * route over EMPTY|SOFT tiles, walk to the tile just before the first soft
 * brick, bomb it, retreat, wait, repeat.
 */
export function* clearPathTo(ctx: BotCtx, slot: number, tx: number, ty: number): Script {
  for (let iter = 0; iter < 24; iter++) {
    const [cx, cy] = playerTile(ctx.state, slot);
    if (cx === tx && cy === ty) return;
    const goal = (x: number, y: number): boolean => x === tx && y === ty;
    const open = bfs(ctx.state, cx, cy, goal, openPassable(ctx.state));
    if (open !== null) {
      yield* goTo(ctx, slot, tx, ty);
      return;
    }
    const soft = bfs(
      ctx.state,
      cx,
      cy,
      goal,
      (x, y) =>
        ctx.state.map[idx(x, y)] !== TileKind.HARD &&
        bombAt(ctx.state.bombs, x, y) === undefined,
    );
    if (soft === null) throw new GenFail(`clearPathTo: no route to (${tx},${ty})`);
    const firstSoft = soft.path.findIndex(
      ([x, y]) => ctx.state.map[idx(x, y)] === TileKind.SOFT,
    );
    if (firstSoft <= 0) throw new GenFail('clearPathTo: route had no soft brick');
    const pre = soft.path[firstSoft - 1]!;
    yield* goTo(ctx, slot, pre[0], pre[1]);
    yield* bombAndRetreat(ctx, slot);
  }
  throw new GenFail('clearPathTo: too many bombing iterations');
}

/** Seeded random walk among open neighbor directions for `ticks` ticks. */
export function* wander(ctx: BotCtx, slot: number, ticks: number, rngSeed: number): Script {
  let rng = rngSeed >>> 0;
  let dir: number = Direction.NONE;
  let hold = 0;
  for (let t = 0; t < ticks; t++) {
    const p = ctx.state.players[slot];
    if (p === undefined || !p.alive || p.trapped) {
      yield;
      continue;
    }
    if (hold <= 0) {
      const [cx, cy] = playerTile(ctx.state, slot);
      const open = DIRECTION_ORDER.filter((d) =>
        isOpen(ctx.state.map, ctx.state.bombs, cx + dirDX(d), cy + dirDY(d)),
      );
      if (open.length > 0) {
        let pick: number;
        [pick, rng] = prngInt(rng, 0, open.length - 1);
        dir = open[pick]!;
      } else {
        dir = Direction.NONE;
      }
      [hold, rng] = prngInt(rng, 8, 26);
    }
    if (dir !== Direction.NONE) ctx.setInput(slot, dir);
    hold -= 1;
    yield;
  }
}

/**
 * Free-for-all loop until state.tick >= untilTick: rescue a trapped partner
 * when possible, otherwise opportunistically bomb (only with a reachable
 * escape) or wander. Resilient: GenFail from sub-steps is swallowed so the
 * fixture keeps running through emergent chaos.
 */
export function* rampage(
  ctx: BotCtx,
  slot: number,
  untilTick: number,
  rngSeed: number,
): Script {
  let rng = rngSeed >>> 0;
  while (ctx.state.tick < untilTick) {
    const s = ctx.state;
    const p = s.players[slot];
    if (p === undefined || !p.alive || p.trapped) {
      yield;
      continue;
    }
    const partner = s.players.find((q) => q.slot !== slot && q.alive && q.trapped);
    if (partner !== undefined) {
      try {
        yield* goTo(ctx, slot, tileOf(partner.posX), tileOf(partner.posY));
      } catch (e) {
        if (!(e instanceof GenFail)) throw e;
        yield;
      }
      continue;
    }
    let roll: number;
    [roll, rng] = prngFloat(rng);
    if (roll < 0.3 && p.activeBombs < p.cannon) {
      const [cx, cy] = playerTile(s, slot);
      const hypo: BombState = {
        ownerSlot: p.slot,
        tileX: cx,
        tileY: cy,
        fuseTicks: FUSE_TICKS,
        fire: p.fire,
      };
      const blast = predictBlastSet(s, [hypo]);
      const escape = bfs(s, cx, cy, (x, y) => !blast.has(idx(x, y)), openPassable(s));
      if (escape !== null && escape.path.length - 1 <= 8) {
        try {
          yield* pressBomb(ctx, slot);
          yield* goTo(ctx, slot, escape.target[0], escape.target[1]);
          yield* waitUntil(
            ctx,
            (st) => !st.bombs.some((b) => b.ownerSlot === slot),
            FUSE_TICKS + 90,
            'own bomb gone',
          );
          yield* idle(SPARK_TICKS + 5);
        } catch (e) {
          if (!(e instanceof GenFail)) throw e;
          yield;
        }
        continue;
      }
    }
    let hold: number;
    [hold, rng] = prngInt(rng, 10, 30);
    const [cx, cy] = playerTile(ctx.state, slot);
    const open = DIRECTION_ORDER.filter((d) =>
      isOpen(ctx.state.map, ctx.state.bombs, cx + dirDX(d), cy + dirDY(d)),
    );
    if (open.length === 0) {
      yield;
      continue;
    }
    let pick: number;
    [pick, rng] = prngInt(rng, 0, open.length - 1);
    const dir = open[pick]!;
    for (let k = 0; k < hold && ctx.state.tick < untilTick; k++) {
      const pp = ctx.state.players[slot];
      if (pp === undefined || !pp.alive || pp.trapped) break;
      ctx.setInput(slot, dir);
      yield;
    }
  }
}
