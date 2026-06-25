/**
 * Detonation (chocolate melting): cross-shaped melt-flow.
 *
 * Processing rules per arm step:
 * - off-map or HARD brick → arm stops, no cell there;
 * - SOFT brick → destroy it (set EMPTY), maybe drop an item, arm STOPS; the
 *   cleared tile gets NO cell so it is immediately safe to enter (grab item);
 * - another bomb → chain-detonate it (same tick), arm STOPS (the chained
 *   bomb's own center cell covers that tile);
 * - otherwise → spawn a cell, continue outward.
 *
 * Arms read the TICK-START layout, not the grid we mutate as bricks clear: a
 * brick standing when the tick began blocks EVERY bomb going off this tick, so a
 * chained bomb can't flow through a brick a sibling just cleared (each arm clears
 * at most one brick). This matches the AI danger model (dangerMap.ts).
 *
 * Determinism contract — fixed processing order (PRNG draws happen inside):
 * detonations are processed FIFO starting from bombs whose fuse expired this
 * tick in bomb-array order, appending chained bombs as they are found; each
 * detonation walks its arms in UP, DOWN, LEFT, RIGHT order, steps inner→outer.
 * Each destroyed soft brick draws 1 `prngFloat` (drop roll) and, when it
 * drops, 1 `prngInt(0,2)` (kind: 0=fire, 1=speed, 2=cannon).
 *
 * Items already on the floor are NOT destroyed by melt-flow (M1 decision).
 */
import {
  HIT_COVER_DEN,
  HIT_COVER_NUM,
  ITEM_DROP_RATE,
  MILLITILE,
  SPARK_TICKS,
} from '../../../shared/constants';
import { type ItemKind, TileKind, isDestructibleBrick } from '../../../shared/types';
import type { BombState } from './Bomb';
import type { ItemState } from './Item';
import { type TileGrid, idx, inBounds } from './Map';
import { prngFloat, prngInt } from './Prng';

export interface ExplosionState {
  tileX: number;
  tileY: number;
  /** Remaining ticks; spawned at SPARK_TICKS, removed at 0. */
  ttlTicks: number;
}

/** Arm directions in fixed processing order: UP, DOWN, LEFT, RIGHT. */
const ARM_DELTAS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
];

export interface DetonationResult {
  /** Bombs that survived this tick (detonated ones removed). */
  bombs: BombState[];
  /** Newly spawned explosion cells. */
  cells: ExplosionState[];
  /** Newly dropped items. */
  items: ItemState[];
  /** Owner slot of every detonated bomb (to decrement activeBombs). */
  detonatedOwners: number[];
  prng: number;
}

/**
 * Detonate every bomb whose fuse reached 0, including chains.
 * MUTATES `grid` (caller passes a fresh clone for this tick); `bombs` is not
 * mutated. The chain queue is bounded by bombs.length, so it cannot loop.
 */
