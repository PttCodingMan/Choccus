/**
 * Raw keyboard state for local hotseat play. Tracks which physical keys
 * (KeyboardEvent.code) are currently held, plus their press order
 * (oldest → newest) for reference.
 *
 * NOTE on press order: the sim's InputBuffer resolves latest-press priority
 * INTERNALLY (PlayerState.heldStack, built from tick-to-tick dir-bit
 * transitions — see sim/InputBuffer.ts), so the per-tick InputFrame only
 * carries raw held bitflags. The press-order array here is therefore not
 * transmitted to the sim; it exists for debugging and possible future use.
 *
 * Game keys are preventDefault'ed so arrows/space/enter never scroll or
 * re-trigger focused buttons. Window blur clears all held keys to avoid
 * stuck-key states after alt-tab.
 */

/** All codes the game consumes (P1: WASD+Space, P2: Arrows+Enter). */
export const GAME_KEY_CODES: ReadonlySet<string> = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Enter',
]);

export class KeyboardInput {
  private readonly held = new Set<string>();
  private order: string[] = [];

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!GAME_KEY_CODES.has(e.code)) return;
    e.preventDefault();
    if (e.repeat || this.held.has(e.code)) return;
    this.held.add(e.code);
    this.order.push(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (!GAME_KEY_CODES.has(e.code)) return;
    e.preventDefault();
    this.held.delete(e.code);
    this.order = this.order.filter((c) => c !== e.code);
  };

  private readonly onBlur = (): void => {
    this.held.clear();
    this.order = [];
  };

  attach(target: Window = window): void {
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('blur', this.onBlur);
  }

  detach(target: Window = window): void {
    target.removeEventListener('keydown', this.onKeyDown);
    target.removeEventListener('keyup', this.onKeyUp);
    target.removeEventListener('blur', this.onBlur);
  }

  /** Is the physical key with this KeyboardEvent.code currently held? */
  isDown(code: string): boolean {
    return this.held.has(code);
  }

  /** Currently held game keys, oldest press first (see note above). */
  get heldOrder(): readonly string[] {
    return this.order;
  }
}
