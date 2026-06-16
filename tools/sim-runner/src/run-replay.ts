/**
 * CLI hash-log generator.
 *
 *   npm run replay -- <replay.json> [--jsonl]
 *
 * Runs the replay headless and prints one line per tick:
 *   CSV (default):  tick,hashHex
 *   --jsonl:        {"tick":n,"hash":"hex"}
 */
import { hashHex, loadReplayFile, runReplay } from './replay';

function main(argv: string[]): number {
  const args = argv.filter((a) => a !== '--jsonl');
  const jsonl = args.length !== argv.length;
  const path = args[0];
  if (path === undefined) {
    console.error('usage: run-replay <replay.json> [--jsonl]');
    return 2;
  }
  const replay = loadReplayFile(path);
  const log = runReplay(replay);
  const lines = log.map((e) =>
    jsonl
      ? JSON.stringify({ tick: e.tick, hash: hashHex(e.hash) })
      : `${e.tick},${hashHex(e.hash)}`,
  );
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

process.exit(main(process.argv.slice(2)));
