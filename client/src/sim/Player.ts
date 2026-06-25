/**
 * Player state + the shared corridor grid-movement helper.
 *
 * Movement model (from spec, all integer millitiles):
 * - Coordinates are millitiles; an integer multiple of MILLITILE is a tile
 *   center. Invariant: an entity is ALWAYS exactly aligned on at least one
 *   axis (it lives on corridor centerlines); every move preserves this.
 * - Straight movement: advance along the held axis; when the tile ahead of
 *   the current tile center is blocked (not walkable OR holds a bomb), clamp
 *   at the current tile center (never move backward). Per-tick speed is far
 *   below half a tile, so at most one center is crossed per tick.
 * - Corner assist: pressing a perpendicular direction while off-center is
 *   allowed when the offset from a candidate corridor centerline is within
 *   (0.5 + tolerance) tiles AND the opening tile in the pressed direction at
 *   that row/column is open. The entity slides along the perpendicular axis
 *   at full move speed toward the centerline; leftover per-tick speed after
 *   reaching the centerline is spent along the pressed axis. Both candidate
 *   centerlines (nearest first, then the far one) are tested in that fixed
 *   order — part of the determinism contract.
 * - Input: latest-press priority stack + buffered retry (see InputBuffer.ts).
 */
import {
  MILLITILE,
  PLAYER_START_CANNON,
  PLAYER_START_FIRE,
  PLAYER_START_SPEED_BONUS,
  PUSH_CHARGE_TICKS,
  TICK_HZ,
} from '../../../shared/constants';
import { Direction, TileKind } from '../../../shared/types';
import { type BombState, bombAt } from './Bomb';
import {
  type InputFrame,
  newlyPressedDir,
  resolveTryOrder,
  updateHeldStack,
} from './InputBuffer';
import { type TileGrid, idx, inBounds, isWalkable } from './Map';

/** Integer sim parameters derived once from FeelParams (see Sim.ts). */
export interface SimParams {
  /** Base move speed in millitiles/s. */
  readonly moveSpeedMt: number;
  /** Corner-assist tolerance in millitiles. */
  readonly cornerAssistMt: number;
  /** Input buffer window in ticks. */
  readonly inputBufferTicks: number;
  /**
   * Vestigial PvP flag. The game is ALWAYS last-team-standing PvP; this field
   * no longer branches anything in the sim. Kept for compatibility (and as a
   * whole-match constant carried by MatchStart). NOT hashed.
   */
  readonly pvp: boolean;
}

export interface PlayerState {
  slot: number;
  /**
   * Team id. NOT hashed: it is a whole-match constant assigned once by
   * createInitialState (and, in net mode, derived identically on every client
   * from MatchStart), so it cannot diverge. Its effect on the sim surfaces
   * only through already-hashed fields (alive/trapped via rescue gating, and
   * phase via the PvP win check).
   */
  team: number;
  alive: boolean;
  /** Trapped inside a solidified sugar shell (reversible — see Shell.ts). */
  trapped: boolean;
  /** Remaining shell ticks while trapped (counts down from TRAPPED_TICKS). */
  trappedTicks: number;
  /** Position in millitiles (tile center = tileIndex * MILLITILE). */
  posX: number;
  posY: number;
  facing: Direction;
  fire: number;
  cannon: number;
  /** Speed bonus in tenths of a tile/s (+4 per item, cap 20 = +2.0). */
  speedBonusTenths: number;
  activeBombs: number;
  // --- input-buffer fields (plain ints/arrays; hashed with the state) ---
  /** Held directions, oldest→newest; last element = most recent press. */
  heldStack: number[];
  prevDir: number;
  prevAction: number;
  /** Buffered (latest-pressed) direction retried while bufferedTicks > 0. */
  bufferedDir: number;
  bufferedTicks: number;
  /** Crate-push charge: ticks spent leaning into the crate in pushChargeDir
   * (0 when not charging). At PUSH_CHARGE_TICKS the crate slides and this resets. */
  pushChargeDir: number;
  pushChargeTicks: number;
}

export function createPlayer(
  slot: number,
  tileX: number,
  tileY: number,
  team = 0,
): PlayerState {
  return {
    slot,
    team,
    alive: true,
    trapped: false,
    trappedTicks: 0,
    posX: tileX * MILLITILE,
    posY: tileY * MILLITILE,
    facing: Direction.DOWN,
    fire: PLAYER_START_FIRE,
    cannon: PLAYER_START_CANNON,
    speedBonusTenths: PLAYER_START_SPEED_BONUS,
    activeBombs: 0,
    heldStack: [],
    prevDir: 0,
    prevAction: 0,
    bufferedDir: 0,
    bufferedTicks: 0,
    pushChargeDir: 0,
    pushChargeTicks: 0,
  };
}

/** Shallow clone safe to mutate within one tick. */
export function clonePlayer(p: PlayerState): PlayerState {
  return { ...p, heldStack: p.heldStack.slice() };
}

// ---------------------------------------------------------------------------
// Shared movement helper
// ---------------------------------------------------------------------------

