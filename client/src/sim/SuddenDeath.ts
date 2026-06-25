/**
 * Sudden death (late-match arena shrink).
 *
 * Pure / prng-free, like the rest of the sim core: the number of hardened tiles
 * is a pure integer function of the tick, so every client closes the arena in
 * lockstep with zero PRNG draws. The hardened tiles ARE part of the (hashed)
 * grid; the spiral order is a compile-time constant of the map dimensions.
 *
 * Mechanic: from SUDDEN_DEATH_START_TICK, one tile per
 * SUDDEN_DEATH_TILE_INTERVAL ticks turns HARD, walking an inward spiral from the
 * grid's true outermost ring (row/col 0) to the center. An alive player standing on a
 * tile the instant it hardens is crushed — eliminated outright (a fully
 * solidified tile entombs; this is NOT a melt-flow sugar shell, so there is no
 * rescue or timeout window). The encroaching wall is just HARD bricks, so
 * movement, melt-flow arms and the AI's grid/danger views all respect it for
 * free — no mirror needed.
 */
import {
  MAP_COLS,
  MAP_ROWS,
  SUDDEN_DEATH_START_TICK,
  SUDDEN_DEATH_TILE_INTERVAL,
} from '../../../shared/constants';
import { TileKind } from '../../../shared/types';
import { type TileGrid, idx } from './Map';
import { type PlayerState, tileOf } from './Player';

/**
 * Inward-spiral order over the WHOLE grid (x in 0..COLS-1, y in 0..ROWS-1): the
 * true outermost ring first (clockwise from the top-left corner), shrinking to
 * the center. The authored maps fill the entire grid — there is no permanent
 * hard-wall border — so the shrink must start at row/col 0, not one ring in.
 * Built once; a pure function of the map dimensions.
 */
export const SPIRAL_ORDER: ReadonlyArray<readonly [number, number]> = buildSpiral();

function buildSpiral(): Array<[number, number]> {
  const order: Array<[number, number]> = [];
  let top = 0;
  let bottom = MAP_ROWS - 1;
  let left = 0;
  let right = MAP_COLS - 1;
  while (top <= bottom && left <= right) {
    for (let x = left; x <= right; x++) order.push([x, top]);
    top++;
    for (let y = top; y <= bottom; y++) order.push([right, y]);
    right--;
    if (top <= bottom) {
      for (let x = right; x >= left; x--) order.push([x, bottom]);
      bottom--;
    }
    if (left <= right) {
      for (let y = bottom; y >= top; y--) order.push([left, y]);
      left++;
    }
  }
  return order;
}

/** How many spiral tiles have hardened by `tick` (0 before sudden death). */
export function hardenedCount(tick: number): number {
  if (tick < SUDDEN_DEATH_START_TICK) return 0;
  const n =
    Math.floor((tick - SUDDEN_DEATH_START_TICK) / SUDDEN_DEATH_TILE_INTERVAL) + 1;
  return Math.min(n, SPIRAL_ORDER.length);
}

/**
 * Apply this tick's sudden-death encroachment: harden the spiral tiles that
 * should have fallen by `tick` but had not yet fallen as of `tick - 1`, and
 * crush (eliminate) any alive player standing on a freshly-hardened tile.
 * MUTATES `grid` and the player clones. No-op before SUDDEN_DEATH_START_TICK.
 */
export function stepSuddenDeath(
  grid: TileGrid,
  players: PlayerState[],
  tick: number,
): void {
  const to = hardenedCount(tick);
  const from = hardenedCount(tick - 1);
  for (let i = from; i < to; i++) {
    const cell = SPIRAL_ORDER[i]!;
    const x = cell[0]!;
    const y = cell[1]!;
    grid[idx(x, y)] = TileKind.HARD;
    for (const p of players) {
      if (p.alive && tileOf(p.posX) === x && tileOf(p.posY) === y) {
        p.alive = false;
        p.trapped = false;
        p.trappedTicks = 0;
      }
    }
  }
}
