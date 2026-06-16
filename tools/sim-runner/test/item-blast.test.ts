/**
 * Item-vs-blast interaction (Sim.ts tick step 3).
 *
 * Rule under test: a *new* detonation this tick destroys items already lying
 * on the floor whose tile is covered by one of the new explosion cells — BUT
 * the items that just dropped THIS tick (from the very bricks this blast broke)
 * are NOT burned by that same blast. Semantically: the first bomb reveals an
 * item, a later (second) bomb burns it.
 *
 * Crafted-state technique mirrors pvp.test.ts / behavior.test.ts: we build a
 * clean vertical corridor with a single SOFT brick, drop a bomb directly into
 * the bombs array with fuseTicks = 1 (detonates next tick), and drive idle
 * inputs. Seed 0 + this layout deterministically drops an item at (1,3).
 */
import { describe, expect, it } from 'vitest';

import { MILLITILE, SPARK_TICKS } from '../../../shared/constants';
import { TileKind } from '../../../shared/types';
import { makeFeelParams } from '../../../client/src/config/FeelParams';
import { NO_INPUT, type InputFrame } from '../../../client/src/sim/InputBuffer';
import { idx } from '../../../client/src/sim/Map';
import { clonePlayer } from '../../../client/src/sim/Player';
import {
  type SimState,
  createInitialState,
  tick,
} from '../../../client/src/sim/Sim';

const fp = makeFeelParams();
const IDLE: InputFrame = NO_INPUT;

/**
 * Crafted base: 2 opposing players parked far in the lower-right so they
 * neither pick up nor get trapped by the explosions we stage in the upper-left
 * corridor. A clean vertical corridor (1,1)-(1,2) with a SOFT brick at (1,3).
 * A bomb (fire 3) sits on (1,1) with fuseTicks = 1, so it melts NEXT tick and
 * its DOWN arm reaches the brick at (1,3). With seed 0 this drops one item on
 * the cleared brick tile (1,3).
 */
function stageCorridor(): SimState {
  const base = createInitialState(0, fp, 2, { pvp: true, teams: [0, 1] });
  const map = new Uint8Array(base.map);
  const players = base.players.map(clonePlayer);
  map[idx(1, 1)] = TileKind.EMPTY;
  map[idx(1, 2)] = TileKind.EMPTY;
  map[idx(1, 3)] = TileKind.SOFT;
  // Park both players out of the corridor and out of contact range.
  players[0]!.posX = 11 * MILLITILE;
  players[0]!.posY = 11 * MILLITILE;
  players[1]!.posX = 13 * MILLITILE;
  players[1]!.posY = 11 * MILLITILE;
  const bombs = [{ ownerSlot: 0, tileX: 1, tileY: 1, fuseTicks: 1, fire: 3 }];
  return { ...base, map, players, bombs };
}

const itemAt = (st: SimState, x: number, y: number): boolean =>
  st.items.some((it) => it.tileX === x && it.tileY === y);

describe('item vs blast: reveal then burn', () => {
  it('the blast that reveals an item never burns its own freshly-dropped item', () => {
    let st = stageCorridor();
    // Tick where the bomb detonates: brick (1,3) breaks and drops an item.
    st = tick(st, [IDLE, IDLE]);
    expect(itemAt(st, 1, 3)).toBe(true);

    // The item must survive the ENTIRE spark window (residual flames persist
    // SPARK_TICKS ticks). It is the first blast's own drop, so its own cells
    // must not destroy it.
    for (let t = 0; t < SPARK_TICKS + 1; t++) {
      expect(itemAt(st, 1, 3)).toBe(true);
      st = tick(st, [IDLE, IDLE]);
    }
    // Flames have fully aged out; the revealed item is still on the floor.
    expect(st.explosions.length).toBe(0);
    expect(itemAt(st, 1, 3)).toBe(true);
  });

  it('a second, later detonation over the item tile destroys it', () => {
    let st = stageCorridor();
    // First blast reveals the item at (1,3) on the now-cleared (EMPTY) tile.
    st = tick(st, [IDLE, IDLE]);
    expect(itemAt(st, 1, 3)).toBe(true);

    // Stage a SECOND bomb at (1,1): the brick at (1,3) is gone, so its DOWN
    // arm now flows through and covers (1,3) directly.
    const map = new Uint8Array(st.map);
    const players = st.players.map(clonePlayer);
    st = {
      ...st,
      map,
      players,
      bombs: [{ ownerSlot: 0, tileX: 1, tileY: 1, fuseTicks: 1, fire: 3 }],
    };
    expect(itemAt(st, 1, 3)).toBe(true); // still there right before the 2nd blast

    // Detonate the second bomb: its new cells cover (1,3) → item burned.
    st = tick(st, [IDLE, IDLE]);
    expect(itemAt(st, 1, 3)).toBe(false);
  });
});
