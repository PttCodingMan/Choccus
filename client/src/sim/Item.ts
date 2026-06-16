/**
 * Items dropped by destroyed soft bricks (fire / speed / cannon, each 1/3).
 * Picked up when a player's (nearest) tile equals the item tile.
 */
import {
  PLAYER_MAX_CANNON,
  PLAYER_MAX_FIRE,
  SPEED_BONUS_CAP,
  SPEED_BONUS_PER_ITEM,
} from '../../../shared/constants';
import { ItemKind } from '../../../shared/types';
import type { PlayerState } from './Player';

/** Speed bonus is stored in integer tenths of a tile/s: +4 per item, cap 20. */
const SPEED_BONUS_TENTHS_PER_ITEM = Math.round(SPEED_BONUS_PER_ITEM * 10); // 4
const SPEED_BONUS_TENTHS_CAP = Math.round(SPEED_BONUS_CAP * 10); // 20

export interface ItemState {
  tileX: number;
  tileY: number;
  kind: ItemKind;
}

/** Apply an item's effect. MUTATES the passed player clone. */
export function applyItem(player: PlayerState, kind: ItemKind): void {
  if (kind === ItemKind.FIRE) {
    player.fire = Math.min(player.fire + 1, PLAYER_MAX_FIRE);
  } else if (kind === ItemKind.CANNON) {
    player.cannon = Math.min(player.cannon + 1, PLAYER_MAX_CANNON);
  } else {
    player.speedBonusTenths = Math.min(
      player.speedBonusTenths + SPEED_BONUS_TENTHS_PER_ITEM,
      SPEED_BONUS_TENTHS_CAP,
    );
  }
}
