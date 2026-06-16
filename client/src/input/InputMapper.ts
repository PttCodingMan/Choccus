/**
 * Keyboard state → per-player InputFrame for one tick.
 *
 * What the sim expects (verified against sim/InputBuffer.ts and
 * sim/Player.ts):
 * - `InputFrame.dir` is the RAW bitmask of ALL currently held directions —
 *   NOT a single resolved direction. The sim itself resolves latest-press
 *   priority deterministically: each tick it diffs prevDir→dir to maintain a
 *   per-player held stack (PlayerState.heldStack) and a buffered retry
 *   (bufferedDir/bufferedTicks). So no press-order info crosses this
 *   boundary; just report what is held. (Simultaneous same-tick presses are
 *   tie-broken by the sim's fixed DIRECTION_ORDER.)
 * - `InputFrame.action` is the held ActionFlags bitmask. Bomb placement is
 *   edge-triggered INSIDE the sim (bombPressedEdge vs PlayerState.prevAction)
 *   — report BOMB while the key is held and the sim fires once per press.
 */
import { ActionFlags, Direction } from '../../../shared/types';
import type { InputFrame } from '../sim/InputBuffer';
import type { KeyboardInput } from './KeyboardInput';

interface KeyMap {
  readonly up: string;
  readonly down: string;
  readonly left: string;
  readonly right: string;
  readonly bomb: string;
}

/** Hotseat key maps by player slot: P1 = WASD + Space, P2 = Arrows + Enter. */
export const PLAYER_KEYMAPS: readonly KeyMap[] = [
  { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', bomb: 'Space' },
  {
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    bomb: 'Enter',
  },
];

/**
 * Sample the InputFrame for the SINGLE local player (online mode).
 * Controls: arrow keys move, Space drops a bomb. WASD is accepted as an
 * alias for movement so either habit works (one player, no conflict).
 */
export function sampleLocalInput(keyboard: KeyboardInput): InputFrame {
  let dir: number = Direction.NONE;
  if (keyboard.isDown('ArrowUp') || keyboard.isDown('KeyW')) dir |= Direction.UP;
  if (keyboard.isDown('ArrowDown') || keyboard.isDown('KeyS')) dir |= Direction.DOWN;
  if (keyboard.isDown('ArrowLeft') || keyboard.isDown('KeyA')) dir |= Direction.LEFT;
  if (keyboard.isDown('ArrowRight') || keyboard.isDown('KeyD')) dir |= Direction.RIGHT;
  const action: number = keyboard.isDown('Space')
    ? ActionFlags.BOMB
    : ActionFlags.NONE;
  return { dir, action };
}

/** Sample one InputFrame per player slot for the upcoming sim tick. */
export function sampleInputs(
  keyboard: KeyboardInput,
  numPlayers: number,
): InputFrame[] {
  const frames: InputFrame[] = [];
  for (let slot = 0; slot < numPlayers; slot++) {
    const map = PLAYER_KEYMAPS[slot];
    if (map === undefined) {
      frames.push({ dir: Direction.NONE, action: ActionFlags.NONE });
      continue;
    }
    let dir: number = Direction.NONE;
    if (keyboard.isDown(map.up)) dir |= Direction.UP;
    if (keyboard.isDown(map.down)) dir |= Direction.DOWN;
    if (keyboard.isDown(map.left)) dir |= Direction.LEFT;
    if (keyboard.isDown(map.right)) dir |= Direction.RIGHT;
    const action: number = keyboard.isDown(map.bomb)
      ? ActionFlags.BOMB
      : ActionFlags.NONE;
    frames.push({ dir, action });
  }
  return frames;
}
