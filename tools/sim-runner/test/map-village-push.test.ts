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

import { MAP_COLS, MAP_ROWS, MILLITILE, PUSH_CHARGE_TICKS } from '../../../shared/constants';
import { Direction, ItemKind, TileKind } from '../../../shared/types';
import { SPAWN_CORNERS, generateMap, idx } from '../../../client/src/sim/Map';
import {
  type SimParams,
  clonePlayer,
  createPlayer,
  stepPlayerMovement,
  tileOf,
} from '../../../client/src/sim/Player';
import { processDetonations } from '../../../client/src/sim/Explosion';
import { type SimState, createInitialState, tick } from '../../../client/src/sim/Sim';
import { makeFeelParams } from '../../../client/src/config/FeelParams';
import { NO_INPUT } from '../../../client/src/sim/InputBuffer';
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

  it('shoves a PUSH brick only after charging PUSH_CHARGE_TICKS; player stays', () => {
    const grid = emptyGrid();
    const px = 3;
    const py = 3;
    grid[idx(px + 1, py)] = TileKind.PUSH; // brick directly to the right
    // (px+2, py) is EMPTY → pushable
    const player = createPlayer(0, px, py);
    const input: InputFrame = { dir: Direction.RIGHT, action: 0 };

    // The crate is heavy: it stays put while the charge builds…
    for (let t = 0; t < PUSH_CHARGE_TICKS - 1; t++) {
      stepPlayerMovement(grid, [], player, input, PARAMS);
      expect(grid[idx(px + 1, py)]).toBe(TileKind.PUSH); // not yet
    }
    // …and slides on the tick the charge completes.
    stepPlayerMovement(grid, [], player, input, PARAMS);
    expect(grid[idx(px + 1, py)]).toBe(TileKind.EMPTY); // brick left its tile
    expect(grid[idx(px + 2, py)]).toBe(TileKind.PUSH); // …and slid one tile over
    expect(player.posX).toBe(px * MILLITILE); // player did NOT advance
    expect(tileOf(player.posX)).toBe(px);
  });

  it('releasing the direction resets the charge (a heavy crate needs sustained force)', () => {
    const grid = emptyGrid();
    const px = 3;
    const py = 3;
    grid[idx(px + 1, py)] = TileKind.PUSH;
    const player = createPlayer(0, px, py);
    const push: InputFrame = { dir: Direction.RIGHT, action: 0 };
    const release: InputFrame = { dir: 0, action: 0 };

    // Lean almost long enough, then let go: the charge must reset, so resuming
    // the push does NOT slide the crate before a fresh full charge.
    for (let t = 0; t < PUSH_CHARGE_TICKS - 1; t++) {
      stepPlayerMovement(grid, [], player, push, PARAMS);
    }
    stepPlayerMovement(grid, [], player, release, PARAMS);
    expect(player.pushChargeTicks).toBe(0);
    stepPlayerMovement(grid, [], player, push, PARAMS); // 1 tick of fresh charge
    expect(grid[idx(px + 1, py)]).toBe(TileKind.PUSH); // still unmoved
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

  it('shoving a crate onto a floor item deletes the item (the crate takes its place)', () => {
    const base = createInitialState(0, makeFeelParams(), 2, { pvp: true, teams: [0, 1] });
    const map = new Uint8Array(base.map);
    const players = base.players.map(clonePlayer);
    const px = 1;
    const py = 1;
    // Clean lane: player at (1,1), crate at (2,1), item lying on (3,1).
    map[idx(px, py)] = TileKind.EMPTY;
    map[idx(px + 1, py)] = TileKind.PUSH;
    map[idx(px + 2, py)] = TileKind.EMPTY;
    players[0]!.posX = px * MILLITILE;
    players[0]!.posY = py * MILLITILE;
    // Park the second player out of the way.
    players[1]!.posX = 13 * MILLITILE;
    players[1]!.posY = 11 * MILLITILE;
    const st0: SimState = {
      ...base,
      map,
      players,
      items: [{ tileX: px + 2, tileY: py, kind: ItemKind.FIRE }],
    };
    expect(st0.items.some((it) => it.tileX === px + 2)).toBe(true);

    // Lean into the crate until it charges full and slides onto the item tile.
    const right: InputFrame = { dir: Direction.RIGHT, action: 0 };
    let st = st0;
    for (let t = 0; t < PUSH_CHARGE_TICKS; t++) st = tick(st, [right, NO_INPUT]);

    expect(st.map[idx(px + 2, py)]).toBe(TileKind.PUSH); // crate slid onto item tile
    expect(st.items.length).toBe(0); // …and the item is gone
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
