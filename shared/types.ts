/**
 * Chocco — shared enums / const-objects.
 *
 * Plain `as const` objects (not TS `enum`) so values stay simple integers that
 * serialize 1:1 over MessagePack and are trivial to mirror in Python.
 */

// ---------------------------------------------------------------------------
// Map tiles
// ---------------------------------------------------------------------------

export const TileKind = {
  EMPTY: 0,
  /** Indestructible: outer ring + even (x,y) coordinate tiles. */
  HARD: 1,
  /** Destructible; may drop an item. */
  SOFT: 2,
  /**
   * Pushable brick (village map): a SOFT-equivalent destructible brick that a
   * player can shove one tile (see Player.ts canPush). For EVERY blast model —
   * the sim's Explosion.ts AND the AI's danger raycasts — it behaves IDENTICALLY
   * to SOFT (the arm stops at it, destroys it, may drop an item). The only
   * difference from SOFT is that movement can push it. Use `isDestructibleBrick`
   * everywhere a blast arm tests for SOFT so the AI stays word-aligned with the sim.
   */
  PUSH: 3,
} as const;
export type TileKind = (typeof TileKind)[keyof typeof TileKind];

/**
 * A brick a blast arm stops at and destroys (SOFT or pushable PUSH). The sim and
 * every AI danger raycast MUST gate on this, not a bare `=== SOFT`, so pushable
 * bricks block/clear flame exactly like soft ones. HARD is separate (stops, no clear).
 */
export function isDestructibleBrick(kind: number): boolean {
  return kind === TileKind.SOFT || kind === TileKind.PUSH;
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export const EntityType = {
  PLAYER: 0,
  /** Reserved (legacy lantern enemy; entity removed). Value kept to avoid renumbering. */
  ENEMY: 1,
  /** A placed lump of chocolate (the "bomb"). */
  BOMB: 2,
  /** Melt-flow cross (the explosion). */
  EXPLOSION: 3,
  /** Solidified sugar shell trapping a player. */
  SHELL: 4,
  ITEM: 5,
} as const;
export type EntityType = (typeof EntityType)[keyof typeof EntityType];

// ---------------------------------------------------------------------------
// Items (each 1/3 on drop)
// ---------------------------------------------------------------------------

export const ItemKind = {
  FIRE: 0,
  SPEED: 1,
  CANNON: 2,
} as const;
export type ItemKind = (typeof ItemKind)[keyof typeof ItemKind];

// ---------------------------------------------------------------------------
// Game phase
// ---------------------------------------------------------------------------

export const GamePhase = {
  LOBBY: 0,
  PLAYING: 1,
  OVER: 2,
} as const;
export type GamePhase = (typeof GamePhase)[keyof typeof GamePhase];

// ---------------------------------------------------------------------------
// Per-tick input encoding (bit flags, packed into InputFrame)
// ---------------------------------------------------------------------------

export const Direction = {
  NONE: 0,
  UP: 1 << 0,
  DOWN: 1 << 1,
  LEFT: 1 << 2,
  RIGHT: 1 << 3,
} as const;
export type Direction = (typeof Direction)[keyof typeof Direction];

export const ActionFlags = {
  NONE: 0,
  /** Place a chocolate bomb this tick. */
  BOMB: 1 << 0,
} as const;
export type ActionFlags = (typeof ActionFlags)[keyof typeof ActionFlags];
