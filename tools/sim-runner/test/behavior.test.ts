/**
 * Behavioral spot-asserts — the semantics the hash logs can't explain.
 * Folds in the M1a smoke checks (tools/sim-smoke, now retired) and adds
 * trap/rescue timing guards plus fixture-level semantic checks.
 */
import { describe, expect, it } from 'vitest';

import {
  FUSE_TICKS,
  MAP_COLS,
  MAP_ROWS,
  MILLITILE,
  SPARK_TICKS,
  TRAPPED_TICKS,
} from '../../../shared/constants';
import {
  ActionFlags,
  Direction,
  GamePhase,
  TileKind,
} from '../../../shared/types';
import { makeFeelParams } from '../../../client/src/config/FeelParams';
import { NO_INPUT, type InputFrame } from '../../../client/src/sim/InputBuffer';
import { idx } from '../../../client/src/sim/Map';
import { type PlayerState, clonePlayer } from '../../../client/src/sim/Player';
import {
  type SimState,
  createInitialState,
  tick,
} from '../../../client/src/sim/Sim';
import { fixturePath } from '../src/golden';
import { loadReplayFile, runReplay } from '../src/replay';

const fp = makeFeelParams();
const IDLE: InputFrame = NO_INPUT;

describe('initial state + movement (ex-smoke)', () => {
  it('creates a spec-shaped initial state', () => {
    const s0 = createInitialState(12345, fp, 2);
    expect(s0.tick).toBe(0);
    expect(s0.phase).toBe(GamePhase.PLAYING);
    expect(s0.map.length).toBe(MAP_COLS * MAP_ROWS);
    expect(s0.players.length).toBe(2);
    expect(s0.stateHash).not.toBe(0);
  });

  it('tick() is pure and advances tick; holding RIGHT moves player 0 right', () => {
    const s0 = createInitialState(12345, fp, 2);
    const s1 = tick(s0, [IDLE, IDLE]);
    expect(s1.tick).toBe(1);
    expect(s0.tick).toBe(0); // input state untouched
    let sm: SimState = s0;
    for (let i = 0; i < 10; i++) {
      sm = tick(sm, [{ dir: Direction.RIGHT, action: 0 }, IDLE]);
    }
    expect(sm.players[0]!.posX).toBeGreaterThan(s0.players[0]!.posX);
  });
});

/** Seed whose map has a SOFT brick at (3,1) — within fire-2 reach of (1,1). */
function softAt31Seed(): number {
  for (let s = 1; s < 10000; s++) {
    const st = createInitialState(s, fp, 1);
    if (st.map[idx(3, 1)] === TileKind.SOFT) return s;
  }
  throw new Error('no seed with SOFT at (3,1) found');
}

describe('bomb fuse / melt-flow (ex-smoke)', () => {
  it('detonates exactly FUSE_TICKS after placement, destroys the soft brick, traps the standing player, and sparks last <= SPARK_TICKS', () => {
    const seed = softAt31Seed();
    // 2 players on opposing teams (engine default). P0 bombs + self-traps; P1
    // idles in the far corner so the match stays PLAYING throughout (a lone
    // surviving team would otherwise end the match immediately).
    let st = createInitialState(seed, fp, 2);
    const P1_IDLE: InputFrame = IDLE;
    const countSoft = (m: Uint8Array): number => {
      let n = 0;
      for (const t of m) if (t === TileKind.SOFT) n += 1;
      return n;
    };
    const softBefore = countSoft(st.map as Uint8Array);

    st = tick(st, [{ dir: 0, action: ActionFlags.BOMB }, P1_IDLE]); // place during tick 0→1
    expect(st.bombs.length).toBe(1);
    expect(st.players[0]!.activeBombs).toBe(1);
    // fuse decremented once on the placement tick (placement step 2, fuses step 3)
    expect(st.bombs[0]!.fuseTicks).toBe(FUSE_TICKS - 1);

    let explodeTick = -1;
    while (st.tick < FUSE_TICKS + 5 && explodeTick < 0) {
      st = tick(st, [IDLE, P1_IDLE]);
      if (st.explosions.length > 0) explodeTick = st.tick;
      else if (st.tick < FUSE_TICKS) expect(st.bombs.length).toBe(1);
    }
    expect(explodeTick).toBe(FUSE_TICKS);
    expect(st.bombs.length).toBe(0);
    expect(st.players[0]!.activeBombs).toBe(0);
    expect(st.map[idx(3, 1)]).toBe(TileKind.EMPTY);
    expect(countSoft(st.map as Uint8Array)).toBeLessThan(softBefore);
    expect(st.players[0]!.trapped).toBe(true); // stood in own melt-flow

    let sparkGoneTick = -1;
    while (st.tick < explodeTick + SPARK_TICKS + 5) {
      st = tick(st, [IDLE, P1_IDLE]);
      if (st.explosions.length === 0) {
        sparkGoneTick = st.tick;
        break;
      }
    }
    expect(sparkGoneTick).toBeGreaterThan(explodeTick);
    expect(sparkGoneTick).toBeLessThanOrEqual(explodeTick + SPARK_TICKS);
  });
});

