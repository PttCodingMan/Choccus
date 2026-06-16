/**
 * Regenerate fixtures/golden.json from the CURRENT sim code. Run this only
 * when a hash change is an intentional logic/protocol change:
 *
 *   npm run update-golden
 */
import {
  GOLDEN_PATH,
  fixturePath,
  hashLogToHex,
  listFixtureNames,
  saveGolden,
} from './golden';
import { loadReplayFile, runReplay } from './replay';

const entries: Record<string, string[]> = {};
for (const name of listFixtureNames()) {
  const replay = loadReplayFile(fixturePath(name));
  const hex = hashLogToHex(runReplay(replay));
  entries[name] = hex;
  console.log(
    `${name.padEnd(18)} ticks=${String(hex.length).padStart(4)}  final=${hex[hex.length - 1]}`,
  );
}
saveGolden(entries);
console.log(`\nwrote ${GOLDEN_PATH}`);
