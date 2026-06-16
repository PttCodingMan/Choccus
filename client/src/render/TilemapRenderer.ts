/**
 * Tilemap art: procedural chocolate-themed tiles.
 *
 * HARD bricks  — dark chocolate block with a bevel:
 *   • body fill, then lighter top/left edge highlight, darker bottom/right shadow.
 * SOFT bricks  — milk-chocolate block with a faint score line grid (inner cross),
 *   suggesting breakable segments, plus a subtle bevel.
 * EMPTY tiles  — creamy off-white floor, feint grid line between tiles.
 *
 * Redraws only when the map actually changed (soft brick destroyed) — a
 * 195-byte compare per frame is cheaper than re-tessellating 195 rects.
 */
import { Container, Graphics } from 'pixi.js';
import { MAP_COLS, MAP_ROWS, TILE_PX } from '../../../shared/constants';
import { TileKind } from '../../../shared/types';
import { idx } from '../sim/Map';
import type { SimState } from '../sim/Sim';

// Hard chocolate brick
const COLOR_HARD_BASE   = 0x3b1f0b; // very dark chocolate body
const COLOR_HARD_LIGHT  = 0x5a3018; // lighter top/left highlight edge
const COLOR_HARD_DARK   = 0x22110a; // darker bottom/right shadow edge

// Soft (milk-chocolate) brick
const COLOR_SOFT_BASE   = 0xa06b38; // warm milk chocolate body
const COLOR_SOFT_LIGHT  = 0xc8915a; // lighter highlight
const COLOR_SOFT_DARK   = 0x7a4e22; // shadow edge
const COLOR_SOFT_SCORE  = 0x8b5a28; // faint scored line (inner cross)

// Empty floor
const COLOR_FLOOR       = 0xf5e4c0; // cream floor
const COLOR_FLOOR_GRID  = 0xe8d4a8; // subtler grid line shade

const BEVEL = 2; // px for edge highlights

export class TilemapRenderer {
  readonly container = new Container();
  private readonly gfx = new Graphics();
  private lastMap: Uint8Array | null = null;

  constructor() {
    this.container.addChild(this.gfx);
  }

  update(state: SimState): void {
    if (this.lastMap !== null && sameMap(this.lastMap, state.map)) return;
    this.lastMap = new Uint8Array(state.map);

    const g = this.gfx;
    g.clear();
    for (let y = 0; y < MAP_ROWS; y++) {
      for (let x = 0; x < MAP_COLS; x++) {
        const px = x * TILE_PX;
        const py = y * TILE_PX;
        const kind = state.map[idx(x, y)] ?? TileKind.EMPTY;

        if (kind === TileKind.HARD) {
          drawHardBrick(g, px, py);
        } else if (kind === TileKind.SOFT) {
          drawSoftBrick(g, px, py);
        } else {
          drawEmptyTile(g, px, py);
        }
      }
    }
  }
}

function drawHardBrick(g: Graphics, px: number, py: number): void {
  const T = TILE_PX;
  // Base body
  g.rect(px, py, T, T).fill(COLOR_HARD_BASE);
  // Top highlight edge
  g.rect(px, py, T, BEVEL).fill(COLOR_HARD_LIGHT);
  // Left highlight edge
  g.rect(px, py, BEVEL, T).fill(COLOR_HARD_LIGHT);
  // Bottom shadow edge
  g.rect(px, py + T - BEVEL, T, BEVEL).fill(COLOR_HARD_DARK);
  // Right shadow edge
  g.rect(px + T - BEVEL, py, BEVEL, T).fill(COLOR_HARD_DARK);
  // Subtle inner inset line (1px) to reinforce the brick border
  g.rect(px + BEVEL, py + BEVEL, T - BEVEL * 2, 1).fill({ color: 0x000000, alpha: 0.08 });
  g.rect(px + BEVEL, py + BEVEL, 1, T - BEVEL * 2).fill({ color: 0x000000, alpha: 0.08 });
}

function drawSoftBrick(g: Graphics, px: number, py: number): void {
  const T = TILE_PX;
  // Base body
  g.rect(px, py, T, T).fill(COLOR_SOFT_BASE);
  // Top/left highlight
  g.rect(px, py, T, BEVEL).fill(COLOR_SOFT_LIGHT);
  g.rect(px, py, BEVEL, T).fill(COLOR_SOFT_LIGHT);
  // Bottom/right shadow
  g.rect(px, py + T - BEVEL, T, BEVEL).fill(COLOR_SOFT_DARK);
  g.rect(px + T - BEVEL, py, BEVEL, T).fill(COLOR_SOFT_DARK);
  // Scored inner cross (faint center lines suggesting chocolate segments)
  const cx = px + Math.floor(T / 2);
  const cy = py + Math.floor(T / 2);
  const inner = 4; // margin from edge
  g.rect(cx - 1, py + inner, 2, T - inner * 2).fill({ color: COLOR_SOFT_SCORE, alpha: 0.45 });
  g.rect(px + inner, cy - 1, T - inner * 2, 2).fill({ color: COLOR_SOFT_SCORE, alpha: 0.45 });
}

function drawEmptyTile(g: Graphics, px: number, py: number): void {
  const T = TILE_PX;
  // Floor fill
  g.rect(px, py, T, T).fill(COLOR_FLOOR);
  // Subtle grid lines at right and bottom edge
  g.rect(px + T - 1, py, 1, T).fill({ color: COLOR_FLOOR_GRID, alpha: 0.7 });
  g.rect(px, py + T - 1, T, 1).fill({ color: COLOR_FLOOR_GRID, alpha: 0.7 });
}

function sameMap(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
