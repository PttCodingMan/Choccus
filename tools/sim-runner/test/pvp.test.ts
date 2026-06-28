/**
 * PvP (team) mode + determinism guards.
 *
 * Everything new is config-gated so the legacy (opts-omitted) path stays
 * byte-identical to M1 co-op. These tests assert both the new PvP behavior
 * (team-isolated rescue, last-team-standing win) and that the deterministic
 * core (state hash, tick-sequence hashes) is completely unchanged when opts
 * is omitted. The crafted-state technique mirrors behavior.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { MILLITILE, TRAPPED_TICKS } from '../../../shared/constants';
import { Direction, GamePhase, TileKind } from '../../../shared/types';
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

describe('single-team match (solo practice vs 0 bots)', () => {
  it('does NOT end the instant it starts — stays PLAYING with one team', () => {
    // 1 player = 1 team: no last-team-standing contest, so it must not OVER at
    // tick 1 (the 0-bot solo restart-loop bug). Runs until the team is gone.
    let st: SimState = createInitialState(2468, fp, 1, { pvp: true });
    expect(st.players.length).toBe(1);
    for (let t = 0; t < 30; t++) st = tick(st, [IDLE]);
    expect(st.phase).toBe(GamePhase.PLAYING);
  });

  it('a >=2-team match still ends at last team standing (rule unchanged)', () => {
    const base = createInitialState(99, fp, 2, { pvp: true, teams: [0, 1] });
    const players = base.players.map(clonePlayer);
    players[1]!.alive = false; // team 1 wiped → team 0 is the last standing
    let st: SimState = { ...base, players };
    st = tick(st, [IDLE, IDLE]);
    expect(st.phase).toBe(GamePhase.OVER);
  });
});

describe('non-PvP default sanity', () => {
  it('omitting opts defaults team = slot, pvp false', () => {
    const s0 = createInitialState(12345, fp, 2);
    expect(s0.params.pvp).toBe(false);
    s0.players.forEach((p, i) => expect(p.team).toBe(i));
  });

  it('same-team players: one rescues the other (parked opponent keeps match live)', () => {
    // 3 players: P0 + P1 on team 0 (rescue is same-team only), P2 on team 1
    // parked far away so the match stays PLAYING during the rescue window.
    const base = createInitialState(777, fp, 3, { teams: [0, 0, 1] });
    const map = new Uint8Array(base.map);
    const players = base.players.map(clonePlayer);
    players[0]!.posX = 1 * MILLITILE; // trapped at (1,1)
    players[0]!.posY = 1 * MILLITILE;
    players[0]!.trapped = true;
    players[0]!.trappedTicks = TRAPPED_TICKS;
    players[1]!.posX = 3 * MILLITILE; // walk in from (3,1)
    players[1]!.posY = 1 * MILLITILE;
    // Clear the lane explicitly — independent of the map's authored spawn layout.
    map[idx(1, 1)] = TileKind.EMPTY;
    map[idx(2, 1)] = TileKind.EMPTY;
    map[idx(3, 1)] = TileKind.EMPTY;
    let st: SimState = { ...base, map, players };

    const LEFT: InputFrame = { dir: Direction.LEFT, action: 0 };
    let rescuedAt = -1;
    for (let t = 0; t < 60 && rescuedAt < 0; t++) {
      st = tick(st, [IDLE, LEFT, IDLE]);
      if (!st.players[0]!.trapped) rescuedAt = st.tick;
    }
    expect(rescuedAt).toBeGreaterThan(0);
    expect(rescuedAt).toBeLessThan(TRAPPED_TICKS);
    expect(st.players[0]!.alive).toBe(true);
  });
});

describe('opposing teams', () => {
  it('two opposing teams both alive → match keeps PLAYING', () => {
    let st = createInitialState(54321, fp, 2, {
      pvp: true,
      teams: [0, 1],
    });
    expect(st.params.pvp).toBe(true);
    // Both teams still alive → PLAYING after a few ticks.
    for (let t = 0; t < 10; t++) st = tick(st, [IDLE, IDLE]);
    expect(st.phase).toBe(GamePhase.PLAYING);
    expect(st.players[0]!.alive).toBe(true);
    expect(st.players[1]!.alive).toBe(true);
  });
});

/**
 * PvP crafted base: two players on opposing teams. We then overwrite
 * map/players to stage a trap.
 */
function pvpCrafted(
  mutate: (draft: { map: Uint8Array; players: ReturnType<typeof clonePlayer>[] }) => void,
): SimState {
  const base = createInitialState(777, fp, 2, {
    pvp: true,
    teams: [0, 1],
  });
  const map = new Uint8Array(base.map);
  const players = base.players.map(clonePlayer);
  mutate({ map, players });
  return { ...base, map, players };
}

