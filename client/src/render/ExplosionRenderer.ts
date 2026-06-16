/**
 * Explosion (melt-flow) art: a glowing molten cell with a hot center →
 * cooler edge gradient, alpha-fading as ttlTicks → 0.
 *
 * Drawn with multiple concentric fills: innermost is the brightest white-
 * yellow core, then orange, then deep chocolate at the outer edge — reading
 * as melted chocolate with a glowing hot center.
 *
 * A 1-tick flicker is added (derived from ttlTicks parity) to suggest
 * a living melt-flow without touching wall-clock time.
 *
 * Call signature: update(next) — tile-locked cells never move, so no alpha
 * interpolation is needed.
 */
import { Container, Graphics } from 'pixi.js';
import { TILE_PX } from '../../../shared/constants';
import type { SimState } from '../sim/Sim';

const HALF = TILE_PX / 2;
// Concentric layer colors (outer → inner)
const LAYERS: Array<{ shrink: number; color: number }> = [
  { shrink: 0,  color: 0x7a2e00 }, // outer dark chocolate melt
  { shrink: 4,  color: 0xc44800 }, // mid orange melt
  { shrink: 8,  color: 0xff7a00 }, // inner bright orange
  { shrink: 12, color: 0xffcf4d }, // hot center glow
  { shrink: 16, color: 0xffffcc }, // innermost white-hot core
];

export class ExplosionRenderer {
  readonly container = new Container();
  private readonly gfx = new Graphics();

  constructor() {
    this.container.addChild(this.gfx);
  }

  update(next: SimState): void {
    const g = this.gfx;
    g.clear();
    for (const c of next.explosions) {
      // The cell is LETHAL for its whole life (ttlTicks > 0), so keep it
      // clearly visible the entire time and only fade out over the last few
      // ticks — "flame shown = it burns; flame gone = safe to enter".
      const FADE_OUT_TICKS = 5;
      const fade = Math.max(0, Math.min(1, c.ttlTicks / FADE_OUT_TICKS));
      // Flicker: every other tick slightly dims the outer layer (sim-derived)
      const flicker = (c.ttlTicks & 1) === 0 ? 0.9 : 1.0;
      const baseAlpha = (0.7 + 0.3 * fade) * flicker;
      const cx = c.tileX * TILE_PX;
      const cy = c.tileY * TILE_PX;

      for (const layer of LAYERS) {
        const s = layer.shrink;
        const layerAlpha =
          layer.shrink === 0 ? baseAlpha : Math.min(1, baseAlpha * 1.15);
        g.rect(cx + s, cy + s, TILE_PX - s * 2, TILE_PX - s * 2).fill({
          color: layer.color,
          alpha: layerAlpha,
        });
      }

      // Soft radial sheen: a small bright circle at the very center
      const centerX = c.tileX * TILE_PX + HALF;
      const centerY = c.tileY * TILE_PX + HALF;
      g.circle(centerX, centerY, 5).fill({
        color: 0xffffff,
        alpha: 0.6 * fade,
      });
    }
  }
}
