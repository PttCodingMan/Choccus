/**
 * Sugar shell (trap) logic.
 *
 * DESIGN DECISION (deviation from the original plan): there is NO separate
 * `shells[]` array in SimState. A shell has no identity beyond "this player
 * is trapped", so the trap state is folded into PlayerState
 * (`trapped` + `trappedTicks`) — fewer arrays to keep in sync, fewer desync
 * surfaces. The renderer can derive shell visuals from trapped players.
 *
 * Rules (spec):
 * - melt-flow hit → player is sealed in a shell for TRAPPED_TICKS (5 s);
 * - a non-trapped, alive same-team teammate touching the shell (within
 *   ~0.5 tile) rescues: trap cleared. Only same-team players can rescue.
 *   Teams default to the player's slot (team = slot), so in a solo run a human
 *   and the AI bots are all on different teams and never rescue each other;
 *   explicit teams (opts.teams) put allies together.
 * - a non-trapped, alive enemy-team player touching the shell (within ~0.5
 *   tile) instantly breaks it → the trapped player is eliminated. Rescue takes
 *   priority: if a same-team rescuer is also in reach this tick, the trapped
 *   player is freed instead of being killed.
 * - timeout (no one touches) → shell breaks, player eliminated (alive = false).
 */
import { MILLITILE, TRAPPED_TICKS } from '../../../shared/constants';
import { type PlayerState, tileOf } from './Player';

/** Rescue reach: touching = within half a tile (millitiles). */
export const RESCUE_DIST_MT = MILLITILE / 2;

/** Squared-integer distance check between two entity positions. */
export function withinDistMt(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  distMt: number,
): boolean {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy <= distMt * distMt;
}

/** Seal a player in a sugar shell (snaps to tile center). MUTATES the clone. */
export function trapPlayer(player: PlayerState): void {
  if (!player.alive || player.trapped) return;
  player.trapped = true;
  player.trappedTicks = TRAPPED_TICKS;
  player.posX = tileOf(player.posX) * MILLITILE;
  player.posY = tileOf(player.posY) * MILLITILE;
}

/** Break the shell: player eliminated. MUTATES the clone. */
export function breakShell(player: PlayerState): void {
  player.trapped = false;
  player.trappedTicks = 0;
  player.alive = false;
}

/**
 * Per-tick shell pass, in player-array order: (a) contact resolution — for
 * each trapped player, a same-team toucher rescues (trap cleared, rescue wins
 * ties), otherwise an enemy-team toucher instantly breaks the shell
 * (eliminated); then (b) age the remaining shells, breaking (eliminating) at 0.
 * MUTATES the clones.
 */
export function stepShells(players: PlayerState[]): void {
  for (const p of players) {
    if (!p.alive || !p.trapped) continue;
    // PHASE A1 — same-team rescue (priority over enemy KO).
    let rescued = false;
    for (const q of players) {
      if (q === p || !q.alive || q.trapped) continue;
      if (q.team !== p.team) continue;
      if (withinDistMt(p.posX, p.posY, q.posX, q.posY, RESCUE_DIST_MT)) {
        p.trapped = false;
        p.trappedTicks = 0;
        rescued = true;
        break;
      }
    }
    if (rescued) continue;
    // PHASE A2 — enemy-team contact: instant shell break (elimination).
    for (const q of players) {
      if (q === p || !q.alive || q.trapped) continue;
      if (q.team === p.team) continue;
      if (withinDistMt(p.posX, p.posY, q.posX, q.posY, RESCUE_DIST_MT)) {
        breakShell(p);
        break;
      }
    }
  }
  for (const p of players) {
    if (!p.alive || !p.trapped) continue;
    p.trappedTicks -= 1;
    if (p.trappedTicks <= 0) breakShell(p);
  }
}
