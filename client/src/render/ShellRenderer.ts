/**
 * Sugar-shell (trap) visuals. The sim has no shells[] array — trap state
 * lives on PlayerState (`trapped` + `trappedTicks`, see sim/Shell.ts) — so
 * this renderer derives shell boxes from trapped players. It is a SEPARATE
 * layer (z above explosions) so the shell stays readable while melt-flow
 * overlays the tile; PlayerRenderer draws only the body underneath.
 *
 * Visual: a crystalline sugar shell drawn as concentric faceted shapes:
 *  • outer translucent amber octagon-like rounded rect (fill + stroke)
 *  • inner bright facet lines (diagonal highlights) to suggest crystal faces
 *  • a countdown Text above the shell
 *  • gentle pulse scaling derived from trappedTicks (sim-derived, deterministic)
 */
import { Container, Graphics, Text } from 'pixi.js';
import { TICK_HZ, TRAPPED_TICKS } from '../../../shared/constants';
import type { SimState } from '../sim/Sim';
import { interpEntityPx } from './interpolate';

const SHELL_HALF   = 20;   // outer half-size in pixels
const INNER_HALF   = 15;   // inner facet half-size

const COLOR_AMBER_FILL   = 0xffe082; // translucent amber body
const COLOR_AMBER_STROKE = 0xb8860b; // gold crystal rim
const COLOR_FACET_A      = 0xffffff; // bright facet highlight
const COLOR_FACET_B      = 0xffd54f; // warm secondary facet
const COLOR_PULSE_OUTER  = 0xffecb3; // outer glow fill when fully trapped

interface ShellView {
  root: Container;
  shell: Graphics;
  countdown: Text;
}

export class ShellRenderer {
  readonly container = new Container();
  private readonly pool = new Map<number, ShellView>();

  update(prev: SimState, next: SimState, alpha: number): void {
    const seen = new Set<number>();

    for (const pl of next.players) {
      if (!pl.alive || !pl.trapped) continue;
      seen.add(pl.slot);

      let view = this.pool.get(pl.slot);
      if (view === undefined) {
        const root = new Container();
        const shell = new Graphics();
        const countdown = new Text({
          text: '',
          style: {
            fontFamily: 'monospace',
            fontSize: 14,
            fontWeight: 'bold',
            fill: 0x7a4a00,
            stroke: { color: 0xfff3cd, width: 3 },
          },
        });
        countdown.anchor.set(0.5);
        countdown.position.set(0, -SHELL_HALF - 12);
        root.addChild(shell, countdown);
        view = { root, shell, countdown };
        this.pool.set(pl.slot, view);
        this.container.addChild(root);
      }

      view.root.visible = true;

      // Position: interpolate the transition into trapped state smoothly
      const prevPl = prev.players.find((p) => p.slot === pl.slot);
      const { x, y } = interpEntityPx(prevPl, pl, alpha);
      view.root.position.set(x, y);

      // Pulse scale: gentle 0.95–1.05 derived from trappedTicks
      const pulsePhase = Math.sin((pl.trappedTicks / TICK_HZ) * Math.PI * 2.4);
      view.root.scale.set(1.0 + 0.04 * pulsePhase);

      // Urgency: as trappedTicks approaches 0 the shell gets more opaque
      const urgency = 1 - pl.trappedTicks / TRAPPED_TICKS; // 0 (fresh) → 1 (almost gone)
      const bodyAlpha = 0.45 + 0.30 * urgency;
      const strokeAlpha = 0.70 + 0.30 * urgency;

      // Redraw shell geometry (color changes with urgency)
      const sg = view.shell;
      sg.clear();

      // Outer glow halo (very faint, larger)
      sg.rect(
        -(SHELL_HALF + 4),
        -(SHELL_HALF + 4),
        (SHELL_HALF + 4) * 2,
        (SHELL_HALF + 4) * 2,
      ).fill({ color: COLOR_PULSE_OUTER, alpha: 0.12 + 0.1 * urgency });

      // Main crystalline body
      sg.roundRect(-SHELL_HALF, -SHELL_HALF, SHELL_HALF * 2, SHELL_HALF * 2, 5)
        .fill({ color: COLOR_AMBER_FILL, alpha: bodyAlpha })
        .stroke({ color: COLOR_AMBER_STROKE, width: 2, alpha: strokeAlpha });

      // Inner facet diamond (rotated rect) for crystal faces
      sg.rect(-INNER_HALF, -INNER_HALF, INNER_HALF * 2, INNER_HALF * 2).fill({
        color: COLOR_FACET_B,
        alpha: 0.18,
      });

      // Diagonal facet lines (top-left → bottom-right and top-right → bottom-left)
      // Top-left facet highlight
      sg.moveTo(-SHELL_HALF, -SHELL_HALF)
        .lineTo(-SHELL_HALF + 8, -SHELL_HALF)
        .lineTo(-SHELL_HALF, -SHELL_HALF + 8)
        .fill({ color: COLOR_FACET_A, alpha: 0.55 });

      // Top-right facet
      sg.moveTo(SHELL_HALF, -SHELL_HALF)
        .lineTo(SHELL_HALF - 8, -SHELL_HALF)
        .lineTo(SHELL_HALF, -SHELL_HALF + 8)
        .fill({ color: COLOR_FACET_A, alpha: 0.35 });

      // Bottom-left facet shadow
      sg.moveTo(-SHELL_HALF, SHELL_HALF)
        .lineTo(-SHELL_HALF + 8, SHELL_HALF)
        .lineTo(-SHELL_HALF, SHELL_HALF - 8)
        .fill({ color: COLOR_AMBER_STROKE, alpha: 0.30 });

      // Bottom-right facet shadow
      sg.moveTo(SHELL_HALF, SHELL_HALF)
        .lineTo(SHELL_HALF - 8, SHELL_HALF)
        .lineTo(SHELL_HALF, SHELL_HALF - 8)
        .fill({ color: COLOR_AMBER_STROKE, alpha: 0.30 });

      // Urgency tint: red outline pulsing when < 1s remains
      if (pl.trappedTicks < TICK_HZ) {
        const nearEnd = 1 - pl.trappedTicks / TICK_HZ;
        sg.roundRect(-SHELL_HALF, -SHELL_HALF, SHELL_HALF * 2, SHELL_HALF * 2, 5)
          .stroke({ color: 0xff4444, width: 2, alpha: 0.5 * nearEnd });
      }

      view.countdown.text = (pl.trappedTicks / TICK_HZ).toFixed(1);
    }

    for (const [slot, view] of this.pool) {
      if (!seen.has(slot)) view.root.visible = false;
    }
  }
}
