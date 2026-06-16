/**
 * Bomb (a placed lump of chocolate). Fuse counts down in ticks; at 0 the
 * chocolate melts (detonates — see Explosion.ts). A bomb tile is solid to
 * movement for everyone; entities already on the tile may still walk off
 * because movement only ever checks the tile AHEAD (see Player.ts).
 */
import { FUSE_TICKS } from '../../../shared/constants';
import { ActionFlags } from '../../../shared/types';
import type { PlayerState } from './Player';

export interface BombState {
  ownerSlot: number;
  tileX: number;
  tileY: number;
  /** Counts down from FUSE_TICKS; detonates when it reaches 0. */
  fuseTicks: number;
  /** Snapshot of the owner's fire power at placement (cross-flow reach). */
  fire: number;
}

/** The bomb on tile (tx, ty), or undefined. At most one bomb per tile. */
export function bombAt(
  bombs: readonly BombState[],
  tx: number,
  ty: number,
): BombState | undefined {
  for (const b of bombs) {
    if (b.tileX === tx && b.tileY === ty) return b;
  }
  return undefined;
}

/** True when the BOMB action bit went from unpressed to pressed this tick. */
export function bombPressedEdge(prevAction: number, curAction: number): boolean {
  return (
    (curAction & ActionFlags.BOMB) !== 0 && (prevAction & ActionFlags.BOMB) === 0
  );
}

/**
 * Try to place a bomb at the player's current tile. Conditions: player alive
 * and not trapped, `activeBombs < cannon`, and no bomb already on that tile.
 * MUTATES the passed player clone (increments activeBombs) and returns the
 * new BombState, or null if placement failed. The caller owns the clone.
 */
export function tryPlaceBomb(
  bombs: readonly BombState[],
  player: PlayerState,
  tileX: number,
  tileY: number,
): BombState | null {
  if (!player.alive || player.trapped) return null;
  if (player.activeBombs >= player.cannon) return null;
  if (bombAt(bombs, tileX, tileY) !== undefined) return null;
  player.activeBombs += 1;
  return {
    ownerSlot: player.slot,
    tileX,
    tileY,
    fuseTicks: FUSE_TICKS,
    fire: player.fire,
  };
}