/** Nearest tile index for a millitile coordinate. */
export function tileOf(mt: number): number {
  return Math.round(mt / MILLITILE);
}

export function dirDX(d: number): number {
  return d === Direction.LEFT ? -1 : d === Direction.RIGHT ? 1 : 0;
}

export function dirDY(d: number): number {
  return d === Direction.UP ? -1 : d === Direction.DOWN ? 1 : 0;
}

/** Tile is enterable: walkable terrain and no bomb on it. */
export function isOpen(
  grid: TileGrid,
  bombs: readonly BombState[],
  x: number,
  y: number,
): boolean {
  return isWalkable(grid, x, y) && bombAt(bombs, x, y) === undefined;
}

/**
 * Straight movement along one axis. `a` is the coordinate on the movement
 * axis, `bTile` the (aligned) perpendicular tile index. Movement only ever
 * checks the tile AHEAD, so an entity standing on a bomb tile can walk off.
 */
function moveStraight(
  open: (aTile: number, bTile: number) => boolean,
  a: number,
  bTile: number,
  sign: number,
  speed: number,
): number {
  const c = tileOf(a);
  let na = a + sign * speed;
  if (!open(c + sign, bTile)) {
    // Blocked ahead: advance at most to the current tile center, never back.
    if (sign > 0) na = Math.min(na, Math.max(a, c * MILLITILE));
    else na = Math.max(na, Math.min(a, c * MILLITILE));
  }
  return na;
}

/**
 * One movement attempt along axis `a` (sign ±1) with perpendicular coordinate
 * `b`. Returns [newA, newB, moved]. Handles both straight movement and
 * corner assist (perpendicular slide at full speed, remainder spent on `a`).
 */
function stepAxis(
  open: (aTile: number, bTile: number) => boolean,
  a: number,
  b: number,
  sign: number,
  speed: number,
  tolMt: number,
): [number, number, boolean] {
  const bNear = tileOf(b);
  const offB = b - bNear * MILLITILE;
  if (offB === 0) {
    const na = moveStraight(open, a, bNear, sign, speed);
    return [na, b, na !== a];
  }
  // Corner assist. By the alignment invariant, `a` is at a tile center here.
  const aTile = tileOf(a);
  const candidates = [bNear, bNear + (offB > 0 ? 1 : -1)];
  for (const r of candidates) {
    const dist = b > r * MILLITILE ? b - r * MILLITILE : r * MILLITILE - b;
    if (dist > MILLITILE / 2 + tolMt) continue;
    if (!open(aTile + sign, r)) continue;
    // Sliding to the far centerline also enters that tile — it must be open.
    if (r !== bNear && !open(aTile, r)) continue;
    const dirB = r * MILLITILE > b ? 1 : -1;
    const slide = Math.min(speed, dist);
    const nb = b + dirB * slide;
    let na = a;
    const rest = speed - slide;
    if (rest > 0 && nb === r * MILLITILE) {
      na = moveStraight(open, a, r, sign, rest);
    }
    return [na, nb, true];
  }
  return [a, b, false];
}

/**
 * Attempt to move an entity one tick in `dir`. Pure: returns
 * [newPosX, newPosY, moved]. `tolMt` = corner-assist tolerance in millitiles
 * (players: params.cornerAssistMt).
 */
export function stepEntity(
  grid: TileGrid,
  bombs: readonly BombState[],
  posX: number,
  posY: number,
  dir: number,
  speedMt: number,
  tolMt: number,
): [number, number, boolean] {
  const dx = dirDX(dir);
  if (dx !== 0) {
    return stepAxis(
      (at, bt) => isOpen(grid, bombs, at, bt),
      posX,
      posY,
      dx,
      speedMt,
      tolMt,
    );
  }
  const dy = dirDY(dir);
  if (dy !== 0) {
    const [na, nb, moved] = stepAxis(
      (at, bt) => isOpen(grid, bombs, bt, at),
      posY,
      posX,
      dy,
      speedMt,
      tolMt,
    );
    return [nb, na, moved];
  }
  return [posX, posY, false];
}

/**
 * Try to push a PUSH brick one tile in direction `dir`. MUTATES `grid` (the
 * caller's per-tick clone) and returns true on a successful shove. Fires only
 * when the player is EXACTLY centered on a tile (both axes aligned), the tile
 * directly ahead is a PUSH brick, and the tile beyond it is open (walkable +
 * bomb-free). The brick slides one tile; the player does NOT advance this tick.
 *
 * This self-throttles: after a push the brick is one tile ahead with a gap, so
 * the player must walk back up to it (~one tile at move speed) before pushing
 * again — yielding a one-tile-hop slide at player speed with no cooldown state.
 *
 * ponytail: instant one-tile snap, no slide animation and the player stays put;
 * if a snappier "push-and-step-in" feel is wanted later, advance the player into
 * the vacated tile here. Determinism: grid mutates in player-array order inside
 * tick step (1), so a brick player i pushes is visible to player i+1 that tick.
 */
