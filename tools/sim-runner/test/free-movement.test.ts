/**
 * Free AABB movement (see client/src/sim/Player.ts). The model replaced the old
 * corridor-grid "always snap to a centerline" movement: in open space the body
 * glides off-grid on both axes with NO correction; collision alone fences it to
 * a 1-wide corridor; the only assist (corner-slide) fires solely when a move is
 * blocked by a wall. These pin the four properties that matter.
 */
import { describe, expect, it } from 'vitest';

import {
  MAP_COLS,
  MAP_ROWS,
  MILLITILE,
  PUSH_CHARGE_TICKS,
  SUDDEN_DEATH_START_TICK,
} from '../../../shared/constants';
import { Direction, TileKind } from '../../../shared/types';
import { idx } from '../../../client/src/sim/Map';
import {
  type SimParams,
  bodyOverlapsTile,
  createPlayer,
  playerSpeedMtPerTick,
  stepEntity,
  stepPlayerMovement,
  tileOf,
} from '../../../client/src/sim/Player';
import { SPIRAL_ORDER, stepSuddenDeath } from '../../../client/src/sim/SuddenDeath';
import type { BombState } from '../../../client/src/sim/Bomb';

const V = playerSpeedMtPerTick(5000, 0); // 5 tiles/s per-tick step
const emptyGrid = (): Uint8Array => new Uint8Array(MAP_COLS * MAP_ROWS); // all EMPTY
const step = (
  grid: Uint8Array,
  bombs: BombState[],
  x: number,
  y: number,
  dir: number,
): [number, number, boolean] => stepEntity(grid, bombs, x, y, dir, V, 250);

describe('free movement (open space)', () => {
  it('moving perpendicular while off-grid does NOT snap to a centerline', () => {
    const grid = emptyGrid();
    let x = 5 * MILLITILE;
    let y = 5 * MILLITILE;
    for (let i = 0; i < 3; i++) [x, y] = step(grid, [], x, y, Direction.RIGHT);
    expect(x % MILLITILE).not.toBe(0); // genuinely between two columns

    const xBefore = x;
    [x, y] = step(grid, [], x, y, Direction.UP);
    expect(x).toBe(xBefore); // X preserved — free, no pull to the grid
    expect(y).toBe(5 * MILLITILE - V); // moved straight up
  });
});

describe('collision (corridors / walls)', () => {
  it('stops flush against a wall, never clipping into it', () => {
    const grid = emptyGrid();
    grid[idx(6, 5)] = TileKind.HARD; // wall one tile to the right
    let x = 5 * MILLITILE;
    let y = 5 * MILLITILE;
    for (let i = 0; i < 20; i++) [x, y] = step(grid, [], x, y, Direction.RIGHT);
    expect(x).toBe(5 * MILLITILE); // body flush at tile 5's centre, tile 6 untouched
  });
});