export function processDetonations(
  grid: TileGrid,
  bombs: readonly BombState[],
  prng: number,
): DetonationResult {
  const detonated: boolean[] = bombs.map(() => false);
  const queue: number[] = [];
  for (let i = 0; i < bombs.length; i++) {
    const b = bombs[i];
    if (b !== undefined && b.fuseTicks <= 0) {
      detonated[i] = true;
      queue.push(i);
    }
  }

  // Tick-start tile layout. Blast arms propagate against THIS, not the grid we
  // mutate as bricks clear — so a brick standing when the tick began shields what
  // is behind it from EVERY bomb going off this tick, and each arm clears at most
  // one brick. Mutating mid-propagation let a chained bomb flow through a brick a
  // sibling bomb had just cleared and burn players the wall should have stopped.
  const startGrid = grid.slice();

  const cells: ExplosionState[] = [];
  const items: ItemState[] = [];
  const detonatedOwners: number[] = [];
  let p = prng;

  for (let q = 0; q < queue.length; q++) {
    const bi = queue[q];
    if (bi === undefined) continue;
    const bomb = bombs[bi];
    if (bomb === undefined) continue;
    detonatedOwners.push(bomb.ownerSlot);
    cells.push({ tileX: bomb.tileX, tileY: bomb.tileY, ttlTicks: SPARK_TICKS });

    for (const [dx, dy] of ARM_DELTAS) {
      for (let step = 1; step <= bomb.fire; step++) {
        const tx = bomb.tileX + dx * step;
        const ty = bomb.tileY + dy * step;
        const cell = idx(tx, ty);
        // Read the tick-start layout: a brick a sibling bomb already cleared this
        // tick still blocks here (and HARD never changes mid-tick anyway).
        if (!inBounds(tx, ty) || startGrid[cell] === TileKind.HARD) break;
        if (isDestructibleBrick(startGrid[cell]!)) {
          // SOFT or pushable PUSH brick: clear it + roll its drop ONCE per tick —
          // the first arm to reach it. A later arm meeting the same tick-start
          // brick still stops here but neither re-clears nor re-rolls (grid is
          // already EMPTY there).
          if (isDestructibleBrick(grid[cell]!)) {
            grid[cell] = TileKind.EMPTY;
            // The just-cleared tile gets NO flame cell: it is immediately safe
            // to enter, so a player can rush in and grab a dropped item without
            // being burned. The arm still stops here.
            let roll: number;
            [roll, p] = prngFloat(p);
            if (roll < ITEM_DROP_RATE) {
              let kind: number;
              [kind, p] = prngInt(p, 0, 2);
              items.push({ tileX: tx, tileY: ty, kind: kind as ItemKind });
            }
          }
          break;
        }
        // EMPTY tile: chain an undetonated bomb sitting on it, else flow on.
        let chained = false;
        for (let j = 0; j < bombs.length; j++) {
          const other = bombs[j];
          if (
            other !== undefined &&
            !detonated[j] &&
            other.tileX === tx &&
            other.tileY === ty
          ) {
            detonated[j] = true;
            queue.push(j);
            chained = true;
            break;
          }
        }
        if (chained) break;
        cells.push({ tileX: tx, tileY: ty, ttlTicks: SPARK_TICKS });
      }
    }
  }

  return {
    bombs: bombs.filter((_, i) => !detonated[i]),
    cells,
    items,
    detonatedOwners,
    prng: p,
  };
}

/** True when tile (tx, ty) is covered by any active explosion cell. */
export function explosionAt(
  cells: readonly ExplosionState[],
  tx: number,
  ty: number,
): boolean {
  for (const c of cells) {
    if (c.tileX === tx && c.tileY === ty) return true;
  }
  return false;
}

/**
 * True when the player's 1-tile body box is ≥ HIT_COVER_NUM/HIT_COVER_DEN
 * covered by flame cells — the BnB-style lenient hitbox (you must be mostly
 * inside the melt-flow to be trapped, not merely past the tile boundary).
 *
 * The body is the unit box centred on (posX, posY); it overlaps the nearest
 * tile plus, on each axis it is off-centre, the one neighbour it straddles into
 * (≤4 tiles). Coverage is the exact integer overlap area in millitiles² summed
 * over the flame tiles among those — no float, no sqrt, fully deterministic. At
 * a tile centre every off-tile overlap is 0, so this reduces to "own tile on
 * fire", agreeing with the AI's tile-granular danger model.
 */
export function explosionCovers(
  cells: readonly ExplosionState[],
  posX: number,
  posY: number,
): boolean {
  const tx = Math.round(posX / MILLITILE);
  const ty = Math.round(posY / MILLITILE);
  const ox = posX - tx * MILLITILE; // body-centre offset, [-MILLITILE/2, +MILLITILE/2]
  const oy = posY - ty * MILLITILE;
  const sx = ox >= 0 ? 1 : -1; // the neighbour tile the body straddles into
  const sy = oy >= 0 ? 1 : -1;
  let area = 0; // covered area, millitiles²
  for (const nx of [0, sx]) {
    const ovx = MILLITILE - Math.abs(ox - nx * MILLITILE); // overlap width with column tx+nx
    if (ovx <= 0) continue; // aligned axis: neighbour column contributes nothing
    for (const ny of [0, sy]) {
      const ovy = MILLITILE - Math.abs(oy - ny * MILLITILE);
      if (ovy > 0 && explosionAt(cells, tx + nx, ty + ny)) area += ovx * ovy;
    }
  }
  return area * HIT_COVER_DEN >= HIT_COVER_NUM * MILLITILE * MILLITILE;
}
