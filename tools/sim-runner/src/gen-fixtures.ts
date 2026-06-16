/**
 * Fixture author: scripts representative matches with the closed-loop bot
 * (src/bot.ts), records the inputs as sparse event lists, validates the
 * resulting behavior, and writes plain open-loop replay JSONs to fixtures/.
 *
 * Fully reproducible: seed searches are fixed ascending scans and every
 * random choice comes from the sim's own Mulberry32 helpers with fixed seeds.
 * Re-running this script regenerates byte-identical fixtures.
 *
 *   npm run gen-fixtures
 *
 * After regenerating fixtures you MUST also run `npm run update-golden`.
 */
import { writeFileSync } from 'node:fs';

import { MAP_COLS, TRAPPED_TICKS } from '../../../shared/constants';
import { GamePhase, TileKind } from '../../../shared/types';
import { makeFeelParams } from '../../../client/src/config/FeelParams';
import { NO_INPUT, type InputFrame } from '../../../client/src/sim/InputBuffer';
import { idx } from '../../../client/src/sim/Map';
import {
  type SimState,
  createInitialState,
  tick,
} from '../../../client/src/sim/Sim';
import {
  type BotCtx,
  type Script,
  GenFail,
  clearPathTo,
  findNearestSafe,
  goTo,
  pressBomb,
  rampage,
  wander,
  waitUntil,
} from './bot';
import { fixturePath } from './golden';
import {
  type Replay,
  type ReplayInputEvent,
  hashHex,
  replayToJson,
  runReplay,
} from './replay';

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

interface RecordOpts {
  seed: number;
  numPlayers: number;
  /** Team per slot (optional). Default: team = slot index. */
  teams?: number[];
  /** Hard cap on scripted ticks (GenFail when scripts run longer). */
  maxTicks: number;
  /** Extra NO_INPUT ticks appended after all scripts finish. */
  tail?: number;
  scripts: (ctx: BotCtx) => Script[];
}

interface RecordResult {
  events: ReplayInputEvent[];
  ticks: number;
  /** states[t] = state after t tick() calls (states[0] = initial). */
  states: SimState[];
}

function record(opts: RecordOpts): RecordResult {
  const feel = makeFeelParams();
  let state = createInitialState(
    opts.seed >>> 0,
    feel,
    opts.numPlayers,
    opts.teams !== undefined ? { teams: opts.teams } : undefined,
  );
  const pending: InputFrame[] = [];
  const ctx: BotCtx = {
    state,
    setInput(slot, dir = 0, action = 0) {
      pending[slot] = { dir, action };
    },
  };
  let running = opts.scripts(ctx);
  const events: ReplayInputEvent[] = [];
  const last: InputFrame[] = [];
  for (let s = 0; s < opts.numPlayers; s++) last.push({ ...NO_INPUT });
  const states: SimState[] = [state];
  const tail = opts.tail ?? 0;

  let doneAt: number | null = running.length === 0 ? 0 : null;
  for (let t = 0; ; t++) {
    if (doneAt !== null && t >= doneAt + tail) {
      return { events, ticks: t, states };
    }
    if (doneAt === null && t >= opts.maxTicks) {
      throw new GenFail(`scripts still running after maxTicks=${opts.maxTicks}`);
    }
    for (let s = 0; s < opts.numPlayers; s++) pending[s] = { ...NO_INPUT };
    if (doneAt === null) {
      running = running.filter((g) => !g.next().done);
      if (running.length === 0) doneAt = t + 1;
    }
    for (let s = 0; s < opts.numPlayers; s++) {
      const cur = pending[s]!;
      const prev = last[s]!;
      if (cur.dir !== prev.dir || cur.action !== prev.action) {
        events.push({ tick: t, slot: s, dir: cur.dir, action: cur.action });
        last[s] = cur;
      }
    }
    state = tick(state, pending);
    ctx.state = state;
    states.push(state);
  }
}

/** Ascending seed scan: precheck on the initial state, then full generation. */
function searchSeed(
  baseSeed: number,
  maxTries: number,
  precheck: (initial: SimState) => boolean,
  attempt: (seed: number) => RecordResult,
): { seed: number; result: RecordResult } {
  const feel = makeFeelParams();
  for (let i = 0; i < maxTries; i++) {
    const seed = baseSeed + i;
    // precheck peeks at the would-be initial state cheaply.
    const numPlayersForPeek = 2; // precheckers only inspect the map
    const initial = createInitialState(seed >>> 0, feel, numPlayersForPeek);
    if (!precheck(initial)) continue;
    try {
      return { seed, result: attempt(seed) };
    } catch (e) {
      if (e instanceof GenFail) continue;
      throw e;
    }
  }
  throw new Error(`seed search exhausted (${maxTries} tries from ${baseSeed})`);
}

