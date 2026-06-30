/**
 * Tile grid: `Uint8Array(MAP_COLS * MAP_ROWS)` of `TileKind`.
 *
 * EVERY map is now a fully authored ASCII template (see `MAP_TEMPLATES`). There
 * is no procedural / PRNG-rolled kind anymore — `generateMap` draws ZERO PRNG
 * values for all kinds and returns the incoming PRNG state UNCHANGED, so the map
 * never perturbs the shared stream. (Historically 'classic' rolled its soft
 * bricks per-seed; it is now a fixed template so the map editor can paint it.)
 *
 * Template chars: `#`=HARD, `S`=SOFT, `P`=PUSH(able crate), `.`=EMPTY,
 * `@`=SPAWN (an EMPTY tile that is also a player spawn point). Each template MUST
 * contain exactly 4 `@` tiles — one per slot. Spawn slot order = scan order
 * (y-major, x-minor); for the standard four corners that yields TL, TR, BL, BR.
 *
 * Around each `@` an L/plus of tiles is force-cleared to EMPTY (the spawn tile
 * plus its in-bounds, non-outer-ring orthogonal neighbours), opening the spawn
 * pocket regardless of what the template painted there. For the four canonical
 * corners this reproduces the old 3-tile spawn-clear L exactly, so the authored
 * maps stay byte-identical.
 */
import { MAP_COLS, MAP_ROWS } from '../../../shared/constants';
import { TileKind } from '../../../shared/types';
import { prngInt } from './Prng';

export type TileGrid = Uint8Array;

/**
 * Map layout variant. A free string (not a closed union) so the map editor can
 * add new authored kinds without a type change — every kind that exists is a key
 * of `MAP_TEMPLATES`; unknown kinds fall back to classic at generation time.
 */
export type MapKind = string;

/**
 * The authored 'classic' layout: the hard outer ring + the even-(x,y) interior
 * lattice (`#`), every other interior tile SOFT (`S`), spawns (`@`) at the four
 * corners. Formerly PRNG-rolled per seed; frozen to a fixed template so it can be
 * edited like the others (this changed the classic PRNG stream → golden re-pinned).
 */
const CLASSIC_TEMPLATE: readonly string[] = [
  '@.SPSS...SSPS.@',
  '.#S#S#S#S#S#S#.',
  'SSSSSSSSSSSSSSS',
  'P#S#S#S#S#S#S#P',
  'SSSSSSSSSSSSSSS',
  '.#S#S#S#S#S#S#.',
  '..SSSSSSSSSSS..',
  '.#S#S#S#S#S#S#.',
  'SSSSSSSSSSSSSSS',
  'P#S#S#S#S#S#S#P',
  'SSSSSSSSSSSSSSS',
  '.#S#S#.#.#S#S#.',
  '@.SPSS...SSPS.@',
];

/**
 * The authored 'village' layout (an ORIGINAL design inspired by the openness /
 * rhythm of a classic village map — NOT a tile-for-tile copy; map LAYOUT is
 * protected art, see CLAUDE.md §三). A plus-shaped EMPTY road cross (vertical
 * lane col 7 + horizontal lane row 6) divides four soft-brick quadrants, with an
 * irregular scatter of HARD anchors (cols 2/5/9/12 on the lattice rows) instead
 * of the regular even lattice. The `P` PUSHABLE bricks render as wooden X-crates
 * (see candyArt cubeHtml) and LINE THE ROAD LANES — columns 6 & 8 hug the
 * vertical lane, and a few flank the horizontal lane — mirroring the crate-lined
 * roads of the source map. Every crate sits one tile off an EMPTY lane so it can
 * be shoved into it (see Player.ts canPush). `@` marks the four corner spawns.
 */
const VILLAGE_TEMPLATE: readonly string[] = [
  '@.SSS...P.#S#@#',
  '.#P#P#P..#SS...',
  '..SSSS.PP.#P#P#',
  'P#P#P#P..#SSSSS',
  'SSSSSS..P.#P#P#',
  'S#S#S#PP..SSSSS',
  '#.#.#...P.#.#.#',
  'SSSSS.P..#S#S#S',
  '#P#P#..PPSSSSSS',
  'SSSSS#P..#P#P#S',
  '#S#P#.P.PSSSSS.',
  '.@SSS#.P.#P#P#.',
  '#.#S#...P.SSS.@',
];

/**
 * The authored 'pirate' layout: 13 rows of 15 chars each, row index = y,
 * char index = x. Interior HARD anchors: the four corner pillars and a central
 * horizontal hard bar; everything else is SOFT. `@` marks the four corner spawns.
 *
 * SPAWN PLACEMENT: the two TOP spawns sit at x=2/x=12 (not the old center-pair
 * x=5/x=9). A 1v1 duel takes spawn slots 0,1 = the first two in scan order = the
 * top pair, so they MUST be far apart — at x=5/x=9 (4 tiles) the bots met before
 * they could develop and locked into a passive sudden-death standoff (dev/bot
 * plateaued ~1 upgrade vs ~4 once widened). x=1/x=13 (or the literal corners)
 * box the bot in against the `#` pillar + PUSH ring, so x=2 is the inset sweet
 * spot. The bottom pair stays at x=1/x=13 (12 apart, their pockets open inward).
 */
