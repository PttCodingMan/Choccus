// Generator for v1-golden.json: replays a fixed 4-bot FFA match driven by the
// FROZEN V1BotController + frozen V1 Aggressor/ChaosV tuning and records the
// per-tick state hashes. The recorded sequence is an immutable benchmark — the
// frozen v1 bot must always behave identically against this fixture.
//
//   npm run update-v1-golden
//
// NOTE: this is a generator/harness, NOT one of the 4 frozen snapshot files, so
// it carries no FROZEN header.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';

import { makeFeelParams } from '../../../../client/src/config/FeelParams';
import { createInitialState, tick, type SimState } from '../../../../client/src/sim/Sim';
import { botSeed } from '../../../../client/src/ai/BotConfig';
import { hashHex } from '../../src/replay';
import { V1BotController } from './V1BotController';
import { V1_AGGRESSOR, V1_CHAOSV } from './v1Strategies';

/** Scenario key under which the golden hex sequence is stored. */
export const V1_SCENARIO = 'v1-aggressor-chaosv-ffa';

/** Fixed match seed for the frozen v1 baseline. */
export const V1_SEED = 0x00c0ffee; // 12648430

/** Fixed tick budget for the frozen v1 baseline. */
export const V1_TICKS = 1200;

/** Absolute path to the committed v1 golden fixture. */
export const V1_GOLDEN_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'v1-golden.json',
);

/**
 * Run the frozen 4-bot FFA v1 baseline match and return the per-tick state hash
 * as 8-digit hex strings. Deterministic and self-contained: fixed seed, fixed
 * tick count, per-slot config (slots 0/2 → V1 Aggressor, slots 1/3 → V1 ChaosV),
 * early-break recorded exactly as observed. Shared by the generator's main() and
 * the regression test so the run loop lives in one place.
 */
export function runV1Baseline(): string[] {
  const fp = makeFeelParams();
  const numPlayers = 4;
  // FFA: do NOT pass opts.teams → each slot is its own team.
  let state: SimState = createInitialState(V1_SEED, fp, numPlayers);

  const controllers = state.players.map((p) => {
    // Slots 0 and 2 → V1 Aggressor; slots 1 and 3 → V1 ChaosV.
    const tuning =
      p.slot % 2 === 0 ? V1_AGGRESSOR.tuning : V1_CHAOSV.tuning;
    return new V1BotController(botSeed(V1_SEED, p.slot), tuning, p.slot);
  });

  const hexes: string[] = [];
  for (let t = 0; t < V1_TICKS; t++) {
    const inputs = state.players.map((p) =>
      controllers[p.slot]!.sample(state, p.slot),
    );
    state = tick(state, inputs);
    hexes.push(hashHex(state.stateHash));
    if (state.phase !== 1 /* PLAYING */) break;
  }
  return hexes;
}

function main(): void {
  const hexes = runV1Baseline();
  const doc: Record<string, string> = { [V1_SCENARIO]: hexes.join(' ') };
  writeFileSync(V1_GOLDEN_PATH, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(
    `wrote ${V1_GOLDEN_PATH}\n  scenario=${V1_SCENARIO} ticks=${hexes.length} final=${hexes[hexes.length - 1]}`,
  );
}

// Run main() only when executed directly (not when imported by the test).
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
