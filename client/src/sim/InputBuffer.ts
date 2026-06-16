/**
 * Input model: "latest-press priority" stack + buffered retry.
 *
 * Raw input each tick is bitflags (`Direction` | `ActionFlags`). The held
 * stack turns simultaneous held direction bits into a deterministic priority
 * order: the most recently *pressed* direction wins. A fresh press that cannot
 * execute yet (blocked corridor) is remembered in `bufferedDir` and retried
 * for `inputBufferTicks` ticks.
 *
 * All buffer data lives as plain integers / int arrays on PlayerState so it
 * serializes and hashes like the rest of the sim state.
 */
import { Direction } from '../../../shared/types';

/** Per-player raw input for one tick. */
export interface InputFrame {
  /** Direction bitflags currently held. */
  dir: number;
  /** ActionFlags bitflags currently held. */
  action: number;
}

export const NO_INPUT: Readonly<InputFrame> = Object.freeze({
  dir: Direction.NONE,
  action: 0,
});

/**
 * Fixed scan order for direction bits. When several bits change in the SAME
 * tick this order breaks ties deterministically (part of the determinism
 * contract): UP, DOWN, LEFT, RIGHT.
 */
export const DIRECTION_ORDER: readonly number[] = [
  Direction.UP,
  Direction.DOWN,
  Direction.LEFT,
  Direction.RIGHT,
];

/**
 * Update the held-direction stack from last tick's bits to this tick's bits.
 * Returns a NEW array: released bits are removed (keeping order), newly
 * pressed bits are pushed on top in DIRECTION_ORDER. Top of stack (last
 * element) = most recent press = highest priority.
 */
export function updateHeldStack(
  stack: readonly number[],
  prevDir: number,
  curDir: number,
): number[] {
  const next: number[] = [];
  for (const d of stack) {
    if ((curDir & d) !== 0) next.push(d);
  }
  for (const d of DIRECTION_ORDER) {
    if ((curDir & d) !== 0 && (prevDir & d) === 0) next.push(d);
  }
  return next;
}

/**
 * The single newly pressed direction this tick (0 if none). If several bits
 * were pressed in the same tick, the LAST one in DIRECTION_ORDER wins — it is
 * also the one `updateHeldStack` pushed on top, keeping buffer and stack
 * consistent.
 */
export function newlyPressedDir(prevDir: number, curDir: number): number {
  let pressed = 0;
  for (const d of DIRECTION_ORDER) {
    if ((curDir & d) !== 0 && (prevDir & d) === 0) pressed = d;
  }
  return pressed;
}

/**
 * Build the ordered list of directions to attempt this tick:
 * buffered direction first (latest press, possibly already released), then
 * the held stack from most recent to oldest, skipping duplicates.
 */
export function resolveTryOrder(
  bufferedDir: number,
  bufferedTicks: number,
  heldStack: readonly number[],
): number[] {
  const order: number[] = [];
  if (bufferedDir !== 0 && bufferedTicks > 0) order.push(bufferedDir);
  for (let i = heldStack.length - 1; i >= 0; i--) {
    const d = heldStack[i];
    if (d !== undefined && d !== 0 && !order.includes(d)) order.push(d);
  }
  return order;
}
