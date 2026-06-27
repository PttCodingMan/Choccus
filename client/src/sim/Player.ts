/**
 * Player state + the shared free-movement helper.
 *
 * Movement model (all integer millitiles) — FREE AABB movement:
 * - Coordinates are millitiles; the entity is a one-tile square body that may
 *   sit off-grid on BOTH axes. There is no "always aligned on one axis"
 *   invariant: in open space you glide freely in any of the four directions.
 * - Collision: moving along an axis, the body stops flush against the first
 *   solid tile (non-walkable OR a bomb) it is not already standing in. A
 *   one-tile-wide corridor therefore fences the body to its centreline by
 *   collision alone — that is geometry, not a "correction". Per-tick speed is
 *   far below half a tile, so at most one tile boundary is crossed per tick;
 *   the just-placed bomb sits on the current tile, so walking off it is free.
 * - Corner-slide (the ONLY assist): when a move is fully blocked AND the body
 *   is off-grid on the perpendicular axis, it slides toward a candidate lane
 *   whose opening ahead is clear to round the corner; leftover speed is then
 *   spent advancing. Two candidate lanes are tried in a FIXED order — the near
 *   lane, then the far lane the body leans into (determinism contract). It needs
 *   a blocking wall, so it never fires during a free open-space glide.
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
 * The FAR perpendicular tile a body centred at `b` overlaps on that axis, given
 * its NEAR (nominal) tile `near = tileOf(b)`: the one neighbour it leans into
 * when off-grid, or `near` itself when perfectly centred. The pair (near, far)
 * is the two perpendicular tiles the body can straddle; returning the far tile
 * as a plain scalar keeps the hot path allocation-free (no [near, far] tuple per
 * call). Callers scan the same fixed shape: near first, then far when distinct.
 */
function perpFar(b: number, near: number): number {
  const off = b - near * MILLITILE;
  return off === 0 ? near : near + (off > 0 ? 1 : -1);
}

/**
 * Whether the one-tile body centred at (posX, posY) overlaps tile (x, y) with
 * POSITIVE area. The body spans [posX±HALF, posY±HALF); on each axis it covers
 * its nominal tile plus, when off-grid, the one neighbour it straddles into —
 * exactly the (near, far) pair `tileOf`/`perpFar` give (overlap there is the
 * off-centre offset, always > 0). This is the AABB footprint used by sudden-death
 * crush: any tile the body touches, not merely its nearest-centre tile. Pure integer.
 */
export function bodyOverlapsTile(
  posX: number,
  posY: number,
  x: number,
  y: number,
): boolean {
  const pxNear = tileOf(posX);
  const pxFar = perpFar(posX, pxNear);
  const pyNear = tileOf(posY);
  const pyFar = perpFar(posY, pyNear);
  return (x === pxNear || x === pxFar) && (y === pyNear || y === pyFar);
}

/**
 * Advance `a` (movement-axis position) by up to `speed` in direction `s` (±1),
 * stopping the one-tile body flush against the first blocking leading-edge tile.
 * `solidAt` = not enterable (a wall OR a bomb); `wallAt` = a wall ONLY (ignores
 * bombs). The leading-edge tile is checked with the right predicate by case:
 *  - a NEW tile is entered (`newFront !== curFront`): block on `solidAt` — you
 *    cannot glide into a fresh wall OR bomb tile ahead;
 *  - no new tile (the leading edge is one the body ALREADY straddles): block only
 *    on `wallAt`. This is what stops a body from gliding DEEPER through a tile
 *    that turned solid mid-match (sudden-death hardening) — yet still lets the
 *    player walk OFF its own just-placed bomb, which sits on a tile it already
 *    occupies (a bomb is not a wall).
 * Per-tick speed < HALF, so at most one new tile is entered. Clamps flush at
 * `newFront`'s near edge (centre one tile back). Returns [newA, blockedTile|null]
 * (the tile that stopped us, for corner-slide).
 */
