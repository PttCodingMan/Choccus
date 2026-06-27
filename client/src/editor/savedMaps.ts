/**
 * Persistent named maps backed by `localStorage` — the map editor's "My maps"
 * store and the SOLO map picker's "★ saved" entries both read through here.
 *
 * LOCAL / SOLO ONLY. These templates live only in this browser's localStorage,
 * so they must NEVER reach the net lobby or any online room: a remote client has
 * no copy of the template and the match would desync. The deterministic sim, the
 * shipped map templates (`MAP_KINDS`), golden and AI are all untouched — saved
 * maps only ever flow through `registerCustomTemplate` on the local solo path.
 *
 * Schema — one key, a flat name → rows object:
 *   localStorage['choccus.savedMaps'] = JSON.stringify({
 *     [name: string]: string[]   // exactly 13 rows of 15 chars each
 *   })
 * Each row uses the same template chars as sim/Map.ts: `#`/`S`/`P`/`.`/`@`.
 * A valid map has exactly 4 `@` spawns (validated on save).
 */
import { MAP_COLS, MAP_ROWS } from '../../../shared/constants';

/** The single localStorage key holding the whole `{ name → rows }` object. */
const STORE_KEY = 'choccus.savedMaps';

/** Parsed store shape: a map name → its 13 template rows. */
type SavedMapStore = Record<string, string[]>;

/**
 * Read + parse the whole store. Corrupt / missing / wrong-shaped JSON is treated
 * as an empty store (never throws), so a stale or hand-edited value can't break
 * the editor or the solo picker. Only well-formed `string[]` row arrays survive.
 */
function readStore(): SavedMapStore {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORE_KEY);
  } catch {
    return {}; // localStorage unavailable (private mode, etc.)
  }
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {}; // corrupt JSON → treat as empty
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const out: SavedMapStore = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (Array.isArray(value) && value.every((r) => typeof r === 'string')) {
      out[name] = value as string[];
    }
  }
  return out;
}

/** Serialize + write the whole store back to localStorage. */
function writeStore(store: SavedMapStore): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(store));
}

/**
 * Validate a candidate map with the SAME rules as the shipped templates and
 * `registerCustomTemplate`: exactly 13 rows, each exactly 15 chars, and exactly
 * 4 `@` spawn tiles. Throws an Error with a user-facing message on the first
 * violation (the caller surfaces `err.message`).
 */
function validateLines(lines: readonly string[]): void {
  if (lines.length !== MAP_ROWS) {
    throw new Error(`Map must have ${MAP_ROWS} rows, got ${lines.length}.`);
  }
  let spawns = 0;
  for (let y = 0; y < lines.length; y++) {
    const row = lines[y]!;
    if (row.length !== MAP_COLS) {
      throw new Error(`Row ${y + 1} must be ${MAP_COLS} chars, got ${row.length}.`);
    }
    for (const ch of row) if (ch === '@') spawns++;
  }
  if (spawns !== 4) {
    throw new Error(`Map must have exactly 4 spawns (@), got ${spawns}.`);
  }
}

/** All saved map names, stable-sorted (locale-aware, case-insensitive). */
export function listSavedMaps(): string[] {
  return Object.keys(readStore()).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  );
}

/** The rows for a saved map, or `null` if no map by that name exists. */
export function getSavedMap(name: string): string[] | null {
  const store = readStore();
  const rows = store[name];
  return rows ? rows.slice() : null;
}

/**
 * Save `lines` under `name`, overwriting any existing map with that name.
 * Validates the map BEFORE touching storage — an invalid map (wrong size or
 * ≠4 spawns) throws and writes nothing. Empty / whitespace-only names are
 * rejected too. `name` is trimmed before use.
 */
export function saveMap(name: string, lines: readonly string[]): void {
  const trimmed = name.trim();
  if (trimmed === '') {
    throw new Error('Please enter a name for the map.');
  }
  validateLines(lines);
  const store = readStore();
  store[trimmed] = lines.slice();
  writeStore(store);
}

/** Remove a saved map by name (no-op if it doesn't exist). */
export function deleteSavedMap(name: string): void {
  const store = readStore();
  if (name in store) {
    delete store[name];
    writeStore(store);
  }
}
