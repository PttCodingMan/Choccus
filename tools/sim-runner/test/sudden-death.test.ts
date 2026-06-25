/**
 * Sudden-death encroachment: the spiral covers the whole grid exactly once
 * (starting from the true outermost ring — the authored maps fill the grid, no
 * permanent wall border), the board is fully closed by the cap (so a match can't
 * farm-stall to timeout), and a player caught on a hardening tile is crushed
 * (eliminated, not trapped).
 */
import { describe, expect, it } from 'vitest';

import {
  MAP_COLS,
  MAP_ROWS,
  MATCH_MAX_TICKS,
  SUDDEN_DEATH_START_TICK,
} from '../../../shared/constants';
import { TileKind } from '../../../shared/types';
import { idx } from '../../../client/src/sim/Map';
import { createPlayer } from '../../../client/src/sim/Player';
import {
  SPIRAL_ORDER,
  hardenedCount,
  stepSuddenDeath,
} from '../../../client/src/sim/SuddenDeath';

describe('sudden death', () => {
  it('spiral covers every grid tile exactly once, starting at the outer corner', () => {
    const seen = new Set<number>();
    for (const [x, y] of SPIRAL_ORDER) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(MAP_COLS - 1);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(MAP_ROWS - 1);
      seen.add(idx(x, y));
    }
    expect(SPIRAL_ORDER.length).toBe(MAP_COLS * MAP_ROWS);
    expect(seen.size).toBe(SPIRAL_ORDER.length);
    // First tile hardened is the true outermost corner, not one ring in.
    expect(SPIRAL_ORDER[0]).toEqual([0, 0]);
  });

  it('hardens nothing before the start, then the whole board by the cap', () => {
    expect(hardenedCount(SUDDEN_DEATH_START_TICK - 1)).toBe(0);
    expect(hardenedCount(SUDDEN_DEATH_START_TICK)).toBe(1);
    // Full closure must land at or before the cap — that is what kills the stall.
    expect(hardenedCount(MATCH_MAX_TICKS)).toBe(SPIRAL_ORDER.length);
  });

  it('crushes a player standing on a freshly-hardened tile', () => {
    const grid = new Uint8Array(MAP_COLS * MAP_ROWS); // all EMPTY
    const [x, y] = SPIRAL_ORDER[0]!;
    const [cx, cy] = SPIRAL_ORDER[SPIRAL_ORDER.length - 1]!; // center, falls last
    const victim = createPlayer(0, x, y);
    const bystander = createPlayer(1, cx, cy);
    const players = [victim, bystander];

    stepSuddenDeath(grid, players, SUDDEN_DEATH_START_TICK); // hardens SPIRAL_ORDER[0]
    expect(grid[idx(x, y)]).toBe(TileKind.HARD);
    expect(victim.alive).toBe(false); // crushed outright…
    expect(victim.trapped).toBe(false); // …not shelled
    expect(bystander.alive).toBe(true); // the center tile hasn't fallen yet
  });
});
