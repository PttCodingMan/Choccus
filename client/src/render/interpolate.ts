/**
 * Render-side interpolation helpers (Pixi-free math, but render-only —
 * never imported by sim/).
 *
 * The sim advances in whole 60 Hz ticks; the renderer runs on rAF and blends
 * entity positions between the previous and next SimState with `alpha` =
 * fraction of the current tick already elapsed.
 *
 * Entity matching (who interpolates against whom):
 * - players: by `slot` (stable for the whole match);
 * - bombs / items / explosion cells: tile-locked, they never move, so they
 *   render straight from the next state without interpolation.
 *
 * SNAP rule: if the prev→next displacement exceeds 3 tiles (respawn,
 * teleport, index mismatch), render at the next position with no lerp.
 */
import { MILLITILE, TILE_PX } from '../../../shared/constants';

export function lerp(a: number, b: number, alpha: number): number {
  return a + (b - a) * alpha;
}

/** Millitiles → pixels (tile (x, y)'s top-left corner is x*TILE_PX, y*TILE_PX). */
export function mtToPx(mt: number): number {
  return (mt * TILE_PX) / MILLITILE;
}

/** Prev→next jumps beyond this (per axis) snap instead of lerping. */
export const SNAP_THRESHOLD_MT = 3 * MILLITILE;

export interface PxPoint {
  x: number;
  y: number;
}

interface MtPos {
  readonly posX: number;
  readonly posY: number;
}

/**
 * Interpolated entity CENTER in pixels (includes the +TILE_PX/2 offset from
 * the millitile anchor to the tile center). `prev` undefined (entity just
 * appeared) or a > 3-tile jump on either axis ⇒ snap to `next`.
 */
export function interpEntityPx(
  prev: MtPos | undefined,
  next: MtPos,
  alpha: number,
): PxPoint {
  let mx = next.posX;
  let my = next.posY;
  if (
    prev !== undefined &&
    Math.abs(next.posX - prev.posX) <= SNAP_THRESHOLD_MT &&
    Math.abs(next.posY - prev.posY) <= SNAP_THRESHOLD_MT
  ) {
    mx = lerp(prev.posX, next.posX, alpha);
    my = lerp(prev.posY, next.posY, alpha);
  }
  return { x: mtToPx(mx) + TILE_PX / 2, y: mtToPx(my) + TILE_PX / 2 };
}
