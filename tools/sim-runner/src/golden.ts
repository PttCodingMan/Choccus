/**
 * Golden hash-log storage: fixtures/golden.json maps fixture name → the full
 * per-tick hash log as a single space-joined string of 8-digit hex hashes
 * (index i = the hash after tick i+1). Regenerate INTENTIONALLY with
 * `npm run update-golden`.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type HashLogEntry, hashHex } from './replay';

export const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
);

export const GOLDEN_PATH = join(FIXTURES_DIR, 'golden.json');

/** Fixture names = every fixtures/*.json except golden.json, sorted. */
export function listFixtureNames(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'golden.json')
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

export function fixturePath(name: string): string {
  return join(FIXTURES_DIR, `${name}.json`);
}

export function hashLogToHex(log: HashLogEntry[]): string[] {
  return log.map((e) => hashHex(e.hash));
}

export type GoldenFile = Record<string, string>;

export function loadGolden(): GoldenFile {
  return JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as GoldenFile;
}

export function goldenHashes(golden: GoldenFile, name: string): string[] | null {
  const entry = golden[name];
  if (entry === undefined) return null;
  return entry.length === 0 ? [] : entry.split(' ');
}

export function saveGolden(entries: Record<string, string[]>): void {
  const names = Object.keys(entries).sort();
  const lines = names.map(
    (n) => `  ${JSON.stringify(n)}: ${JSON.stringify(entries[n]!.join(' '))}`,
  );
  writeFileSync(GOLDEN_PATH, `{\n${lines.join(',\n')}\n}\n`);
}
