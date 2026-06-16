/**
 * Determinism-hostile token guard: a cheap backstop in case the ESLint
 * `no-restricted-properties` config for client/src/sim/** ever drifts.
 * Scans raw source text (comments included — keep banned names out of sim
 * comments too; the noise is worth the safety).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SIM_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'client',
  'src',
  'sim',
);

const BANNED = [
  'Date.now',
  'Math.random',
  'performance.now',
  'Math.sin',
  'Math.cos',
  'Math.sqrt',
];

describe('determinism-hostile tokens are absent from client/src/sim', () => {
  const files = readdirSync(SIM_DIR, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.ts'));

  it('finds the sim sources', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  for (const file of files) {
    it(`${file} contains no banned token`, () => {
      const text = readFileSync(join(SIM_DIR, file), 'utf8');
      for (const token of BANNED) {
        expect(text.includes(token), `${file} contains banned token "${token}"`).toBe(
          false,
        );
      }
    });
  }
});
