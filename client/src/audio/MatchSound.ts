/**
 * MatchSound: state-diff driver that fires SFX by comparing the previous and
 * next SimState each frame.
 *
 * Events detected (one-shot per relevant state change):
 *   - New bomb appeared → sfx.place()
 *   - New explosion cell appeared (fires ONCE per frame regardless of how many
 *     new cells, i.e. one whoomph per detonation wave) → sfx.explode()
 *   - Player trapped went false → true → sfx.trap()
 *   - Player trapped went true → false while alive → sfx.rescue()
 *   - Item count dropped (pickup) → sfx.item()
 *   - Player alive went true → false → sfx.eliminate()
 *   - Phase became OVER: any human player alive → sfx.win(), else → sfx.lose()
 *
 * Double-firing prevention: win/lose and per-player eliminate/trap/rescue
 * events are tracked by a Set keyed by (slot, event) so they fire at most
 * once per match. The tracking is reset when a new game starts (detected by
 * the tick counter going backwards or to 0).
 */
import { GamePhase } from '../../../shared/types';
import type { SimState } from '../sim/Sim';
import { sfx } from './Sfx';

export class MatchSound {
  private firedOnce = new Set<string>();
  private lastTick = -1;

  /** Call this once per rendered frame, before the new state is displayed. */
  tick(prev: SimState, next: SimState): void {
    // Detect game reset: tick went backwards or restarted from 0.
    if (next.tick <= this.lastTick || next.tick === 0) {
      this.firedOnce.clear();
    }
    this.lastTick = next.tick;

    // Only process if there was actually a state change this frame.
    if (prev.tick === next.tick) return;

    this.checkBombs(prev, next);
    this.checkExplosions(prev, next);
    this.checkPlayers(prev, next);
    this.checkItems(prev, next);
    this.checkPhase(prev, next);
  }

  // ---------------------------------------------------------------------------
  // Private checks
  // ---------------------------------------------------------------------------

  private checkBombs(prev: SimState, next: SimState): void {
    // New bombs are those on tiles not present in prev.bombs.
    const prevKeys = new Set(
      prev.bombs.map((b) => `${b.tileX},${b.tileY}`),
    );
    for (const b of next.bombs) {
      if (!prevKeys.has(`${b.tileX},${b.tileY}`)) {
        sfx.place();
        break; // one sound per tick even if multiple bombs were placed
      }
    }
  }

  private checkExplosions(prev: SimState, next: SimState): void {
    // Fire once if ANY new explosion cell appeared this tick.
    const prevKeys = new Set(
      prev.explosions.map((e) => `${e.tileX},${e.tileY}`),
    );
    for (const e of next.explosions) {
      if (!prevKeys.has(`${e.tileX},${e.tileY}`)) {
        sfx.explode();
        return; // one whoomph per frame
      }
    }
  }

  private checkPlayers(prev: SimState, next: SimState): void {
    for (const np of next.players) {
      const pp = prev.players.find((p) => p.slot === np.slot);
      if (pp === undefined) continue;

      const trapKey = `trap:${np.slot}`;
      const rescueKey = `rescue:${np.slot}`;
      const elimKey = `elim:${np.slot}`;

      // Trapped: false → true
      if (!pp.trapped && np.trapped && !this.firedOnce.has(trapKey)) {
        this.firedOnce.add(trapKey);
        // Allow trap to fire again after a rescue (delete rescue key).
        this.firedOnce.delete(rescueKey);
        sfx.trap();
      }

      // Rescued: trapped→false while still alive
      if (pp.trapped && !np.trapped && np.alive && !this.firedOnce.has(rescueKey)) {
        this.firedOnce.add(rescueKey);
        // Allow trap to fire again next time.
        this.firedOnce.delete(trapKey);
        sfx.rescue();
      }

      // Eliminated: alive → false
      if (pp.alive && !np.alive && !this.firedOnce.has(elimKey)) {
        this.firedOnce.add(elimKey);
        sfx.eliminate();
      }
    }
  }

  private checkItems(prev: SimState, next: SimState): void {
    // Item count dropped = at least one item was picked up.
    if (next.items.length < prev.items.length) {
      sfx.item();
    }
  }

  private checkPhase(prev: SimState, next: SimState): void {
    if (prev.phase !== GamePhase.OVER && next.phase === GamePhase.OVER) {
      const overKey = 'phase:over';
      if (!this.firedOnce.has(overKey)) {
        this.firedOnce.add(overKey);
        const anyAlive = next.players.some((p) => p.alive);
        if (anyAlive) {
          sfx.win();
        } else {
          sfx.lose();
        }
      }
    }
  }
}

/** Singleton matchSound driver — import and call tick() each frame. */
export const matchSound = new MatchSound();
