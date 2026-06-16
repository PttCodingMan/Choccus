/**
 * The core M2 suite: proves the sim is bit-deterministic and pins its
 * behavior against committed golden hashes.
 *
 * Failure triage (also printed in the golden test's message):
 * - same-process identity FAILS            → nondeterminism bug in the sim.
 * - identity passes but golden differs     → sim logic changed; if intentional,
 *   regenerate with `npm run update-golden`.
 */
import { describe, expect, it } from 'vitest';

import { makeFeelParams } from '../../../client/src/config/FeelParams';
import { createInitialState, tick } from '../../../client/src/sim/Sim';
import {
  fixturePath,
  goldenHashes,
  listFixtureNames,
  loadGolden,
} from '../src/golden';
import {
  type Replay,
  expandInputs,
  hashHex,
  loadReplayFile,
  runReplay,
} from '../src/replay';

const names = listFixtureNames();
const replays = new Map<string, Replay>(
  names.map((n) => [n, loadReplayFile(fixturePath(n))]),
);

function hashes(replay: Replay): string[] {
  return runReplay(replay).map((e) => hashHex(e.hash));
}

it('has the expected fixture set', () => {
  expect(names.length).toBeGreaterThanOrEqual(5);
  expect(names).toContain('idle');
  expect(names).toContain('long-run');
});

describe('same-process replay identity', () => {
  for (const name of names) {
    it(`fixture "${name}": two runs produce identical hash logs`, () => {
      const replay = replays.get(name)!;
      const a = hashes(replay);
      const b = hashes(replay);
      expect(a.length).toBe(replay.ticks);
      const firstDiff = a.findIndex((h, i) => h !== b[i]);
      expect(
        firstDiff,
        firstDiff >= 0
          ? `NONDETERMINISM: same-process runs of "${name}" diverge at tick ${firstDiff + 1}`
          : '',
      ).toBe(-1);
    });
  }
});

describe('cross-instance identity (independent SimStates, interleaved ticks)', () => {
  for (const name of names) {
    it(`fixture "${name}": independently constructed states hash-match every tick`, () => {
      const replay = replays.get(name)!;
      // Construct EVERYTHING twice — feel params, input frames, states — so a
      // shared-mutable-state bug (e.g. a constant array getting mutated)
      // cannot hide. The two sims advance interleaved within one process.
      const framesA = expandInputs(replay);
      const framesB = expandInputs(replay);
      let a = createInitialState(replay.seed >>> 0, makeFeelParams(replay.feelParams), replay.numPlayers);
      let b = createInitialState(replay.seed >>> 0, makeFeelParams(replay.feelParams), replay.numPlayers);
      expect(hashHex(a.stateHash)).toBe(hashHex(b.stateHash));
      for (let t = 0; t < replay.ticks; t++) {
        a = tick(a, framesA[t]!);
        b = tick(b, framesB[t]!);
        if (a.stateHash !== b.stateHash) {
          throw new Error(
            `NONDETERMINISM: cross-instance hash mismatch in "${name}" at tick ${t + 1}: ` +
              `${hashHex(a.stateHash)} vs ${hashHex(b.stateHash)}`,
          );
        }
      }
      expect(a.tick).toBe(replay.ticks);
    });
  }
});

describe('golden-hash regression', () => {
  const golden = loadGolden();

  it('golden.json covers exactly the committed fixtures', () => {
    expect(Object.keys(golden).sort()).toEqual(names);
  });

  for (const name of names) {
    it(`fixture "${name}": live hash log matches committed golden`, () => {
      const replay = replays.get(name)!;
      const gold = goldenHashes(golden, name);
      expect(gold, `no golden entry for "${name}" — run npm run update-golden`).not.toBeNull();
      const live = hashes(replay);
      if (live.length === gold!.length && live.every((h, i) => h === gold![i])) {
        return; // match
      }
      // Mismatch — classify it for the developer.
      const second = hashes(replay);
      const deterministic =
        live.length === second.length && live.every((h, i) => h === second[i]);
      let at = live.findIndex((h, i) => h !== gold![i]);
      if (at < 0) at = Math.min(live.length, gold!.length);
      const detail =
        `golden mismatch for "${name}" at tick ${at + 1}: ` +
        `live=${live[at] ?? '(end)'} golden=${gold![at] ?? '(end)'}\n` +
        (deterministic
          ? 'Same-process replay identity still holds → this is a LOGIC/BEHAVIOR ' +
            'change in the sim, not a determinism bug. If the change is ' +
            'intentional, regenerate goldens with `npm run update-golden`.'
          : 'Same-process replay identity ALSO fails → this is a NONDETERMINISM ' +
            'bug (e.g. Date/Math.random/shared mutable state) — do NOT update ' +
            'the goldens; fix the sim.');
      throw new Error(detail);
    });
  }
});
