/**
 * Top-level renderer: owns the Pixi v8 Application and fans `render(prev,
 * next, alpha)` out to the sub-renderers.
 *
 * Layer stack (bottom → top): tilemap(0), item(1), bomb(2), player(3),
 * explosion(4), shell(5), hud(10, screen-space strip below the arena).
 *
 * The app is created with `autoStart: false`: main.ts owns the rAF loop and
 * we render exactly once per `render()` call — no second Pixi ticker racing
 * the game loop.
 */
import { Application } from 'pixi.js';
import { MAP_COLS, MAP_ROWS, TILE_PX } from '../../../shared/constants';
import type { SimState } from '../sim/Sim';
import { BombRenderer } from './BombRenderer';
import { ExplosionRenderer } from './ExplosionRenderer';
import { HUD_HEIGHT_PX, HudRenderer } from './HudRenderer';
import { ItemRenderer } from './ItemRenderer';
import { PlayerRenderer } from './PlayerRenderer';
import { ShellRenderer } from './ShellRenderer';
import { TilemapRenderer } from './TilemapRenderer';

export class Renderer {
  private constructor(
    private readonly app: Application,
    private readonly tilemap: TilemapRenderer,
    private readonly items: ItemRenderer,
    private readonly bombs: BombRenderer,
    private readonly players: PlayerRenderer,
    private readonly explosions: ExplosionRenderer,
    private readonly shells: ShellRenderer,
    private readonly hud: HudRenderer,
  ) {}

  static async create(): Promise<Renderer> {
    const app = new Application();
    await app.init({
      width: MAP_COLS * TILE_PX, // 660
      height: MAP_ROWS * TILE_PX + HUD_HEIGHT_PX, // 572 + HUD
      background: '#f5e0c3',
      antialias: true, // M6 polish: rounded/curved shapes need smoothing
      autoStart: false, // main.ts drives rendering explicitly
    });

    const tilemap = new TilemapRenderer();
    const items = new ItemRenderer();
    const bombs = new BombRenderer();
    const players = new PlayerRenderer();
    const explosions = new ExplosionRenderer();
    const shells = new ShellRenderer();
    const hud = new HudRenderer();
    hud.container.position.set(0, MAP_ROWS * TILE_PX);

    // addChild order = z-order (bottom → top).
    app.stage.addChild(
      tilemap.container,
      items.container,
      bombs.container,
      players.container,
      explosions.container,
      shells.container,
      hud.container,
    );

    return new Renderer(
      app,
      tilemap,
      items,
      bombs,
      players,
      explosions,
      shells,
      hud,
    );
  }

  /** The canvas element to mount into the DOM. */
  get canvas(): HTMLCanvasElement {
    return this.app.canvas;
  }

  /**
   * Swap the HUD controls hint (defaults to the hotseat text).
   * `restartHint=false` also drops the "(R to restart)" banner suffix,
   * which only the hotseat mode can honour.
   */
  setHudHint(text: string, restartHint: boolean = true): void {
    this.hud.setHint(text, restartHint);
  }

  /**
   * Draw one frame: `alpha` ∈ [0, 1) is the fraction of the current tick
   * elapsed; entity positions blend between `prev` and `next`.
   */
  render(prev: SimState, next: SimState, alpha: number): void {
    this.tilemap.update(next);
    this.items.update(next, alpha);
    this.bombs.update(next);
    this.players.update(prev, next, alpha);
    this.explosions.update(next);
    this.shells.update(prev, next, alpha);
    this.hud.update(next);
    this.app.render();
  }
}
