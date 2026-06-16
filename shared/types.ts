/**
 * Cocoa Clash — shared enums / const-objects.
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
} as const;
export type TileKind = (typeof TileKind)[keyof typeof TileKind];

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
