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
 * Edge latch (consumePress): movement is level-sampled (held bits) and the sim
 * buffers a fresh press for inputBufferTicks, so a quick direction tap is
 * forgiving. The BOMB action has NO such buffer — it is pure edge detection
 * (sim/Bomb.ts bombPressedEdge) on whatever the once-per-tick sampler happened
 * to observe. A keydown→keyup that lands entirely between two samples (the
 * sample interval grows under frame drops / the hidden-tab pump) would never be
 * seen as held and the bomb tap is silently lost — felt as unresponsive
 * controls exactly when the game is already janky. `consumePress` latches a
 * fresh press so the NEXT sample still sees it once, guaranteeing every tap
 * registers regardless of sample cadence. Latch is per-key and one-shot
 * (cleared on read), so a held key still fires exactly one rising edge.
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
  /** Keys that saw a fresh keydown since their last consumePress (edge latch). */
  private readonly pressedSinceSample = new Set<string>();

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!GAME_KEY_CODES.has(e.code)) return;
    e.preventDefault();
    if (e.repeat || this.held.has(e.code)) return;
    this.held.add(e.code);
    this.order.push(e.code);
    // Latch the rising edge so a tap that releases before the next sample is
    // still observed once (see consumePress / class header).
    this.pressedSinceSample.add(e.code);
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
    this.pressedSinceSample.clear();
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

  /**
   * Edge-triggered read for action keys: true if the key is currently held OR
   * was tapped (down→up) since the last call, then clears the one-shot latch.
   * Call exactly once per sample per key so a held key reports the latch only on
   * its first sample (the held state covers the rest). Lets a fast bomb tap that
   * falls between two samples still register exactly one rising edge in the sim.
   */
  consumePress(code: string): boolean {
    const pressed = this.pressedSinceSample.delete(code);
    return this.held.has(code) || pressed;
  }

  /** Currently held game keys, oldest press first (see note above). */
  get heldOrder(): readonly string[] {
    return this.order;
  }
}
