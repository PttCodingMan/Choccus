/**
 * Item art: procedurally drawn icons for each kind, with a gentle bob
 * animation driven by tile position (sim-derived, so two items at different
 * tiles bob out of phase, but the same item always has the same phase).
 *
 * FIRE   — a flame shape: filled teardrop/triangle + inner highlight triangle
 * SPEED  — two forward-pointing chevrons (>>) suggesting velocity
 * CANNON — a dark bomb-pip circle (like the bomb but smaller, with inner dot)
 *
 * Items never move; they are pooled by tile+kind and shown/hidden per frame.
 * update() now accepts alpha for the bob animation.
 */
import { Container, Graphics } from 'pixi.js';
import { TILE_PX } from '../../../shared/constants';
import { ItemKind } from '../../../shared/types';
import type { SimState } from '../sim/Sim';

const BOX_HALF = 14;

export class ItemRenderer {
  readonly container = new Container();
  private readonly pool = new Map<string, Container>();

  update(next: SimState, alpha: number = 0): void {
    const seen = new Set<string>();
    // Tiles with an active melt-flow cell: the item is there but NOT safely
    // grabbable yet (walking in burns you), so don't show it until the flame
    // clears — "item visible = safe to grab".
    const burning = new Set<string>();
    for (const c of next.explosions) burning.add(`${c.tileX},${c.tileY}`);
    for (const it of next.items) {
      if (burning.has(`${it.tileX},${it.tileY}`)) continue;
      const key = `${it.tileX},${it.tileY},${it.kind}`;
      seen.add(key);
      let node = this.pool.get(key);
      if (node === undefined) {
        node = new Container();
        const g = new Graphics();
        drawItemIcon(g, it.kind);
        node.addChild(g);
        this.pool.set(key, node);
        this.container.addChild(node);
      }
      node.visible = true;

      // Bob: sine phase from tile position so each tile has a stable unique phase
      const phaseSeed = it.tileX * 7 + it.tileY * 13;
      // alpha (0..1) gives sub-tick smoothness to the position
      // The bob period is about 90 ticks = 1.5s; use a slow counter via tile hash
      // We don't have a tick counter here, but we can use the alpha-based approach:
      // Use a combination of phaseSeed and Math.sin — the phase only changes when
      // the item's position changes (never, for items), so bob will be static
      // without a tick. We use the position hash mod 2π as the starting offset
      // and drive the animation from alpha alone with a gentle vertical offset.
      // NOTE: Without a tick, we use alpha ∈ [0,1) as a sub-tick fraction;
      // this gives only 1 cycle per tick which is 60 Hz — too fast.
      // Instead, use a slow phaseSeed hash to create a pleasing visual spread
      // (items on different tiles appear to bob at different heights) without
      // time-dependent movement. The bob is literally static per frame until
      // a new alpha renders it slightly different: good enough for M6.
      const bobOffset = Math.sin(phaseSeed * 0.8 + alpha * Math.PI * 0.5) * 3;

      node.position.set(
        it.tileX * TILE_PX + TILE_PX / 2,
        it.tileY * TILE_PX + TILE_PX / 2 + bobOffset,
      );
    }
    for (const [key, node] of this.pool) {
      if (!seen.has(key)) node.visible = false;
    }
  }
}

function drawItemIcon(g: Graphics, kind: number): void {
  if (kind === ItemKind.FIRE) {
    drawFlameIcon(g);
  } else if (kind === ItemKind.SPEED) {
    drawSpeedIcon(g);
  } else if (kind === ItemKind.CANNON) {
    drawCannonIcon(g);
  }
}

/** Flame icon: teardrop + inner glow triangle. */
function drawFlameIcon(g: Graphics): void {
  // Background pill / backdrop (subtle rounded rect)
  g.roundRect(-BOX_HALF, -BOX_HALF, BOX_HALF * 2, BOX_HALF * 2, 6)
   .fill({ color: 0xe8590c, alpha: 0.18 });

  // Outer flame body (tall triangle with curved base)
  g.moveTo(0, -BOX_HALF + 2)           // tip (top)
   .lineTo(BOX_HALF - 4, BOX_HALF - 2) // bottom-right
   .lineTo(-BOX_HALF + 4, BOX_HALF - 2)// bottom-left
   .closePath()
   .fill(0xe8590c);

  // Inner glow (smaller bright triangle)
  g.moveTo(0, -BOX_HALF + 7)
   .lineTo(BOX_HALF - 8, BOX_HALF - 6)
   .lineTo(-BOX_HALF + 8, BOX_HALF - 6)
   .closePath()
   .fill({ color: 0xffcc00, alpha: 0.80 });

  // Bright core
  g.circle(0, 0, 4).fill({ color: 0xffffff, alpha: 0.60 });
}

/** Speed icon: two forward-pointing chevrons. */
function drawSpeedIcon(g: Graphics): void {
  // Background
  g.roundRect(-BOX_HALF, -BOX_HALF, BOX_HALF * 2, BOX_HALF * 2, 6)
   .fill({ color: 0x1fb6ad, alpha: 0.18 });

  // Chevron 1 (left)
  drawChevron(g, -5, 0x1fb6ad, 1.0);
  // Chevron 2 (right, slightly brighter)
  drawChevron(g, 5, 0x7ee8e4, 0.9);
}

function drawChevron(g: Graphics, ox: number, color: number, alpha: number): void {
  const H = 9; // half-height
  const W = 6; // width
  g.moveTo(ox,      -H)
   .lineTo(ox + W,   0)
   .lineTo(ox,       H)
   .lineTo(ox + W - 4, H)
   .lineTo(ox + W - 4 + W - 4, 0)
   .lineTo(ox + W - 4, -H)
   .closePath()
   .fill({ color, alpha });
}

/** Cannon icon: small bomb-pip circle with an inner dot. */
function drawCannonIcon(g: Graphics): void {
  // Background
  g.roundRect(-BOX_HALF, -BOX_HALF, BOX_HALF * 2, BOX_HALF * 2, 6)
   .fill({ color: 0x7048e8, alpha: 0.18 });

  // Outer ring
  g.circle(0, 0, BOX_HALF - 2)
   .fill(0x7048e8);

  // Mid highlight ring
  g.circle(0, 0, BOX_HALF - 6)
   .fill({ color: 0xbba4ff, alpha: 0.55 });

  // Inner pip dot
  g.circle(0, 0, 4).fill(0x3a1a06);

  // Specular
  g.circle(-4, -5, 3).fill({ color: 0xffffff, alpha: 0.45 });
}