const PIRATE_TEMPLATE: readonly string[] = [
  'SS@S.S.S.S.S@SS',
  'S#S.PPP.PPP.S#S',
  'SS.P.S.P.S.P.SS',
  'S.P.SSSSSSS.P.S',
  'S.PSSSSSSSSSP.S',
  'S.P.SSSSSSS.P.S',
  'S.PSSS###SSSP.S',
  'SS.P.SSSSS.P.SS',
  'SSS.PSSSSSP.SSS',
  'SSSS.P.S.P.SSSS',
  'SS.SS.PPP.SS.SS',
  'S#.SSS...SSS.#S',
  'S@.SSSSSSSSS.@S',
];

/**
 * Registry of every authored map kind. The map editor's dev endpoint splices new
 * `*_TEMPLATE` consts in and adds a key here; `generateMap`, `mapSpawns`, and the
 * UI map pickers (`MAP_KINDS`) all read from this single source of truth.
 */
const MAP_TEMPLATES: Record<string, readonly string[]> = {
  classic: CLASSIC_TEMPLATE,
  pirate: PIRATE_TEMPLATE,
  village: VILLAGE_TEMPLATE,
};

/** All authored map kinds, in registry order — drives the UI map pickers.
 *  Snapshotted at module load so a runtime `registerCustomTemplate` (local map
 *  editor only) never leaks a custom kind into the shipped map pickers. */
export const MAP_KINDS: readonly string[] = Object.keys(MAP_TEMPLATES);

/**
 * Return the authored template lines for a kind, or `undefined` if unregistered.
 * Lets the map editor seed its canvas from a shipped template without exposing
 * the private `*_TEMPLATE` consts (read-only — never mutate the returned array).
 */
export function templateForKind(kind: MapKind): readonly string[] | undefined {
  return MAP_TEMPLATES[kind];
}

/**
 * Register (or replace) a custom map template at runtime, after validating it
 * with the same rules as the shipped maps (13 rows × 15 chars, exactly 4 `@`).
 * Since `generateMap`/`mapSpawns` read `MAP_TEMPLATES` dynamically, registering
 * makes `kind` immediately playable.
 *
 * LOCAL SOLO PLAY ONLY (the map editor's "play test"): deliberately does NOT add
 * the kind to the exported `MAP_KINDS`, so the shipped map pickers stay unchanged
 * and no golden/AI re-pin is implied. Stays pure / deterministic-safe — drawing
 * the map still consumes zero PRNG. Throws on an invalid template.
 */
export function registerCustomTemplate(kind: string, lines: readonly string[]): void {
  validateTemplate(`custom template '${kind}'`, lines);
  MAP_TEMPLATES[kind] = lines;
}

/** Flat index for tile (x, y). Caller guarantees bounds. */
export function idx(x: number, y: number): number {
  return y * MAP_COLS + x;
}

export function inBounds(x: number, y: number): boolean {
  return x >= 0 && x < MAP_COLS && y >= 0 && y < MAP_ROWS;
}

/** Map a single template char to its TileKind (`#`/`S`/`P`/`.`/`@`→EMPTY). */
function templateTile(ch: string): TileKind {
  if (ch === '#') return TileKind.HARD;
  if (ch === 'S') return TileKind.SOFT;
  if (ch === 'P') return TileKind.PUSH;
  return TileKind.EMPTY; // '.' and '@' (spawn) are walkable EMPTY
}

/** All `@` spawn tiles in a template, in scan order (y-major) = slot order. */
function spawnsOf(tmpl: readonly string[]): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = [];
  for (let y = 0; y < MAP_ROWS; y++) {
    for (let x = 0; x < MAP_COLS; x++) {
      if (tmpl[y]![x] === '@') out.push([x, y]);
    }
  }
  return out;
}

/**
 * The set of flat indices force-cleared to EMPTY around the spawns: each spawn
 * tile plus its in-bounds, non-outer-ring orthogonal neighbours. At the four
 * corners this is the classic 3-tile L (two of the four neighbours are the ring
 * and are skipped), so the canonical maps are unchanged; for an interior spawn
 * it is a 5-tile plus.
 */
