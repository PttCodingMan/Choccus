/**
 * Tests for the authored 'village' map and the pushable-brick mechanic.
 *
 * Covers: village is fully authored (zero PRNG, seed-independent) with its four
 * PUSH bricks in the expected lane positions and spawn corners cleared; a player
 * dead-centered against a PUSH brick with an open tile beyond shoves it one tile
 * without advancing; the push is refused when the tile beyond is blocked; and a
 * blast destroys a PUSH brick exactly like SOFT (arm stops, tile cleared).
 */
import { describe, expect, it } from 'vitest';

import { MAP_COLS, MAP_ROWS, MILLITILE } from '../../../shared/constants';
import { Direction, TileKind } from '../../../shared/types';
import { SPAWN_CORNERS, generateMap, idx } from '../../../client/src/sim/Map';
import {
  type SimParams,
  createPlayer,
  stepPlayerMovement,
  tileOf,
} from '../../../client/src/sim/Player';
import { processDetonations } from '../../../client/src/sim/Explosion';
import type { BombState } from '../../../client/src/sim/Bomb';
import type { InputFrame } from '../../../client/src/sim/InputBuffer';

const SEED = 0x1234_5678;

const PARAMS: SimParams = {
  moveSpeedMt: 5000, // 5 tiles/s
  cornerAssistMt: 250,
  inputBufferTicks: 7,
  pvp: false,
};

/** The PUSH bricks (wooden X-crates) lining the village road lanes — columns 6
 * & 8 hug the vertical lane, cols 3 & 11 flank the horizontal lane. Each sits
 * one tile off an empty lane so it can slide into it when shoved. */
const PUSH_TILES: ReadonlyArray<readonly [number, number]> = [
  [6, 3],
  [8, 3],
  [3, 5],
  [6, 5],
  [8, 5],
  [11, 5],
  [3, 7],
  [6, 7],
  [8, 7],
  [11, 7],
  [6, 9],
  [8, 9],
];

describe('map: village (authored, push bricks)', () => {
  it('is fully authored: zero PRNG, seed-independent, spawn corners cleared', () => {
    const [grid, prng] = generateMap(SEED, 'village');
    expect(prng).toBe(SEED); // no PRNG consumed
    const [grid2, prng2] = generateMap(SEED + 999, 'village');
    expect(prng2).toBe(SEED + 999);
    for (let i = 0; i < grid.length; i++) expect(grid2[i]).toBe(grid[i]);

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
  });

  it('has its PUSH bricks (X-crates) lining the lanes, each pushable into an empty lane', () => {
    const [grid] = generateMap(SEED, 'village');
    let pushCount = 0;
    for (let i = 0; i < grid.length; i++) if (grid[i] === TileKind.PUSH) pushCount += 1;
    expect(pushCount).toBe(PUSH_TILES.length);
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const;
    for (const [x, y] of PUSH_TILES) {
      expect(grid[idx(x, y)]).toBe(TileKind.PUSH);
      // Pushable: some direction has an EMPTY tile ahead and a non-HARD tile behind.
      const pushable = dirs.some(([dx, dy]) => {
        const dest = grid[idx(x + dx, y + dy)];
        const from = grid[idx(x - dx, y - dy)];
        return dest === TileKind.EMPTY && from !== TileKind.HARD;
      });
      expect(pushable).toBe(true);
    }
  });
});

describe('push mechanic', () => {
  function emptyGrid(): Uint8Array {
    return new Uint8Array(MAP_COLS * MAP_ROWS); // all EMPTY
  }

  it('shoves a PUSH brick one tile when centered with an open tile beyond; player stays', () => {
    const grid = emptyGrid();
    const px = 3;
    const py = 3;
    grid[idx(px + 1, py)] = TileKind.PUSH; // brick directly to the right
    // (px+2, py) is EMPTY → pushable
    const player = createPlayer(0, px, py);
    const input: InputFrame = { dir: Direction.RIGHT, action: 0 };

    stepPlayerMovement(grid, [], player, input, PARAMS);

    expect(grid[idx(px + 1, py)]).toBe(TileKind.EMPTY); // brick left its tile
    expect(grid[idx(px + 2, py)]).toBe(TileKind.PUSH); // …and slid one tile over
    expect(player.posX).toBe(px * MILLITILE); // player did NOT advance
    expect(tileOf(player.posX)).toBe(px);
  });

  it('refuses the push when the tile beyond the brick is blocked', () => {
    const grid = emptyGrid();
    const px = 3;
    const py = 3;
    grid[idx(px + 1, py)] = TileKind.PUSH;
    grid[idx(px + 2, py)] = TileKind.HARD; // beyond is a wall → no room
    const player = createPlayer(0, px, py);
    const input: InputFrame = { dir: Direction.RIGHT, action: 0 };

    stepPlayerMovement(grid, [], player, input, PARAMS);

    expect(grid[idx(px + 1, py)]).toBe(TileKind.PUSH); // brick unmoved
    expect(grid[idx(px + 2, py)]).toBe(TileKind.HARD);
    expect(player.posX).toBe(px * MILLITILE); // player blocked, stays put
  });

  it('a blast destroys a PUSH brick exactly like SOFT (arm stops, tile cleared)', () => {
    const grid = emptyGrid();
    const bx = 5;
    const by = 5;
    grid[idx(bx + 1, by)] = TileKind.PUSH; // brick on the right arm
    const bomb: BombState = { ownerSlot: 0, tileX: bx, tileY: by, fuseTicks: 0, fire: 3 };

    const res = processDetonations(grid, [bomb], 0);

    expect(grid[idx(bx + 1, by)]).toBe(TileKind.EMPTY); // PUSH brick destroyed
    expect(res.bombs.length).toBe(0); // bomb detonated
  });
});
