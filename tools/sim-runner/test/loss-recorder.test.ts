/**
 * LossRecorder round-trips a solo match into a sim-runner Replay fixture: the
 * sparse-event encoding must reproduce the exact per-tick frames, and replaying
 * the captured fixture (seed + map + teams) must land on the SAME final hash as
 * the live match — proving a recorded AI loss reproduces headless on either map.
 */
import { describe, expect, it } from 'vitest';

import { ActionFlags, Direction } from '../../../shared/types';
import { makeFeelParams } from '../../../client/src/config/FeelParams';
import { type InputFrame, NO_INPUT } from '../../../client/src/sim/InputBuffer';
import { type MapKind, spawnOrderFromSeed } from '../../../client/src/sim/Map';
import { type SimState, createInitialState, tick } from '../../../client/src/sim/Sim';
import { LossRecorder } from '../../../client/src/solo/lossRecorder';
import { expandInputs, runReplay } from '../src/replay';

/** Scripted inputs: slot 0 wanders + drops one bomb; other slots idle. */
function scriptInput(t: number, slot: number): InputFrame {
  if (slot !== 0) return NO_INPUT;
  if (t < 10) return { dir: Direction.RIGHT, action: ActionFlags.NONE };
  if (t === 10) return { dir: Direction.NONE, action: ActionFlags.BOMB };
  if (t < 25) return { dir: Direction.LEFT, action: ActionFlags.NONE };
  return NO_INPUT;
}

function recordLiveMatch(map: MapKind, seed: number, ticks: number) {
  const n = 2;
  const teams = [0, 1];
  // Exercise a shuffled spawn order so the recorder→replay round-trip proves the
  // permutation is captured and reproduced (not just identity spawns).
  const spawnOrder = spawnOrderFromSeed(seed).slice(0, n);
  let state: SimState = createInitialState(seed, makeFeelParams(), n, {
    map,
    teams,
    spawnOrder,
  });
  const rec = new LossRecorder();
  rec.start(seed, map, n, teams, spawnOrder);
  const fedFrames: InputFrame[][] = [];
  for (let t = 0; t < ticks; t++) {
    const inputs = [scriptInput(state.tick, 0), scriptInput(state.tick, 1)];
    fedFrames.push(inputs.map((f) => ({ dir: f.dir, action: f.action })));
    const prevState = state;
    state = tick(state, inputs);
    rec.tick(prevState.tick, inputs, prevState, state);
  }
  return { replay: rec.toReplay(state), fedFrames, finalHash: state.stateHash };
}

describe('LossRecorder', () => {
  for (const map of ['classic', 'pirate'] as const) {
    it(`captures a ${map} match that replays to the same final hash`, () => {
      const { replay, fedFrames, finalHash } = recordLiveMatch(map, 12345, 60);

      // (1) sparse events expand back to the exact frames that were fed.
      const expanded = expandInputs(replay);
      expect(expanded).toEqual(fedFrames);

      // (2) the fixture replays headless to the identical final state hash.
      const log = runReplay(replay);
      expect(log[log.length - 1]!.hash).toBe(finalHash);
      expect(replay.map).toBe(map);
    });
  }

  it('flags an AI loss only when the human (slot 0) side wins', () => {
    const rec = new LossRecorder();
    rec.start(1, 'classic', 2, [0, 1], [0, 1]);
    // Hand-built terminal states: slot 0 alive, slot 1 dead ⇒ human won ⇒ AI lost.
    const base = createInitialState(1, makeFeelParams(), 2, { map: 'classic', teams: [0, 1] });
    const humanWon: SimState = {
      ...base,
      players: [base.players[0]!, { ...base.players[1]!, alive: false }],
    };
    const humanLost: SimState = {
      ...base,
      players: [{ ...base.players[0]!, alive: false }, base.players[1]!],
    };
    expect(rec.aiLost(humanWon)).toBe(true);
    expect(rec.aiLost(humanLost)).toBe(false);
  });
});
