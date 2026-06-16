/**
 * Frozen v1 regression lock.
 *
 * The frozen V1BotController + frozen V1 Aggressor/ChaosV tuning must always
 * behave bit-for-bit identically against the committed v1-golden.json: it is the
 * immutable "benchmark is always the same opponent" reference that future live
 * bot versions (v2, v3, …) are measured against.
 *
 * If this test goes red, the frozen v1 snapshot changed (a v1 file was edited,
 * or an imported stable sim/RNG primitive shifted) — that is a bug, NOT a reason
 * to regenerate the golden.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  V1_GOLDEN_PATH,
  V1_SCENARIO,
  runV1Baseline,
} from '../baselines/v1/gen-v1-golden';

function loadGoldenHexes(): string[] {
  const doc = JSON.parse(readFileSync(V1_GOLDEN_PATH, 'utf8')) as Record<
    string,
    string
  >;
  const seq = doc[V1_SCENARIO];
  if (seq === undefined) {
    throw new Error(`v1 golden missing scenario "${V1_SCENARIO}"`);
  }
  return seq.split(' ');
}

describe('frozen v1 behavior is locked', () => {
  it('matches the committed v1-golden.json exactly', () => {
    const expected = loadGoldenHexes();
    const actual = runV1Baseline();
    expect(actual).toEqual(expected);
  });

  it('is deterministic (two runs produce identical hashes)', () => {
    const a = runV1Baseline();
    const b = runV1Baseline();
    expect(a).toEqual(b);
  });
});