describe('corner-slide (only when blocked)', () => {
  it('aligns to the nominal lane to round a corner, then advances', () => {
    const grid = emptyGrid();
    grid[idx(6, 6)] = TileKind.HARD; // wall ahead in the leaned-into (lower) row
    let x = 5 * MILLITILE;
    let y = 5 * MILLITILE + 150; // straddles rows 5 & 6; nominal row = 5
    for (let i = 0; i < 6; i++) [x, y] = step(grid, [], x, y, Direction.RIGHT);
    expect(y).toBe(5 * MILLITILE); // slid up to the open nominal lane (150 mt ≤ tol 250)
    expect(x).toBeGreaterThan(5 * MILLITILE); // and kept going right
  });

  it('rounds the corner at CONSTANT speed — no per-tick burst, never exceeds move speed', () => {
    // Off-centre by 400 mt — far more than one tick of speed (~83 mt). The old
    // model snapped fully to the lane (free) AND advanced forward the SAME tick: a
    // >1-tile burst that read as acceleration and overshot the intended bomb tile.
    // The constant-speed model spends each tick's budget closing the offset first,
    // leftover forward — so NO tick ever moves more than `V`, yet the corner still
    // completes.
    const grid = emptyGrid();
    grid[idx(6, 6)] = TileKind.HARD; // wall ahead in the leaned-into (lower) row
    const x0 = 5 * MILLITILE;
    let x = x0;
    let y = 5 * MILLITILE + 400; // straddles rows 5 & 6 (400 mt ≤ tol 500), nominal row 5

    // Tick 1: offset (400) > V, so the body glides toward the lane with NO forward
    // progress yet — the constant-speed contract, not the old free-snap burst.
    [x, y] = stepEntity(grid, [], x, y, Direction.RIGHT, V, 500);
    expect(x).toBe(x0); // no forward burst while still aligning
    expect(y).toBe(5 * MILLITILE + 400 - V); // exactly one step toward the lane

    // Across the rest of the corner, no single tick may move more than V total,
    // and the body must eventually align to the open lane and progress forward.
    let aligned = false;
    for (let i = 0; i < 20; i++) {
      const [nx, ny] = stepEntity(grid, [], x, y, Direction.RIGHT, V, 500);
      expect(Math.abs(nx - x) + Math.abs(ny - y)).toBeLessThanOrEqual(V); // constant speed
      x = nx;
      y = ny;
      if (y === 5 * MILLITILE) aligned = true;
    }
    expect(aligned).toBe(true); // snapped to the open lane within budget
    expect(x).toBeGreaterThan(x0); // …and rounded the corner forward
  });

  it('no-clip: a body driven around a wall corner never ends a tick inside a solid tile', () => {
    // The body leans into row 6, with the wall directly ahead in that leaned-into
    // row (col 6, row 6). The open lane is the nominal row 5. Driving RIGHT for
    // many ticks rounds the corner up into row 5 via the corner-cut; the footprint
    // must NEVER overlap the HARD tile (no clip / no tunnelling through the corner).
    const grid = emptyGrid();
    const wx = 6;
    const wy = 6;
    grid[idx(wx, wy)] = TileKind.HARD; // wall ahead in the leaned-into (lower) row
    // A second wall further along the upper lane forces the body to stop flush at
    // a corner too — exercising the clamp during the corner-cut's forward step.
    grid[idx(9, 5)] = TileKind.HARD;
    let x = 5 * MILLITILE;
    let y = 5 * MILLITILE + 480; // straddles rows 5 & 6 (480 mt ≤ tol 500), nominal row 5
    const overlapsHard = (px: number, py: number): boolean => {
      // Walk the up-to-four cells the one-tile body straddles and reject any HARD.
      const xs = px % MILLITILE === 0 ? [tileOf(px)] : [tileOf(px), tileOf(px) + (px > tileOf(px) * MILLITILE ? 1 : -1)];
      const ys = py % MILLITILE === 0 ? [tileOf(py)] : [tileOf(py), tileOf(py) + (py > tileOf(py) * MILLITILE ? 1 : -1)];
      for (const cx of xs) for (const cy of ys) if (grid[idx(cx, cy)] === TileKind.HARD) return true;
      return false;
    };
    for (let i = 0; i < 60; i++) {
      [x, y] = stepEntity(grid, [], x, y, Direction.RIGHT, V, 500);
      expect(bodyOverlapsTile(x, y, wx, wy)).toBe(false); // never inside the corner wall
      expect(overlapsHard(x, y)).toBe(false); // never overlapping ANY solid tile
    }
  });

  it('does NOT align to the nominal lane when it is beyond the tolerance', () => {
    const grid = emptyGrid();
    grid[idx(6, 6)] = TileKind.HARD; // wall ahead in the leaned-into (lower) row
    let x = 5 * MILLITILE;
    let y = 5 * MILLITILE + 150; // near lane (row 5) centre is 150 mt away
    const tightTol = 100; // < 150 → even the near lane is gated out
    for (let i = 0; i < 6; i++) {
      [x, y] = stepEntity(grid, [], x, y, Direction.RIGHT, V, tightTol);
    }
    expect(y).toBe(5 * MILLITILE + 150); // no corner-assist: stayed off-grid
    expect(x).toBe(5 * MILLITILE); // and stayed blocked against the near-lane wall
  });
});

