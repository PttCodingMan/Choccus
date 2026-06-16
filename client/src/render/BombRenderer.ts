/**
 * Bomb (placed chocolate lump) art: a glossy dark-chocolate circle with a
 * specular highlight, a faint rim shadow, and an intensifying scale-pulse as
 * fuseTicks approaches 0. Animation phase is derived purely from fuseTicks —
 * never from wall-clock time, keeping rendering deterministic.
 *
 * Pulse behaviour:
 *  - Base scale 1.0. Oscillates with Math.sin(fuseTicks * speed).
 *  - Speed ramps up in the last ~60 ticks (1 s), giving visual urgency.
 *  - Scale wobble ±8%; alpha wobble ±15%. Purely cosmetic.
 *
 * Graphics are re-drawn only on creation; scale/alpha drive the animation
 * so there is no per-frame geometry allocation.
 */
import { Container, Graphics } from 'pixi.js';
import { FUSE_TICKS, TICK_HZ, TILE_PX } from '../../../shared/constants';
import type { SimState } from '../sim/Sim';

const RADIUS       = 17;   // body radius (px)
const COLOR_BODY   = 0x3a1a06; // very dark chocolate
const COLOR_RIM    = 0x1a0a02; // near-black rim
const COLOR_SHEEN  = 0xfff2d9; // specular highlight

export class BombRenderer {
  readonly container = new Container();
  private readonly pool = new Map<string, Graphics>();

  update(next: SimState): void {
    const seen = new Set<string>();
    for (const b of next.bombs) {
      const key = `${b.tileX},${b.tileY}`;
      seen.add(key);
      let g = this.pool.get(key);
      if (g === undefined) {
        g = new Graphics();
        // Rim (slightly larger outer circle for depth shadow)
        g.circle(0, 0, RADIUS + 2).fill(COLOR_RIM);
        // Main chocolate body
        g.circle(0, 0, RADIUS).fill(COLOR_BODY);
        // Secondary mid-sheen (inner tinted glow)
        g.circle(-3, -3, RADIUS - 6).fill({ color: 0x6a3a18, alpha: 0.35 });
        // Specular highlight — small bright oval near top-left
        g.ellipse(-6, -7, 5, 3).fill({ color: COLOR_SHEEN, alpha: 0.75 });
        // Tiny top-center dot highlight (secondary specular)
        g.circle(1, -9, 2).fill({ color: 0xffffff, alpha: 0.45 });
        this.pool.set(key, g);
        this.container.addChild(g);
      }

      g.visible = true;
      g.position.set(
        b.tileX * TILE_PX + TILE_PX / 2,
        b.tileY * TILE_PX + TILE_PX / 2,
      );

      // Pulse: ramp up speed in the final second of fuse.
      const urgency = b.fuseTicks < TICK_HZ ? 0.38 : 0.11;
      const phase   = Math.sin(b.fuseTicks * urgency);
      // Scale wobble: 0.92 … 1.08
      const scl = 1.0 + 0.08 * phase;
      g.scale.set(scl);
      // Alpha wobble: 0.75 … 1.0
      g.alpha = 0.875 + 0.125 * phase;

      // Final-second: saturate urgency by also tinting toward red (done by
      // boosting alpha band toward 1.0 as fuse nears 0).
      if (b.fuseTicks < TICK_HZ / 2) {
        const nearEnd = 1 - b.fuseTicks / (TICK_HZ / 2); // 0→1
        g.alpha = Math.min(1, g.alpha + 0.1 * nearEnd);
      }
    }
    for (const [key, g] of this.pool) {
      if (!seen.has(key)) g.visible = false;
    }
  }

  /** Clean up pooled Graphics that are no longer needed (e.g. on match reset). */
  clear(): void {
    for (const g of this.pool.values()) {
      g.destroy();
    }
    this.pool.clear();
  }
}

// Silence unused-import for FUSE_TICKS (used as documentation anchor)
void FUSE_TICKS;