describe('PvP enemy contact', () => {
  it('an enemy-team toucher instantly breaks the shell (KO well before timeout)', () => {
    let st = pvpCrafted(({ map, players }) => {
      players[1]!.trapped = true; // team 1 trapped at (1,1)
      players[1]!.trappedTicks = TRAPPED_TICKS;
      players[1]!.posX = 1 * MILLITILE;
      players[1]!.posY = 1 * MILLITILE;
      players[0]!.posX = 3 * MILLITILE; // team 0 walks in from (3,1)
      players[0]!.posY = 1 * MILLITILE;
      // Clear the lane explicitly — independent of the map's authored spawn layout.
      map[idx(1, 1)] = TileKind.EMPTY;
      map[idx(2, 1)] = TileKind.EMPTY;
      map[idx(3, 1)] = TileKind.EMPTY;
    });
    const LEFT: InputFrame = { dir: Direction.LEFT, action: 0 };
    let koAt = -1;
    for (let t = 0; t < TRAPPED_TICKS - 1 && koAt < 0; t++) {
      st = tick(st, [LEFT, IDLE]);
      if (!st.players[1]!.alive) koAt = st.tick;
    }
    expect(koAt).toBeGreaterThan(0);
    expect(koAt).toBeLessThan(TRAPPED_TICKS); // killed on contact, not by timeout
    expect(st.players[1]!.trapped).toBe(false);
    expect(st.players[1]!.alive).toBe(false); // shell broken by the enemy
  });
});

describe('PvP rescue priority', () => {
  it('same-team rescue still works and beats a co-located enemy killer', () => {
    // P0 (team 0, trapped) at (1,1); P1 (team 0 ally rescuer) and
    // P2 (team 1 enemy killer) both staged inside contact range the same tick.
    const base = createInitialState(777, fp, 3, { pvp: true, teams: [0, 0, 1] });
    const map = new Uint8Array(base.map);
    const players = base.players.map(clonePlayer);
    players[0]!.trapped = true;
    players[0]!.trappedTicks = TRAPPED_TICKS;
    players[0]!.posX = 1 * MILLITILE;
    players[0]!.posY = 1 * MILLITILE;
    players[1]!.posX = 1 * MILLITILE; // ally rescuer co-located
    players[1]!.posY = 1 * MILLITILE;
    players[2]!.posX = 1 * MILLITILE; // enemy killer co-located
    players[2]!.posY = 1 * MILLITILE;
    let st: SimState = { ...base, map, players };

    st = tick(st, [IDLE, IDLE, IDLE]);
    // Rescue wins the tie: freed, not eliminated.
    expect(st.players[0]!.trapped).toBe(false);
    expect(st.players[0]!.alive).toBe(true);
  });
});

describe('PvP win condition (1v1)', () => {
  it('OVER once only one team has an alive player', () => {
    let st = pvpCrafted(({ players }) => {
      // players[1] (team 1) trapped at its own spawn corner; players[0]
      // (team 0) stays at the opposite spawn corner — far out of contact
      // range, so no rescue AND no enemy KO: it must time out.
      players[1]!.trapped = true;
      players[1]!.trappedTicks = TRAPPED_TICKS;
    });
    for (let t = 0; t < TRAPPED_TICKS - 1; t++) {
      st = tick(st, [IDLE, IDLE]);
      expect(st.phase).toBe(GamePhase.PLAYING);
    }
    st = tick(st, [IDLE, IDLE]);
    expect(st.players[1]!.alive).toBe(false);
    expect(st.players[0]!.alive).toBe(true);
    expect(st.phase).toBe(GamePhase.OVER); // only team 0 remains
  });
});

describe('determinism: no hash drift when opts omitted', () => {
  it('same seed → same initial hash', () => {
    const a = createInitialState(12345, fp, 2);
    const b = createInitialState(12345, fp, 2);
    expect(a.stateHash).toBe(b.stateHash);
  });

  it('pinned initial hashes (guards against silent hash drift)', () => {
    expect(createInitialState(12345, fp, 2).stateHash).toBe(3300603039);
    expect(createInitialState(777, fp, 2).stateHash).toBe(2655113524);
  });

  it('idle tick-hash sequence is self-consistent across runs', () => {
    const run = (): number[] => {
      let st = createInitialState(12345, fp, 2);
      const hashes: number[] = [];
      for (let t = 0; t < 30; t++) {
        st = tick(st, [IDLE, IDLE]);
        hashes.push(st.stateHash);
      }
      return hashes;
    };
    expect(run()).toEqual(run());
  });
});