describe('own bomb', () => {
  it('a player can walk off the bomb on its own tile', () => {
    const grid = emptyGrid();
    const bombs: BombState[] = [{ ownerSlot: 0, tileX: 5, tileY: 5, fuseTicks: 180, fire: 2 }];
    const [nx, , moved] = step(grid, bombs, 5 * MILLITILE, 5 * MILLITILE, Direction.RIGHT);
    expect(moved).toBe(true);
    expect(nx).toBeGreaterThan(5 * MILLITILE); // advanced off its own bomb
  });

  it('walks off its own bomb even when off-grid on the movement axis (leaning back)', () => {
    // Player off-grid leaning BACK toward its bomb tile (nearest tile = the bomb
    // tile 5, leading edge already inside tile 5). Moving forward must still be
    // free — a bomb is not a wall — even though the leading-edge tile is its tile.
    const grid = emptyGrid();
    const bombs: BombState[] = [{ ownerSlot: 0, tileX: 5, tileY: 5, fuseTicks: 180, fire: 2 }];
    const x0 = 5 * MILLITILE - 300; // tileOf = 5 (the bomb tile), leading edge in tile 5
    const [nx, , moved] = step(grid, bombs, x0, 5 * MILLITILE, Direction.RIGHT);
    expect(moved).toBe(true);
    expect(nx).toBeGreaterThan(x0); // advanced — own bomb does not block walk-off
  });
});

describe('corner-slide tightness gate (far lane needs a wide tolerance)', () => {
  // Body sits exactly halfway between rows 5 & 6 (off-grid, leaning into row 6).
  // The NEAR row (5) is blocked ahead, so the only assist target is the FAR row
  // (6), whose centre is ½ tile (500 mt) away. The tolerance threshold decides
  // whether that far lane qualifies.
  const setup = (): [Uint8Array, number, number] => {
    const grid = emptyGrid();
    grid[idx(6, 5)] = TileKind.HARD; // opening ahead in the NEAR row (5) is blocked
    return [grid, 5 * MILLITILE, 5 * MILLITILE + 500]; // far lane (row 6) centre is 500 mt away
  };

  it('does NOT snap when the far lane is beyond the tolerance', () => {
    const [grid, x0, y0] = setup();
    let x = x0;
    let y = y0;
    const tightTol = 250; // < 500 → far lane gated out
    for (let i = 0; i < 30; i++) {
      [x, y] = stepEntity(grid, [], x, y, Direction.RIGHT, V, tightTol);
    }
    expect(y).toBe(5 * MILLITILE + 500); // stayed off-grid; no corner-assist fired
    expect(x).toBe(5 * MILLITILE); // and stayed blocked against the wall
  });

  it('snaps to the far lane when the tolerance is wide enough to reach it', () => {
    const [grid, x0, y0] = setup();
    let x = x0;
    let y = y0;
    const wideTol = 500; // == distance to the far lane centre → qualifies
    for (let i = 0; i < 30; i++) {
      [x, y] = stepEntity(grid, [], x, y, Direction.RIGHT, V, wideTol);
    }
    expect(y).toBe(6 * MILLITILE); // slid DOWN to the open far lane
    expect(x).toBeGreaterThan(5 * MILLITILE); // and rounded the corner going right
  });
});