function spawnClearSet(spawns: ReadonlyArray<readonly [number, number]>): Set<number> {
  const clear = new Set<number>();
  for (const [sx, sy] of spawns) {
    clear.add(idx(sx, sy));
    for (const [nx, ny] of [
      [sx + 1, sy],
      [sx - 1, sy],
      [sx, sy + 1],
      [sx, sy - 1],
    ] as const) {
      // Skip the outer ring (and out-of-bounds): never punch a hole in the wall.
      if (nx > 0 && nx < MAP_COLS - 1 && ny > 0 && ny < MAP_ROWS - 1) {
        clear.add(idx(nx, ny));
      }
    }
  }
  return clear;
}

/** Validate an authored template at module load so a typo fails loudly. */
function validateTemplate(name: string, tmpl: readonly string[]): void {
  if (tmpl.length !== MAP_ROWS) {
    throw new Error(`${name} must have ${MAP_ROWS} rows, got ${tmpl.length}`);
  }
  for (let y = 0; y < tmpl.length; y++) {
    const row = tmpl[y]!;
    if (row.length !== MAP_COLS) {
      throw new Error(`${name} row ${y} must be ${MAP_COLS} chars, got ${row.length}`);
    }
  }
  const spawns = spawnsOf(tmpl);
  if (spawns.length !== 4) {
    throw new Error(`${name} must have exactly 4 '@' spawn tiles, got ${spawns.length}`);
  }
}
for (const [kind, tmpl] of Object.entries(MAP_TEMPLATES)) {
  validateTemplate(`${kind.toUpperCase()}_TEMPLATE`, tmpl);
}

/** The four canonical spawn corners (inside the hard outer ring), slot order 0..3. */
export const SPAWN_CORNERS: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [MAP_COLS - 2, 1],
  [1, MAP_ROWS - 2],
  [MAP_COLS - 2, MAP_ROWS - 2],
];

/** The spawn points for a map kind, in slot order. Falls back to the four
 *  corners for an unknown kind or a (malformed) template with no spawns. */
export function mapSpawns(kind: MapKind): ReadonlyArray<readonly [number, number]> {
  const spawns = spawnsOf(MAP_TEMPLATES[kind] ?? CLASSIC_TEMPLATE);
  return spawns.length > 0 ? spawns : SPAWN_CORNERS;
}

/**
 * A deterministic permutation of the four spawn indices `[0,1,2,3]`, derived
 * purely from `seed` (Fisher-Yates over a Mulberry32 stream). Pure and
 * decision-free — same seed always yields the same order on every client, so it
 * can be re-derived from the shared match seed in net play with no extra wire
 * data. Pass the result as `createInitialState`'s `spawnOrder` so slot i spawns
 * at `mapSpawns(kind)[order[i]]` instead of spawn i.
 *
 * Note: the spawn-clear zones are always force-cleared at generation time and
 * consume no PRNG, so permuting which slot lands on which spawn never perturbs
 * map generation. The default (no `spawnOrder`) keeps the identity mapping, so
 * the headless bench/golden path stays byte-identical.
 */
export function spawnOrderFromSeed(seed: number): number[] {
  const order = [0, 1, 2, 3];
  // Decorrelate from the map-generation stream (which consumes `seed` directly).
  let s = (seed ^ 0x5bd1e995) >>> 0;
  for (let i = order.length - 1; i > 0; i--) {
    let j: number;
    [j, s] = prngInt(s, 0, i);
    const tmp = order[i]!;
    order[i] = order[j]!;
    order[j] = tmp;
  }
  return order;
}

/**
 * Generate the map for the given `kind` from its authored template. Draws ZERO
 * PRNG values (the incoming state is returned UNCHANGED) — the map never
 * perturbs the shared stream. Unknown kinds fall back to the classic template.
 */
export function generateMap(
  prng: number,
  kind: MapKind = 'classic',
): [TileGrid, number] {
  const tmpl = MAP_TEMPLATES[kind] ?? CLASSIC_TEMPLATE;
  const clear = spawnClearSet(spawnsOf(tmpl));
  const grid = new Uint8Array(MAP_COLS * MAP_ROWS);
  for (let y = 0; y < MAP_ROWS; y++) {
    for (let x = 0; x < MAP_COLS; x++) {
      const i = idx(x, y);
      const t = templateTile(tmpl[y]![x]!);
      // Spawn-clear only dissolves SOFT filler — the "don't spawn me boxed in a
      // destructible cage" guarantee. HARD/PUSH on a spawn-clear cell are
      // deliberate authored structure (e.g. pirate's bottom hard bricks); keep
      // them exactly as drawn. The spawn tile itself is '@'→EMPTY regardless.
      grid[i] = clear.has(i) && t === TileKind.SOFT ? TileKind.EMPTY : t;
    }
  }
  return [grid, prng];
}

/** Tile-level walkability: in bounds and EMPTY (bombs are checked separately). */
export function isWalkable(grid: TileGrid, x: number, y: number): boolean {
  return inBounds(x, y) && grid[idx(x, y)] === TileKind.EMPTY;
}
