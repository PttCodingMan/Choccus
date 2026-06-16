/**
 * Tests for the map generator: classic default + the authored pirate layout.
 *
 * Covers: the default kind being byte-for-byte identical to explicit 'classic'
 * (the determinism guard for the rolled stream), and the 'pirate' kind being a
 * fully authored layout that draws zero PRNG values with its spawn corners
 * cleared.
 */
import { describe, expect, it } from 'vitest';

import { SPAWN_CORNERS, generateMap, idx } from '../../../client/src/sim/Map';
import { TileKind } from '../../../shared/types';

const SEED = 0x1234_5678;

describe('map: classic default + pirate', () => {
  it('default kind is byte-for-byte identical to explicit classic', () => {
    const [defaultGrid, defaultPrng] = generateMap(SEED);
    const [classicGrid, classicPrng] = generateMap(SEED, 'classic');
    expect(defaultPrng).toBe(classicPrng);
    expect(defaultGrid.length).toBe(classicGrid.length);
    for (let i = 0; i < defaultGrid.length; i++) {
      expect(defaultGrid[i]).toBe(classicGrid[i]);
    }
  });

  it('pirate map is fully authored: zero PRNG draws, spawn corners cleared', () => {
    const [grid, prng] = generateMap(SEED, 'pirate');
    // Authored kind consumes no PRNG: state returned unchanged.
    expect(prng).toBe(SEED);
    // Same seed → byte-identical (no randomness at all).
    const [grid2, prng2] = generateMap(SEED + 1, 'pirate');
    expect(prng2).toBe(SEED + 1);
    for (let i = 0; i < grid.length; i++) {
      expect(grid2[i]).toBe(grid[i]);
    }
    // Spawn corners (and their L-zones) forced EMPTY despite the SOFT template.
    for (const [cx, cy] of SPAWN_CORNERS) {
      const dx = cx === 1 ? 1 : -1;
      const dy = cy === 1 ? 1 : -1;
      for (const [x, y] of [
        [cx, cy],
        [cx + dx, cy],
        [cx, cy + dy],
      ] as const) {
        expect(grid[idx(x, y)]).toBe(TileKind.EMPTY);
      }
    }
    // Central horizontal hard bar: (6,6),(7,6),(8,6).
    for (const [x, y] of [
      [6, 6],
      [7, 6],
      [8, 6],
    ] as const) {
      expect(grid[idx(x, y)]).toBe(TileKind.HARD);
    }
    // Corner-interior pillars from the template, e.g. (2,2) and (12,10).
    expect(grid[idx(2, 2)]).toBe(TileKind.HARD);
    expect(grid[idx(12, 10)]).toBe(TileKind.HARD);
  });
});
