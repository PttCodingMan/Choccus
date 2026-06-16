/**
 * Tile grid: `Uint8Array(MAP_COLS * MAP_ROWS)` of `TileKind`.
 *
 * Two map kinds share the same grid size and spawn corners:
 *
 *  - 'classic' (default): HARD = outer ring + every even-(x,y) interior tile;
 *    remaining eligible tiles roll SOFT at `SOFT_BRICK_RATE` (72%).
 *  - 'pirate': a fully authored template (see `PIRATE_TEMPLATE`). Its only HARD
 *    interior features are sparse anchors — the four corner-interior pillars
 *    plus a central horizontal hard bar — every other interior tile is SOFT.
 *    It draws ZERO PRNG values (the layout is fixed, not rolled) and relies on
 *    the spawn-clear override below to open the four spawn corners.
 *
 * In all kinds an L-shape of `SPAWN_CLEAR_TILES` (3) is kept clear at each
 * spawn corner.
 *
 * PRNG call order (determinism contract): the rolled kind ('classic') draws one
 * `prngFloat` per eligible tile, iterating y = 0..rows-1 outer, x = 0..cols-1
 * inner; hard and spawn-clear tiles are forced and consume no PRNG. The 'pirate'
 * kind is fully authored and draws ZERO PRNG values, returning the incoming PRNG
 * state UNCHANGED (deterministic and intentional).
 */
import {
  MAP_COLS,
  MAP_ROWS,
  SOFT_BRICK_RATE,
} from '../../../shared/constants';
import { TileKind } from '../../../shared/types';
import { prngFloat } from './Prng';

export type TileGrid = Uint8Array;

/** Map layout variant. Selected per match via opts, never randomly. */
export type MapKind = 'classic' | 'pirate';

/**
 * The authored 'pirate' layout: 13 rows of 15 chars each, row index = y,
 * char index = x. `#` = HARD, `S` = SOFT, `.` = EMPTY. The four spawn corners
 * are forced EMPTY by the spawn-clear override at generation time regardless of
 * what the template says there. Interior HARD anchors: the four corner pillars
 * and a central horizontal hard bar; everything else is SOFT.
 */
const PIRATE_TEMPLATE: readonly string[] = [
  '###############',
  '#S..SSSSSSS..S#',
  '#S#.SSSSSSS.#S#',
  '#SSSSSSSSSSSSS#',
  '#SSSSSSSSSSSSS#',
  '#SSSSSSSSSSSSS#',
  '#SSSSS###SSSSS#',
  '#SSSSSSSSSSSSS#',
  '#SSSSSSSSSSSSS#',
  '#SSSSSSSSSSSSS#',
  '#S#.SSSSSSS.#S#',
  '#S..SSSSSSS..S#',
  '###############',
];

// Validate the authored template at module load so a typo fails loudly.
if (PIRATE_TEMPLATE.length !== MAP_ROWS) {
  throw new Error(
    `PIRATE_TEMPLATE must have ${MAP_ROWS} rows, got ${PIRATE_TEMPLATE.length}`,
  );
}
for (let y = 0; y < PIRATE_TEMPLATE.length; y++) {
  const row = PIRATE_TEMPLATE[y]!;
  if (row.length !== MAP_COLS) {
    throw new Error(
      `PIRATE_TEMPLATE row ${y} must be ${MAP_COLS} chars, got ${row.length}`,
    );
  }
}

/** Map a single template char to its TileKind. */
function pirateTile(ch: string): TileKind {
  if (ch === '#') return TileKind.HARD;
  if (ch === 'S') return TileKind.SOFT;
  return TileKind.EMPTY;
}

/** Flat index for tile (x, y). Caller guarantees bounds. */
export function idx(x: number, y: number): number {
  return y * MAP_COLS + x;
}

export function inBounds(x: number, y: number): boolean {
  return x >= 0 && x < MAP_COLS && y >= 0 && y < MAP_ROWS;
}

/** The four spawn corners (inside the hard outer ring), slot order 0..3. */
export const SPAWN_CORNERS: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [MAP_COLS - 2, 1],
  [1, MAP_ROWS - 2],
  [MAP_COLS - 2, MAP_ROWS - 2],
];

/** True on the hard outer ring (structural boundary, both map kinds). */
function isOuterRing(x: number, y: number): boolean {
  return x === 0 || y === 0 || x === MAP_COLS - 1 || y === MAP_ROWS - 1;
}

/**
 * True for the classic hard set: outer ring + the even-(x,y) interior lattice.
 * Exported for renderers/tools that assume the default 'classic' layout.
 */
export function isHardCoord(x: number, y: number): boolean {
  return isOuterRing(x, y) || (x % 2 === 0 && y % 2 === 0);
}

/**
 * Per-kind hard predicate: the rolled 'classic' kind keeps the even-(x,y)
 * lattice (outer ring is included by `isHardCoord`).
 */
function hardForKind(x: number, y: number): boolean {
  return isHardCoord(x, y);
}

/**
 * The L-shaped clear zone at each spawn corner: the corner tile plus its
 * horizontal and vertical neighbors toward the map interior (3 tiles).
 */
function isSpawnClear(x: number, y: number): boolean {
  for (const [cx, cy] of SPAWN_CORNERS) {
    const dx = cx === 1 ? 1 : -1;
    const dy = cy === 1 ? 1 : -1;
    if (
      (x === cx && y === cy) ||
      (x === cx + dx && y === cy) ||
      (x === cx && y === cy + dy)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Generate the map for the given `kind`. Returns the grid and the advanced
 * PRNG state. With `kind === 'classic'` (default) this is byte-identical to
 * the original generator and draws the same PRNG values in the same order.
 */
export function generateMap(
  prng: number,
  kind: MapKind = 'classic',
): [TileGrid, number] {
  const grid = new Uint8Array(MAP_COLS * MAP_ROWS);

  if (kind === 'pirate') {
    // Fully authored layout: fill from the template, then apply the SAME
    // spawn-clear override the rolled kinds use (this opens the four spawn
    // corners that the template marks SOFT). Zero PRNG draws — the incoming
    // state is returned UNCHANGED on purpose.
    for (let y = 0; y < MAP_ROWS; y++) {
      for (let x = 0; x < MAP_COLS; x++) {
        grid[idx(x, y)] = isSpawnClear(x, y)
          ? TileKind.EMPTY
          : pirateTile(PIRATE_TEMPLATE[y]![x]!);
      }
    }
    return [grid, prng];
  }

  let p = prng;
  for (let y = 0; y < MAP_ROWS; y++) {
    for (let x = 0; x < MAP_COLS; x++) {
      if (hardForKind(x, y)) {
        grid[idx(x, y)] = TileKind.HARD;
      } else if (isSpawnClear(x, y)) {
        // Forced EMPTY at the spawn-clear L-zones. This draws no PRNG, so the
        // classic stream is untouched.
        grid[idx(x, y)] = TileKind.EMPTY;
      } else {
        // Exactly one PRNG draw per eligible tile.
        let roll: number;
        [roll, p] = prngFloat(p);
        grid[idx(x, y)] = roll < SOFT_BRICK_RATE ? TileKind.SOFT : TileKind.EMPTY;
      }
    }
  }
  return [grid, p];
}

/** Tile-level walkability: in bounds and EMPTY (bombs are checked separately). */
export function isWalkable(grid: TileGrid, x: number, y: number): boolean {
  return inBounds(x, y) && grid[idx(x, y)] === TileKind.EMPTY;
}