// ---------------------------------------------------------------------------
// Prechecks
// ---------------------------------------------------------------------------

/** Number of SOFT bricks on row 1 strictly between the two top corners. */
function row1Softs(state: SimState): number {
  let n = 0;
  for (let x = 2; x <= MAP_COLS - 3; x++) {
    if (state.map[idx(x, 1)] === TileKind.SOFT) n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Fixture definitions
// ---------------------------------------------------------------------------

interface Built {
  replay: Replay;
  states: SimState[];
}

function buildIdle(): Built {
  const replay: Replay = {
    name: 'idle',
    description:
      '2 players (opposing teams), no inputs, 600 ticks — exercises map generation PRNG only.',
    seed: 101,
    numPlayers: 2,
    ticks: 600,
    inputs: [],
  };
  const states: SimState[] = [];
  runReplay(replay, (s) => states.push(s));
  return { replay, states };
}

function buildMovement(): Built {
  const seed = 2202;
  const result = record({
    seed,
    numPlayers: 2,
    maxTicks: 700,
    tail: 40,
    scripts: (ctx) => [wander(ctx, 0, 560, 0xa11ce), wander(ctx, 1, 560, 0xb0b0b)],
  });
  return {
    replay: {
      name: 'movement',
      description:
        'Both players random-walk their corridors for ~9.5s — weaving, corner assist, wall clamps.',
      seed,
      numPlayers: 2,
      ticks: result.ticks,
      inputs: result.events,
    },
    states: result.states,
  };
}

/** Detect a tick where >= 2 bombs detonated simultaneously (a chain). */
function hadChainDetonation(states: SimState[]): boolean {
  for (let t = 1; t < states.length; t++) {
    const before = states[t - 1]!.bombs;
    const after = states[t]!.bombs;
    if (before.length >= 2 && after.length === 0) {
      // a chain means at least one removed bomb still had fuse left
      if (before.some((b) => b.fuseTicks > 1)) return true;
    }
  }
  return false;
}

function buildChain(): Built {
  const { seed, result } = searchSeed(
    3000,
    3000,
    (s0) => row1Softs(s0) <= 4,
    (seed) => {
      const res = record({
        seed,
        numPlayers: 2,
        maxTicks: 2600,
        tail: 60,
        scripts: (ctx) => [
          (function* script(): Script {
            // P1 bombs its way along the top corridor to (3,1), then stages.
            yield* clearPathTo(ctx, 1, 3, 1);
            yield* goTo(ctx, 1, 6, 1);
            // P0: classic corner opener — bomb (2,1), hide at the safe tile.
            yield* goTo(ctx, 0, 2, 1);
            yield* pressBomb(ctx, 0);
            yield* goTo(ctx, 0, 1, 1);
            yield* goTo(ctx, 0, 1, 2);
            // P1 places the chain bomb at (4,1) and retreats to safety.
            yield* goTo(ctx, 1, 4, 1);
            yield* pressBomb(ctx, 1);
            const safe = findNearestSafe(ctx.state, 1);
            if (safe === null) throw new GenFail('chain: no safe tile for p1');
            yield* goTo(ctx, 1, safe[0], safe[1]);
            yield* waitUntil(ctx, (s) => s.bombs.length === 0, 400, 'chain detonation');
            yield* waitUntil(ctx, (s) => s.explosions.length === 0, 60, 'sparks gone');
          })(),
        ],
      });
      const finalState = res.states[res.states.length - 1]!;
      if (!hadChainDetonation(res.states)) {
        throw new GenFail('chain: no chain detonation');
      }
      if (!finalState.players.every((p) => p.alive && !p.trapped)) {
        throw new GenFail('chain: a player was trapped/eliminated');
      }
      return res;
    },
  );
  return {
    replay: {
      name: 'chain',
      description:
        'P1 bombs through the top corridor (soft bricks, item drops), then P0+P1 place adjacent bombs that chain-detonate.',
      seed,
      numPlayers: 2,
      ticks: result.ticks,
      inputs: result.events,
    },
    states: result.states,
  };
}

function buildTrapRescue(): Built {
  // 3 players: P0 + P1 are teammates (team 0, top corners); P2 is a parked
  // opponent (team 1, bottom-left corner) whose only job is to keep a second
  // team alive so the match stays PLAYING (the win check ends the match the
  // moment only one distinct team has an alive player). P2 receives no script,
  // so it idles at its spawn the whole run.
  const { seed, result } = searchSeed(
    5000,
    3000,
    (s0) => row1Softs(s0) <= 4,
    (seed) => {
      const res = record({
        seed,
        numPlayers: 3,
        teams: [0, 0, 1],
        maxTicks: 2600,
        tail: 60,
        scripts: (ctx) => [
          (function* script(): Script {
            // P1 clears its way to a staging tile outside P0's blast.
            yield* clearPathTo(ctx, 1, 4, 1);
            // P0 self-traps: bomb own tile and stay put.
            yield* pressBomb(ctx, 0);
            yield* waitUntil(ctx, (s) => s.players[0]!.trapped, 400, 'p0 trapped');
            yield* waitUntil(ctx, (s) => s.explosions.length === 0, 60, 'sparks gone');
            // P1 (same team) walks in and touches the shell -> rescue.
            yield* goTo(ctx, 1, 1, 1);
            yield* waitUntil(
              ctx,
              (s) => !s.players[0]!.trapped && s.players[0]!.alive,
              60,
              'p0 rescued',
            );
          })(),
        ],
      });
      // Validate: trapped happened, was cleared by rescue well before timeout.
      const firstTrapped = res.states.findIndex((s) => s.players[0]!.trapped);
      if (firstTrapped < 0) throw new GenFail('trap-rescue: p0 never trapped');
      const rescued = res.states.findIndex(
        (s, i) => i > firstTrapped && !s.players[0]!.trapped && s.players[0]!.alive,
      );
      if (rescued < 0) throw new GenFail('trap-rescue: p0 never rescued');
      if (rescued - firstTrapped >= TRAPPED_TICKS) {
        throw new GenFail('trap-rescue: rescue came after the shell timeout');
      }
      // The parked opponent must keep the match alive throughout.
      if (res.states.some((s) => s.phase !== GamePhase.PLAYING)) {
        throw new GenFail('trap-rescue: match ended early (single team alive)');
      }
      return res;
    },
  );
  return {
    replay: {
      name: 'trap-rescue',
      description:
        'P0 traps itself in a sugar shell with its own bomb; teammate P1 bombs a path across and touches the shell to rescue (P2 is a parked opponent keeping the match live).',
      seed,
      numPlayers: 3,
      teams: [0, 0, 1],
      ticks: result.ticks,
      inputs: result.events,
    },
    states: result.states,
  };
}

function buildLongRun(): Built {
  const seed = 424242;
  const result = record({
    seed,
    numPlayers: 2,
    maxTicks: 1900,
    tail: 100,
    scripts: (ctx) => [
      rampage(ctx, 0, 1700, 0xdeadb),
      rampage(ctx, 1, 1700, 0xf00d5),
    ],
  });
  return {
    replay: {
      name: 'long-run',
      description:
        '~30s free-for-all: both players (opposing teams) bomb bricks, grab items, dodge their own blasts — everything mixed.',
      seed,
      numPlayers: 2,
      ticks: result.ticks,
      inputs: result.events,
    },
    states: result.states,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const builders: Array<() => Built> = [
  buildIdle,
  buildMovement,
  buildChain,
  buildTrapRescue,
  buildLongRun,
];

for (const build of builders) {
  const { replay, states } = build();
  // Sanity: the recorded open-loop replay must reproduce the closed-loop run.
  const log = runReplay(replay);
  const lastLive = states[states.length - 1]!.stateHash;
  const lastReplayed = log[log.length - 1]!.hash;
  if (lastLive !== lastReplayed) {
    throw new Error(`${replay.name}: recorded replay does not reproduce the run`);
  }
  writeFileSync(fixturePath(replay.name!), replayToJson(replay));
  console.log(
    `${replay.name!.padEnd(16)} seed=${String(replay.seed).padEnd(7)} ticks=${String(
      replay.ticks,
    ).padStart(4)} events=${String(replay.inputs.length).padStart(4)} final=${hashHex(
      lastReplayed,
    )}`,
  );
}
console.log('\nfixtures written — now run: npm run update-golden');