describe('sudden-death clip-through (#1b)', () => {
  it('a body straddling a tile that turns HARD is clamped flush next tick (no clip)', () => {
    // Body straddles columns 5 & 6, leaning right into column 6, while gliding
    // right through open space. Column 6 then hardens (sudden-death). The body
    // must NOT glide deeper into the now-solid tile 6 — it clamps flush at 5.
    const grid = emptyGrid();
    let x = 5 * MILLITILE + 300; // straddles cols 5 & 6 (off-grid on movement axis)
    let y = 5 * MILLITILE;
    [x, y] = step(grid, [], x, y, Direction.RIGHT); // free glide right (no wall yet)
    expect(x).toBeGreaterThan(5 * MILLITILE + 300);

    grid[idx(6, 5)] = TileKind.HARD; // tile the body already straddles becomes solid
    const xBefore = x;
    [x, y] = step(grid, [], x, y, Direction.RIGHT); // try to push deeper into col 6
    expect(x).toBe(5 * MILLITILE); // clamped flush at col 5's centre — did NOT clip through
    expect(x).toBeLessThanOrEqual(xBefore);
    // Confirm it stays clamped and never passes through on subsequent ticks.
    for (let i = 0; i < 20; i++) [x, y] = step(grid, [], x, y, Direction.RIGHT);
    expect(x).toBe(5 * MILLITILE);
  });
});

describe('push bricks off-grid (#2)', () => {
  const PARAMS: SimParams = {
    moveSpeedMt: 5000,
    cornerAssistMt: 250,
    inputBufferTicks: 7,
    pvp: true,
  };

  it('pushes a brick while off-grid on the perpendicular axis but lane-aligned', () => {
    const grid = emptyGrid();
    grid[idx(8, 5)] = TileKind.PUSH; // brick directly ahead (to the right)
    grid[idx(8, 6)] = TileKind.HARD; // wall the diversion row → no corner-slide around
    // Brick destination (9,5) is open. Player is flush against the brick on the
    // movement axis (col 7 centre) but OFF-GRID on the perpendicular axis,
    // leaning into row 6 — nearest tile is still row 5 (the brick's lane). The
    // old canPush required dead-centre on both axes and would never fire here.
    const p = createPlayer(0, 7, 5);
    p.posY = 5 * MILLITILE + 200; // off-grid perpendicular, lane = row 5
    const input = { dir: Direction.RIGHT, action: 0 };
    for (let i = 0; i < PUSH_CHARGE_TICKS; i++) {
      stepPlayerMovement(grid, [], p, input, PARAMS);
    }
    expect(grid[idx(8, 5)]).toBe(TileKind.EMPTY); // brick vacated its tile
    expect(grid[idx(9, 5)]).toBe(TileKind.PUSH); // …and slid one tile over
    expect(p.posX).toBe(7 * MILLITILE); // player held position (flush, did not advance)
  });
});

describe('sudden-death crush footprint (#1a)', () => {
  it('crushes a body that straddles the hardened tile even when its centre rounds elsewhere', () => {
    // SPIRAL_ORDER[0] is the first tile to harden, at SUDDEN_DEATH_START_TICK.
    const [hx, hy] = SPIRAL_ORDER[0]!;
    const grid = emptyGrid();
    const p = createPlayer(0, hx, hy);
    // Offset the body on X so its NEAREST column is the neighbour (hx+1) yet its
    // footprint still straddles the hardening tile hx (overlap area > 0); Y stays
    // centred on hy. The old centre-only check (tileOf === x && tileOf === y)
    // rounded to (hx+1, hy) and would NOT crush this.
    p.posX = (hx + 1) * MILLITILE - (MILLITILE * 3) / 10; // nearest = hx+1, overlaps hx
    expect(bodyOverlapsTile(p.posX, p.posY, hx, hy)).toBe(true);
    stepSuddenDeath(grid, [p], SUDDEN_DEATH_START_TICK);
    expect(p.alive).toBe(false); // crushed by footprint overlap
  });

  it('does NOT crush a body that is fully clear of the hardened tile', () => {
    const [hx, hy] = SPIRAL_ORDER[0]!;
    const grid = emptyGrid();
    const p = createPlayer(0, hx + 2, hy + 2); // two tiles away, no overlap
    expect(bodyOverlapsTile(p.posX, p.posY, hx, hy)).toBe(false);
    stepSuddenDeath(grid, [p], SUDDEN_DEATH_START_TICK);
    expect(p.alive).toBe(true);
  });
});