/**
 * Whether a PUSH brick directly ahead in `dir` could be shoved one tile (player
 * dead-centered, brick ahead, tile beyond open). Does NOT mutate — the actual
 * shove is gated behind a charge (see stepPlayerMovement) so heavy crates need
 * sustained force. `applyPush` performs the move once the charge is full.
 */
function canPush(
  grid: TileGrid,
  bombs: readonly BombState[],
  posX: number,
  posY: number,
  dir: number,
): boolean {
  // Require a dead-center stance: both axes at a tile center.
  if (posX % MILLITILE !== 0 || posY % MILLITILE !== 0) return false;
  const dx = dirDX(dir);
  const dy = dirDY(dir);
  if (dx === 0 && dy === 0) return false;
  const cx = tileOf(posX);
  const cy = tileOf(posY);
  const ax = cx + dx; // tile directly ahead (the brick)
  const ay = cy + dy;
  const bx = ax + dx; // tile beyond (where the brick goes)
  const by = ay + dy;
  if (!inBounds(ax, ay)) return false;
  if (grid[idx(ax, ay)] !== TileKind.PUSH) return false;
  return isOpen(grid, bombs, bx, by);
}

/** Slide the PUSH brick ahead in `dir` one tile over. Caller must have confirmed
 * `canPush` this tick. MUTATES `grid`. */
function applyPush(grid: TileGrid, posX: number, posY: number, dir: number): void {
  const dx = dirDX(dir);
  const dy = dirDY(dir);
  const ax = tileOf(posX) + dx;
  const ay = tileOf(posY) + dy;
  grid[idx(ax, ay)] = TileKind.EMPTY;
  grid[idx(ax + dx, ay + dy)] = TileKind.PUSH;
}

/** Effective per-tick speed in millitiles for a player. */
export function playerSpeedMtPerTick(
  moveSpeedMt: number,
  speedBonusTenths: number,
): number {
  // tenths of a tile/s → millitiles/s is ×100.
  return Math.round((moveSpeedMt + speedBonusTenths * 100) / TICK_HZ);
}

/**
 * Resolve input and move one player for this tick. MUTATES the passed clone
 * (the caller owns it; nothing escapes the tick). Resolution order:
 * 1. update held stack / buffered press from the raw bitflags,
 * 2. try the buffered direction first, then held stack newest→oldest,
 * 3. first direction that produces displacement wins (sets facing; clears
 *    the buffer if it was the buffered direction),
 * 4. age the buffer window.
 * Trapped / eliminated players keep their input bookkeeping but never move.
 */
export function stepPlayerMovement(
  grid: TileGrid,
  bombs: readonly BombState[],
  player: PlayerState,
  input: InputFrame,
  params: SimParams,
): void {
  const pressed = newlyPressedDir(player.prevDir, input.dir);
  player.heldStack = updateHeldStack(player.heldStack, player.prevDir, input.dir);
  if (pressed !== 0) {
    player.bufferedDir = pressed;
    player.bufferedTicks = params.inputBufferTicks;
  }
  player.prevDir = input.dir;

  let charging = false; // did we lean into a crate this tick (keep the charge)?
  if (player.alive && !player.trapped) {
    const speed = playerSpeedMtPerTick(params.moveSpeedMt, player.speedBonusTenths);
    for (const d of resolveTryOrder(
      player.bufferedDir,
      player.bufferedTicks,
      player.heldStack,
    )) {
      const [nx, ny, moved] = stepEntity(
        grid,
        bombs,
        player.posX,
        player.posY,
        d,
        speed,
        params.cornerAssistMt,
      );
      if (moved) {
        player.posX = nx;
        player.posY = ny;
        player.facing = d as Direction;
        if (d === player.bufferedDir) {
          player.bufferedDir = 0;
          player.bufferedTicks = 0;
        }
        break;
      }
      // Movement blocked in `d`: if a pushable brick is dead ahead and the tile
      // beyond is open, lean into it. The crate is heavy — it only slides after
      // the player charges PUSH_CHARGE_TICKS consecutive ticks in this direction;
      // turning or releasing resets the charge. The player holds position but
      // faces the push; clear the buffer just like a move so it doesn't replay.
      if (canPush(grid, bombs, player.posX, player.posY, d)) {
        player.facing = d as Direction;
        charging = true;
        player.pushChargeTicks =
          player.pushChargeDir === d ? player.pushChargeTicks + 1 : 1;
        player.pushChargeDir = d;
        if (player.pushChargeTicks >= PUSH_CHARGE_TICKS) {
          applyPush(grid, player.posX, player.posY, d);
          player.pushChargeTicks = 0;
          player.pushChargeDir = 0;
        }
        if (d === player.bufferedDir) {
          player.bufferedDir = 0;
          player.bufferedTicks = 0;
        }
        break;
      }
    }
  }
  if (!charging) {
    player.pushChargeDir = 0;
    player.pushChargeTicks = 0;
  }

  if (player.bufferedTicks > 0) {
    player.bufferedTicks -= 1;
    if (player.bufferedTicks === 0) player.bufferedDir = 0;
  }
}