/**
 * Craft a controlled state: SimState is plain data and tick() is pure, so
 * tests may assemble exact scenarios. Defaults to 2 players on opposing teams
 * (the engine default: team = slot). Pass numPlayers/teams to stage co-op
 * scenarios with a parked opponent that keeps the match alive.
 */
function craftedState(
  mutate: (draft: { map: Uint8Array; players: PlayerState[] }) => void,
  numPlayers = 2,
  teams?: number[],
): SimState {
  const base = createInitialState(777, fp, numPlayers, teams ? { teams } : undefined);
  const map = new Uint8Array(base.map);
  const players = base.players.map(clonePlayer);
  mutate({ map, players });
  return { ...base, map, players };
}

describe('sugar shell (trap) timing', () => {
  it('trapped lasts exactly TRAPPED_TICKS without rescue, then eliminates', () => {
    // P0 (team 0) is trapped with no same-team rescuer; P1 (team 1) stays alive
    // but parked far away so the match keeps PLAYING during the countdown
    // (cross-team players can never rescue). Default teams are slot-indexed.
    let st = craftedState(({ players }) => {
      players[0]!.trapped = true;
      players[0]!.trappedTicks = TRAPPED_TICKS;
      players[1]!.posX = (MAP_COLS - 2) * MILLITILE; // far opposing corner
      players[1]!.posY = (MAP_ROWS - 2) * MILLITILE;
    });
    expect(st.players[0]!.team).not.toBe(st.players[1]!.team);
    for (let t = 0; t < TRAPPED_TICKS - 1; t++) st = tick(st, [IDLE, IDLE]);
    expect(st.players[0]!.trapped).toBe(true);
    expect(st.players[0]!.alive).toBe(true);
    expect(st.phase).toBe(GamePhase.PLAYING); // both teams still alive
    st = tick(st, [IDLE, IDLE]);
    expect(st.players[0]!.trapped).toBe(false);
    expect(st.players[0]!.alive).toBe(false);
    expect(st.phase).toBe(GamePhase.OVER); // only team 1 left alive
  });

  it('a teammate touching the shell rescues: trap cleared, player stays alive', () => {
    // P0 + P1 are the same team here (rescue is same-team only). P2 (team 1)
    // is a parked opponent keeping the match PLAYING during the rescue window.
    let st = craftedState(
      ({ map, players }) => {
        players[0]!.trapped = true;
        players[0]!.trappedTicks = TRAPPED_TICKS;
        players[1]!.posX = 3 * MILLITILE; // walk in from (3,1)
        players[1]!.posY = 1 * MILLITILE;
        map[idx(3, 1)] = TileKind.EMPTY;
      },
      3,
      [0, 0, 1],
    );
    const LEFT: InputFrame = { dir: Direction.LEFT, action: 0 };
    let rescuedAt = -1;
    for (let t = 0; t < 60 && rescuedAt < 0; t++) {
      st = tick(st, [IDLE, LEFT, IDLE]);
      if (!st.players[0]!.trapped) rescuedAt = st.tick;
    }
    expect(rescuedAt).toBeGreaterThan(0);
    expect(rescuedAt).toBeLessThan(TRAPPED_TICKS);
    expect(st.players[0]!.alive).toBe(true);
    expect(st.players[0]!.trappedTicks).toBe(0);
  });
});

describe('fixture-level semantics', () => {
  it('trap-rescue fixture: P0 gets trapped, then rescued before the timeout', () => {
    const replay = loadReplayFile(fixturePath('trap-rescue'));
    const states: SimState[] = [];
    runReplay(replay, (s) => states.push(s));
    const firstTrapped = states.findIndex((s) => s.players[0]!.trapped);
    expect(firstTrapped).toBeGreaterThanOrEqual(0);
    const rescued = states.findIndex(
      (s, i) => i > firstTrapped && !s.players[0]!.trapped && s.players[0]!.alive,
    );
    expect(rescued).toBeGreaterThan(firstTrapped);
    expect(rescued - firstTrapped).toBeLessThan(TRAPPED_TICKS);
  });

  it('chain fixture: two bombs detonate on the same tick (chain reaction)', () => {
    const replay = loadReplayFile(fixturePath('chain'));
    const states: SimState[] = [];
    runReplay(replay, (s) => states.push(s));
    let chained = false;
    for (let t = 1; t < states.length && !chained; t++) {
      const before = states[t - 1]!.bombs;
      chained =
        before.length >= 2 &&
        states[t]!.bombs.length === 0 &&
        before.some((b) => b.fuseTicks > 1);
    }
    expect(chained).toBe(true);
  });
});