function advanceAxis(
  solidAt: (at: number, bt: number) => boolean,
  wallAt: (at: number, bt: number) => boolean,
  a: number,
  perpNear: number,
  perpFarTile: number,
  s: number,
  speed: number,
): [number, number | null] {
  const aNew = a + s * speed;
  // Tiles span [T·MILLITILE − HALF, T·MILLITILE + HALF), so the leading-edge
  // tile = the outermost tile the body still occupies on the moving side: for
  // +s the rightmost-occupied tile, for −s the leftmost (the body is one tile
  // wide, so this is one off the body centre's tile).
  const curFront =
    s > 0 ? Math.floor((a + MILLITILE - 1) / MILLITILE) : Math.floor(a / MILLITILE);
  const newFront =
    s > 0 ? Math.floor((aNew + MILLITILE - 1) / MILLITILE) : Math.floor(aNew / MILLITILE);
  // Entering a NEW tile blocks on walls AND bombs; staying within an already-
  // straddled tile blocks only on walls (so you can leave your own bomb tile).
  const blocks = newFront === curFront ? wallAt : solidAt;
  if (
    blocks(newFront, perpNear) ||
    (perpFarTile !== perpNear && blocks(newFront, perpFarTile))
  ) {
    const clamped = s > 0 ? (newFront - 1) * MILLITILE : (newFront + 1) * MILLITILE;
    return [s > 0 ? Math.min(aNew, clamped) : Math.max(aNew, clamped), newFront];
  }
  return [aNew, null];
}

/**
 * Move one tick along axis `a` (perpendicular pos `b`). Free AABB movement: in
 * open space the body slides anywhere (both axes off-grid), corridors fence it
 * to the centreline by collision alone. The ONLY assist is a corner-slide that
 * fires when movement is fully blocked AND the body is off-grid on `b`: it then
 * aligns toward a candidate lane whose opening ahead is clear and rounds the
 * corner. Both candidate lanes are tried in the SAME fixed deterministic order
 * as the old corridor model — the NEAR lane first, then the FAR lane the body
 * leans into — so a body leaning into the far row can still round the corner.
 *
 * `tolMt` is the TIGHTNESS THRESHOLD: a lane only qualifies for corner-assist
 * when the body is within `tolMt` millitiles of that lane's centre. tolMt = 0 ⇒
 * must be essentially aligned (no assist); tolMt = 500 (½ tile) ⇒ assist up to
 * half a tile (the near lane is ≤½ tile away, the far lane ≥½ tile, so only wide
 * tolerances reach the far lane). Smaller = stricter / less forgiving.
 *
 * Corner-cut (no sideways shuffle): the qualifying lane `r` is one the body
 * ALREADY overlaps (the near lane it sits in, or the far lane it leans into), so
 * snapping `b` straight to `r`'s centre in a SINGLE tick moves only TOWARD a tile
 * the footprint already covers — it shrinks/relocates the straddle and enters NO
 * new perpendicular tile, hence is clip-safe at any distance ≤ ½ tile (the gate
 * caps the snap at `tolMt` ≤ 500). After the snap the body is dead-centre on `r`
 * (footprint = just lane `r`, whose opening ahead is verified open), so it then
 * advances forward by the full per-tick `speed` THE SAME TICK via `advanceAxis`
 * (which clamps flush on any wall further ahead). The result is a true diagonal
 * round-the-corner: forward + perpendicular in one tick, never the old multi-tick
 * "drift sideways with zero forward progress" hitch. The forward step is gated on
 * the POST-snap footprint (lane `r` only), so we never advance while still
 * overlapping the blocking wall lane.
 *
 * Because it needs a blocking wall, it never fires in the open. Returns [newA, newB].
 */
function moveAxis(
  solidAt: (at: number, bt: number) => boolean,
  wallAt: (at: number, bt: number) => boolean,
  a: number,
  b: number,
  s: number,
  speed: number,
  tolMt: number,
): [number, number] {
  const near = tileOf(b);
  const far = perpFar(b, near);
  const [a1, blockedTile] = advanceAxis(solidAt, wallAt, a, near, far, s, speed);
  if (a1 !== a) return [a1, b]; // progressed on the movement axis → no slide
  if (blockedTile === null) return [a, b]; // not wall-blocked → no corner-slide
  const off = b - near * MILLITILE;
  if (off === 0) return [a, b]; // dead-centre on `b` → nothing to slide toward
  const lean = off > 0 ? 1 : -1;
  // Fixed candidate order: NEAR lane, then the FAR lane the body leans into.
  // Both are lanes the footprint ALREADY overlaps (near = it sits in, far = it
  // leans into), so snapping toward either never enters a new perpendicular tile.
  for (const r of [near, near + lean] as const) {
    // Tightness gate: the body must be within `tolMt` of lane `r`'s centre for
    // the turn-assist to kick in (smaller = stricter). The far lane's centre is
    // ≥½ tile away, so it only qualifies at wide tolerances.
    if (Math.abs(b - r * MILLITILE) > tolMt) continue;
    // The opening ahead in lane `r` must be clear; the far lane must also be
    // enterable to slide into it (it is one tile off the body's nominal lane).
    if (solidAt(blockedTile, r)) continue;
    if (r !== near && solidAt(blockedTile - s, r)) continue;
    // Snap straight to lane `r`'s centre this tick (clip-safe: moving toward an
    // already-overlapped lane enters no new perpendicular tile — see header).
    const b1 = r * MILLITILE;
    // Now dead-centre on `r`; spend the full per-tick budget advancing forward.
    // advanceAxis checks lane `r` only (post-snap footprint) and clamps flush on
    // any wall further ahead, so the diagonal never tunnels.
    const [a2] = advanceAxis(solidAt, wallAt, a, r, r, s, speed);
    return [a2, b1];
  }
  return [a, b];
}

