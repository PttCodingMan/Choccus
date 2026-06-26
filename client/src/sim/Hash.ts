/**
 * FNV-1a 32-bit hash over a CANONICAL serialization of SimState — the
 * cross-client desync check for lockstep.
 *
 * Canonical order (determinism contract — changing it is a protocol change):
 *  1. tick, phase, prng
 *  2. params: moveSpeedMt, cornerAssistMt, inputBufferTicks
 *  3. map: length, then every tile byte in flat index order
 *  4. players: length, then per player (array order):
 *     slot, alive(0/1), trapped(0/1), trappedTicks, posX, posY, facing,
 *     fire, cannon, speedBonusTenths, activeBombs, prevDir, prevAction,
 *     bufferedDir, bufferedTicks, pushChargeDir, pushChargeTicks,
 *     heldStack.length, heldStack elements
 *  5. bombs: length, then per bomb: ownerSlot, tileX, tileY, fuseTicks, fire
 *  6. explosions: length, then per cell: tileX, tileY, ttlTicks
 *  7. items: length, then per item: tileX, tileY, kind
 *
 * The stored `stateHash` field itself is EXCLUDED. Every integer is folded
 * as 4 bytes little-endian (uint32 view); map tiles fold as single bytes.
 * No JSON.stringify anywhere — key order would not be canonical.
 */
import type { SimState } from './Sim';

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function foldByte(h: number, b: number): number {
  return Math.imul(h ^ (b & 0xff), FNV_PRIME) >>> 0;
}

/** Fold one integer as 4 bytes little-endian (taken as uint32). */
function foldInt(h: number, v: number): number {
  const u = v >>> 0;
  h = foldByte(h, u & 0xff);
  h = foldByte(h, (u >>> 8) & 0xff);
  h = foldByte(h, (u >>> 16) & 0xff);
  h = foldByte(h, (u >>> 24) & 0xff);
  return h;
}

/** Canonical FNV-1a 32-bit hash of a SimState (excluding `stateHash`). */
export function hashSimState(s: SimState): number {
  let h = FNV_OFFSET;
  // 1. scalars
  h = foldInt(h, s.tick);
  h = foldInt(h, s.phase);
  h = foldInt(h, s.prng);
  // 2. derived params
  h = foldInt(h, s.params.moveSpeedMt);
  h = foldInt(h, s.params.cornerAssistMt);
  h = foldInt(h, s.params.inputBufferTicks);
  // 3. map
  h = foldInt(h, s.map.length);
  for (let i = 0; i < s.map.length; i++) {
    h = foldByte(h, s.map[i] ?? 0);
  }
  // 4. players
  h = foldInt(h, s.players.length);
  for (const p of s.players) {
    h = foldInt(h, p.slot);
    h = foldInt(h, p.alive ? 1 : 0);
    h = foldInt(h, p.trapped ? 1 : 0);
    h = foldInt(h, p.trappedTicks);
    h = foldInt(h, p.posX);
    h = foldInt(h, p.posY);
    h = foldInt(h, p.facing);
    h = foldInt(h, p.fire);
    h = foldInt(h, p.cannon);
    h = foldInt(h, p.speedBonusTenths);
    h = foldInt(h, p.activeBombs);
    h = foldInt(h, p.prevDir);
    h = foldInt(h, p.prevAction);
    h = foldInt(h, p.bufferedDir);
    h = foldInt(h, p.bufferedTicks);
    h = foldInt(h, p.pushChargeDir);
    h = foldInt(h, p.pushChargeTicks);
    h = foldInt(h, p.heldStack.length);
    for (const d of p.heldStack) h = foldInt(h, d);
  }
  // 5. bombs
  h = foldInt(h, s.bombs.length);
  for (const b of s.bombs) {
    h = foldInt(h, b.ownerSlot);
    h = foldInt(h, b.tileX);
    h = foldInt(h, b.tileY);
    h = foldInt(h, b.fuseTicks);
    h = foldInt(h, b.fire);
  }
  // 6. explosions
  h = foldInt(h, s.explosions.length);
  for (const c of s.explosions) {
    h = foldInt(h, c.tileX);
    h = foldInt(h, c.tileY);
    h = foldInt(h, c.ttlTicks);
  }
  // 7. items
  h = foldInt(h, s.items.length);
  for (const it of s.items) {
    h = foldInt(h, it.tileX);
    h = foldInt(h, it.tileY);
    h = foldInt(h, it.kind);
  }
  return h >>> 0;
}
