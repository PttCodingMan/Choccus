/**
 * Tests for the 'open' map variant.
 *
 * Covers: determinism of the open map under lockstep replay, spawn-corner
 * clearance, the open map being strictly more open than classic, and a guard
 * that the classic layout is byte-identical to its historical hard-tile count
 * (and that the default kind equals an explicit 'classic').
 */
import { describe, expect, it } from 'vitest';

import { makeFeelParams } from '../../../client/src/config/FeelParams';
import { NO_INPUT } from '../../../client/src/sim/InputBuffer';
import {
  SPAWN_CORNERS,
  generateMap,
  idx,
  isHardCoord,
} from '../../../client/src/sim/Map';
import { createInitialState, tick } from '../../../client/src/sim/Sim';
import { MAP_COLS, MAP_ROWS } from '../../../shared/constants';
import { TileKind } from '../../../shared/types';

const SEED = 0x1234_5678;
const fp = makeFeelParams();

/** Count HARD tiles in a flat tile grid. */
function countHard(grid: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] === TileKind.HARD) n++;
  }
  return n;
}

describe('open map variant', () => {
  it('is deterministic under lockstep replay (200 ticks, no input)', () => {
    const a = createInitialState(SEED, fp, 4, { map: 'open' });
    const b = createInitialState(SEED, fp, 4, { map: 'open' });
    expect(a.stateHash).toBe(b.stateHash);

    const inputs = [NO_INPUT, NO_INPUT, NO_INPUT, NO_INPUT];
    let sa = a;
    let sb = b;
    for (let t = 0; t < 200; t++) {
      sa = tick(sa, inputs);
      sb = tick(sb, inputs);
      expect(sa.stateHash).toBe(sb.stateHash);
    }
  });

  it('keeps every spawn-corner L-zone clear', () => {
    const [grid] = generateMap(SEED, 'open');
    for (const [cx, cy] of SPAWN_CORNERS) {
      const dx = cx === 1 ? 1 : -1;
      const dy = cy === 1 ? 1 : -1;
      const lZone: ReadonlyArray<readonly [number, number]> = [
        [cx, cy],
        [cx + dx, cy],
        [cx, cy + dy],
      ];
      for (const [x, y] of lZone) {
        expect(grid[idx(x, y)]).toBe(TileKind.EMPTY);
      }
    }
  });

  it('has strictly fewer HARD tiles than classic for the same seed', () => {
    const [classicGrid] = generateMap(SEED, 'classic');
    const [openGrid] = generateMap(SEED, 'open');
    expect(countHard(openGrid)).toBeLessThan(countHard(classicGrid));
  });

  it('matches the known classic/open HARD-tile counts', () => {
    const [classicGrid] = generateMap(SEED, 'classic');
    const [openGrid] = generateMap(SEED, 'open');
    // 15×13: outer ring = 2*15 + 2*(13-2) = 52; interior even×even = 6*5 = 30.
    expect(countHard(classicGrid)).toBe(82);
    // Open = outer ring (52) + central HARD plus (5) = 57.
    expect(countHard(openGrid)).toBe(57);
  });

  it('default kind is byte-for-byte identical to explicit classic', () => {
    const [defaultGrid, defaultPrng] = generateMap(SEED);
    const [classicGrid, classicPrng] = generateMap(SEED, 'classic');
    expect(defaultPrng).toBe(classicPrng);
    expect(defaultGrid.length).toBe(classicGrid.length);
    for (let i = 0; i < defaultGrid.length; i++) {
      expect(defaultGrid[i]).toBe(classicGrid[i]);
    }
  });

  it('open map has no interior HARD tiles except the central plus', () => {
    const [grid] = generateMap(SEED, 'open');
    const cx = Math.floor((MAP_COLS - 1) / 2);
    const cy = Math.floor((MAP_ROWS - 1) / 2);
    const isCenterPlus = (x: number, y: number): boolean =>
      (x === cx && y === cy) ||
      (x === cx && Math.abs(y - cy) === 1) ||
      (y === cy && Math.abs(x - cx) === 1);
    for (let y = 1; y < MAP_ROWS - 1; y++) {
      for (let x = 1; x < MAP_COLS - 1; x++) {
        if (!isCenterPlus(x, y)) {
          expect(grid[idx(x, y)]).not.toBe(TileKind.HARD);
        }
        // classic would mark even×even interior HARD; assertion about isHardCoord.
        if (x % 2 === 0 && y % 2 === 0) {
          expect(isHardCoord(x, y)).toBe(true);
        }
      }
    }
  });

  it('open map has the 5 central plus tiles all HARD', () => {
    const [grid] = generateMap(SEED, 'open');
    const plus: ReadonlyArray<readonly [number, number]> = [
      [7, 6],
      [6, 6],
      [8, 6],
      [7, 5],
      [7, 7],
    ];
    for (const [x, y] of plus) {
      expect(grid[idx(x, y)]).toBe(TileKind.HARD);
    }
  });

  it('open map keeps all 4 spawn corners in one EMPTY-connected region', () => {
    const [grid] = generateMap(SEED, 'open');
    // Flood-fill over EMPTY tiles only (SOFT and HARD are walls).
    const [sx, sy] = SPAWN_CORNERS[0]!;
    const seen = new Set<number>();
    const stack: Array<readonly [number, number]> = [[sx, sy]];
    seen.add(idx(sx, sy));
    const dirs: ReadonlyArray<readonly [number, number]> = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    while (stack.length > 0) {
      const [x, y] = stack.pop()!;
      for (const [dx, dy] of dirs) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= MAP_COLS || ny < 0 || ny >= MAP_ROWS) continue;
        const ni = idx(nx, ny);
        if (seen.has(ni)) continue;
        if (grid[ni] !== TileKind.EMPTY) continue;
        seen.add(ni);
        stack.push([nx, ny]);
      }
    }
    for (const [cx, cy] of SPAWN_CORNERS) {
      expect(seen.has(idx(cx, cy))).toBe(true);
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

  it('open map SOFT density is center-weighted over seeds 0..49', () => {
    const cx = Math.floor((MAP_COLS - 1) / 2);
    const cy = Math.floor((MAP_ROWS - 1) / 2);
    let nearSoft = 0;
    let nearTotal = 0;
    let farSoft = 0;
    let farTotal = 0;
    for (let seed = 0; seed < 50; seed++) {
      const [grid] = generateMap(seed, 'open');
      for (let y = 0; y < MAP_ROWS; y++) {
        for (let x = 0; x < MAP_COLS; x++) {
          const k = grid[idx(x, y)];
          // Eligible = not HARD and not EMPTY-by-spawn-clear; we approximate
          // "eligible" as tiles that are SOFT or EMPTY and not on the hard set.
          if (k === TileKind.HARD) continue;
          const d = Math.max(Math.abs(x - cx), Math.abs(y - cy));
          if (d <= 2) {
            nearTotal++;
            if (k === TileKind.SOFT) nearSoft++;
          } else if (d >= 5) {
            farTotal++;
            if (k === TileKind.SOFT) farSoft++;
          }
        }
      }
    }
    expect(nearTotal).toBeGreaterThan(0);
    expect(farTotal).toBeGreaterThan(0);
    const nearFrac = nearSoft / nearTotal;
    const farFrac = farSoft / farTotal;
    expect(nearFrac).toBeGreaterThan(farFrac);
  });
});