/**
 * Attempt to move an entity one tick in `dir`. Pure: returns
 * [newPosX, newPosY, moved]. `tolMt` is the corner-assist tightness threshold
 * (millitiles): a lane only qualifies for the turn-assist slide when the body is
 * within `tolMt` of its centre (see `moveAxis`). Smaller = stricter / less
 * forgiving; live-tunable via the ⚙ "Corner assist" slider.
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
    const [nx, ny] = moveAxis(
      (at, bt) => !isOpen(grid, bombs, at, bt), // wall or bomb
      (at, bt) => !isWalkable(grid, at, bt), // wall only (ignore bombs)
      posX,
      posY,
      dx,
      speedMt,
      tolMt,
    );
    return [nx, ny, nx !== posX || ny !== posY];
  }
  const dy = dirDY(dir);
  if (dy !== 0) {
    // axis a = Y, axis b = X → swap the tile args into isOpen / isWalkable(x, y).
    const [ny, nx] = moveAxis(
      (at, bt) => !isOpen(grid, bombs, bt, at),
      (at, bt) => !isWalkable(grid, bt, at),
      posY,
      posX,
      dy,
      speedMt,
      tolMt,
    );
    return [nx, ny, nx !== posX || ny !== posY];
  }
  return [posX, posY, false];
}

/**
 * Try to push a PUSH brick one tile in direction `dir` (the brick directly
 * ahead in the player's lane, tile beyond it open). The brick slides one tile;
 * the player does NOT advance this tick.
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
 * Whether a PUSH brick directly ahead in `dir` could be shoved one tile. Does
 * NOT mutate — the actual shove is gated behind a charge (see stepPlayerMovement)
 * so heavy crates need sustained force. `applyPush` performs the move once the
 * charge is full.
 *
 * Stance under free AABB movement: the player must be squarely in the brick's
 * LANE and flush against it, NOT dead-centre on both axes. Concretely:
 *  - centred on the MOVEMENT axis (flush against the brick — collision clamps the
 *    body to the tile centre directly behind a solid brick), and
 *  - aligned in the brick's lane on the PERPENDICULAR axis: its nearest tile is
 *    the brick's row/column (`tileOf(perp) === brick perp tile`). The perpendicular
 *    coordinate may be off-grid (the player walked in from open space) — requiring
 *    dead-centre there left bricks unpushable forever.
 */
function canPush(
  grid: TileGrid,
  bombs: readonly BombState[],
  posX: number,
  posY: number,
  dir: number,
  players: readonly PlayerState[],
  self: PlayerState,
): boolean {
  const dx = dirDX(dir);
  const dy = dirDY(dir);
  if (dx === 0 && dy === 0) return false;
  // Flush against the brick on the movement axis (collision clamps to a centre).
  if (dx !== 0 && posX % MILLITILE !== 0) return false;
  if (dy !== 0 && posY % MILLITILE !== 0) return false;
  const cx = tileOf(posX); // nearest tile = the lane the body sits squarely in
  const cy = tileOf(posY);
  const ax = cx + dx; // tile directly ahead (the brick)
  const ay = cy + dy;
  const bx = ax + dx; // tile beyond (where the brick goes)
  const by = ay + dy;
  if (!inBounds(ax, ay)) return false;
  if (grid[idx(ax, ay)] !== TileKind.PUSH) return false;
  if (!isOpen(grid, bombs, bx, by)) return false;
  // Don't shove the crate onto a tile another player's body occupies — players
  // aren't in `grid`, so isOpen() misses them and the crate would slide through.
  for (const p of players) {
    if (p !== self && p.alive && bodyOverlapsTile(p.posX, p.posY, bx, by)) return false;
  }
  return true;
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
  players: readonly PlayerState[] = [],
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
      if (canPush(grid, bombs, player.posX, player.posY, d, players, player)) {
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
