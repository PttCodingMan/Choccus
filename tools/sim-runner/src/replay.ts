/**
 * Replay format + headless runner for the deterministic sim core.
 *
 * A replay is a JSON document:
 *
 *   {
 *     "name":        string (optional, for humans),
 *     "description": string (optional),
 *     "seed":        number (uint32 match seed),
 *     "feelParams":  Partial<FeelParams> (optional; defaults via makeFeelParams),
 *     "numPlayers":  number (1..4),
 *     "teams":       number[] (optional; team per slot — defaults to slot index,
 *                    i.e. each player on its own team. Co-op fixtures set e.g.
 *                    [0, 0] so teammates can rescue each other.),
 *     "ticks":       number (how many tick() calls to run),
 *     "inputs":      [{ "tick": n, "slot": s, "dir": bits, "action": bits }, ...]
 *   }
 *
 * SPARSE INPUT SEMANTICS (the contract — keep consistent everywhere):
 * - `inputs` is an event list. An event sets slot `s`'s InputFrame starting at
 *   tick `n` (0-based: the frame passed to the tick() call that advances
 *   state.tick from n to n+1) and PERSISTS until a later event for the same
 *   slot replaces it.
 * - Slots with no event yet (or none at all) use NO_INPUT.
 * - Events may appear in any order; they are sorted by tick (stable: original
 *   array order breaks ties, so for duplicate (tick, slot) the LAST one in the
 *   array wins).
 * - Events with tick >= ticks are ignored; tick < 0 or slot out of range is an
 *   error.
 *
 * The runner is pure orchestration: no Date / Math.random / performance —
 * everything deterministic lives in client/src/sim.
 */
import { readFileSync } from 'node:fs';

import {
  type FeelParams,
  makeFeelParams,
} from '../../../client/src/config/FeelParams';
import { NO_INPUT, type InputFrame } from '../../../client/src/sim/InputBuffer';
import { MAP_KINDS, spawnOrderFromSeed, type MapKind } from '../../../client/src/sim/Map';
import {
  type SimState,
  createInitialState,
  tick,
} from '../../../client/src/sim/Sim';

export interface ReplayInputEvent {
  tick: number;
  slot: number;
  /** Direction bitflags (shared/types Direction). */
  dir: number;
  /** ActionFlags bitflags. */
  action: number;
}

export interface Replay {
  name?: string;
  description?: string;
  seed: number;
  feelParams?: Partial<FeelParams>;
  numPlayers: number;
  /** Team per slot (optional). Default: team = slot index. */
  teams?: number[];
  /** Map layout (optional). Default: 'classic'. */
  map?: MapKind;
  /**
   * Spawn-corner index per slot (optional). Slot i spawns at the i-th corner by
   * default; supplying a permutation here reproduces a shuffled-spawn match
   * (solo/net). Omit it (as the golden/bench fixtures do) for identity spawns.
   */
  spawnOrder?: number[];
  ticks: number;
  inputs: ReplayInputEvent[];
}

export interface HashLogEntry {
  tick: number;
  /** uint32 FNV-1a state hash after this tick. */
  hash: number;
}

/** Render a uint32 hash as 8 lowercase hex digits. */
export function hashHex(hash: number): string {
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Throw with a useful message if the replay document is malformed. */
export function validateReplay(replay: Replay): void {
  if (!Number.isInteger(replay.seed)) throw new Error('replay.seed must be an integer');
  if (
    !Number.isInteger(replay.numPlayers) ||
    replay.numPlayers < 1 ||
    replay.numPlayers > 4
  ) {
    throw new Error('replay.numPlayers must be an integer in 1..4');
  }
  if (replay.teams !== undefined) {
    if (
      !Array.isArray(replay.teams) ||
      replay.teams.length !== replay.numPlayers ||
      !replay.teams.every((t) => Number.isInteger(t) && t >= 0)
    ) {
      throw new Error('replay.teams must be numPlayers non-negative integers');
    }
  }
  if (replay.map !== undefined && !MAP_KINDS.includes(replay.map)) {
    throw new Error(`replay.map must be one of: ${MAP_KINDS.join(', ')}`);
  }
  if (replay.spawnOrder !== undefined) {
    const so = replay.spawnOrder;
    const valid =
      Array.isArray(so) &&
      so.length === replay.numPlayers &&
      so.every((c) => Number.isInteger(c) && c >= 0 && c < 4) &&
      new Set(so).size === so.length;
    if (!valid) {
      throw new Error(
        'replay.spawnOrder must be numPlayers distinct corner indices in 0..3',
      );
    }
  }
  if (!Number.isInteger(replay.ticks) || replay.ticks < 1) {
    throw new Error('replay.ticks must be a positive integer');
  }
  if (!Array.isArray(replay.inputs)) throw new Error('replay.inputs must be an array');
  for (const ev of replay.inputs) {
    if (!Number.isInteger(ev.tick) || ev.tick < 0) {
      throw new Error(`input event has invalid tick: ${JSON.stringify(ev)}`);
    }
    if (!Number.isInteger(ev.slot) || ev.slot < 0 || ev.slot >= replay.numPlayers) {
      throw new Error(`input event has invalid slot: ${JSON.stringify(ev)}`);
    }
    if (!Number.isInteger(ev.dir) || !Number.isInteger(ev.action)) {
      throw new Error(`input event has invalid dir/action: ${JSON.stringify(ev)}`);
    }
  }
}

/**
 * Expand the sparse event list into one InputFrame[] (length numPlayers) per
 * tick, following the persist-until-changed semantics documented above.
 * Every frame is a FRESH object so callers can't share mutable state.
 */
export function expandInputs(replay: Replay): InputFrame[][] {
  validateReplay(replay);
  const events = replay.inputs
    .map((ev, order) => ({ ev, order }))
    .sort((a, b) => a.ev.tick - b.ev.tick || a.order - b.order);

  const current: InputFrame[] = [];
  for (let s = 0; s < replay.numPlayers; s++) current.push({ ...NO_INPUT });

  const frames: InputFrame[][] = [];
  let next = 0;
  for (let t = 0; t < replay.ticks; t++) {
    while (next < events.length && events[next]!.ev.tick === t) {
      const { ev } = events[next]!;
      current[ev.slot] = { dir: ev.dir, action: ev.action };
      next += 1;
    }
    frames.push(current.map((f) => ({ dir: f.dir, action: f.action })));
  }
  return frames;
}

/**
 * Run a replay headless and return the per-tick hash log. `onTick` (optional)
 * observes every post-tick state — used by tests/fixture validation.
 */
export function runReplay(
  replay: Replay,
  onTick?: (state: SimState) => void,
): HashLogEntry[] {
  const frames = expandInputs(replay);
  const feel = makeFeelParams(replay.feelParams);
  let state = createInitialState(replay.seed >>> 0, feel, replay.numPlayers, {
    ...(replay.teams !== undefined ? { teams: replay.teams } : {}),
    ...(replay.map !== undefined ? { map: replay.map } : {}),
    ...(replay.spawnOrder !== undefined ? { spawnOrder: replay.spawnOrder } : {}),
  });
  const log: HashLogEntry[] = [];
  for (const frame of frames) {
    state = tick(state, frame);
    log.push({ tick: state.tick, hash: state.stateHash });
    if (onTick !== undefined) onTick(state);
  }
  return log;
}

/**
 * The relay-side replay-upload document (mirror of shared/protocol.ts
 * ReplayUploadMsg + the provenance the relay stamps on write). The relay stores
 * it as-is; `replayFromUpload` converts it into the sparse Replay above so
 * `npm run replay -- replays/<file>.json` can run an uploaded match.
 */
export interface ReplayUploadDoc {
  /** Schema tag the relay writes so the loader can detect this format. */
  schema: 'choccus-replay-upload-v1';
  seed: number;
  map: MapKind;
  teams: number[];
  numPlayers: number;
  /** First sim tick (net matches always 0; the runner starts from tick 0). */
  t0: number;
  config: Partial<FeelParams>;
  /** Dense, contiguous per-tick inputs (one {dirs,actions} per slot). */
  inputs: Array<{ t: number; slots: Array<{ dirs: number; actions: number }> }>;
  result?: 'win' | 'loss' | 'draw';
  winnerTeam?: number | null;
  /** Server wall-clock ISO timestamp (provenance only). */
  uploadedAt?: string;
}

/** Type guard: an uploaded (dense) replay doc vs the authored (sparse) Replay. */
function isUploadDoc(doc: unknown): doc is ReplayUploadDoc {
  return (
    typeof doc === 'object' &&
    doc !== null &&
    (doc as { schema?: unknown }).schema === 'choccus-replay-upload-v1'
  );
}

/**
 * Convert a relay-stored upload (dense inputs) into the sparse Replay the runner
 * consumes. Dense → sparse: emit one event per slot only when its {dir,action}
 * changes from the previous tick (persist-until-changed). spawnOrder is derived
 * deterministically from the seed (net/solo matches shuffle spawns), so the
 * fixture reproduces the match bit-for-bit. The upload's t0 must be 0 (net
 * matches start there; the runner has no tick offset).
 */
export function replayFromUpload(doc: ReplayUploadDoc): Replay {
  if (doc.t0 !== 0) {
    throw new Error(`upload.t0 must be 0 (got ${doc.t0}); the runner starts at tick 0`);
  }
  const n = doc.numPlayers;
  const events: ReplayInputEvent[] = [];
  // Track the last emitted frame per slot; NO_INPUT is the implicit start.
  const last: Array<{ dir: number; action: number }> = Array.from(
    { length: n },
    () => ({ dir: NO_INPUT.dir, action: NO_INPUT.action }),
  );
  for (const frame of doc.inputs) {
    const slots = frame.slots;
    for (let s = 0; s < n; s++) {
      const wire = slots[s];
      if (wire === undefined) continue;
      if (wire.dirs !== last[s]!.dir || wire.actions !== last[s]!.action) {
        events.push({ tick: frame.t, slot: s, dir: wire.dirs, action: wire.actions });
        last[s] = { dir: wire.dirs, action: wire.actions };
      }
    }
  }
  const replay: Replay = {
    name: `upload ${doc.uploadedAt ?? ''}`.trim(),
    description: `relay upload (result=${doc.result ?? '?'} winnerTeam=${
      doc.winnerTeam ?? 'null'
    })`,
    seed: doc.seed >>> 0,
    feelParams: doc.config,
    numPlayers: n,
    teams: doc.teams,
    map: doc.map,
    spawnOrder: spawnOrderFromSeed(doc.seed >>> 0).slice(0, n),
    ticks: doc.inputs.length,
    inputs: events,
  };
  validateReplay(replay);
  return replay;
}

/** Load + validate a replay JSON file (authored sparse OR relay upload). */
export function loadReplayFile(path: string): Replay {
  const doc: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (isUploadDoc(doc)) return replayFromUpload(doc);
  const replay = doc as Replay;
  validateReplay(replay);
  return replay;
}

/**
 * Serialize a replay with one input event per line — compact and diffable
 * (pretty JSON would explode fixture files to 6 lines per event).
 */
export function replayToJson(replay: Replay): string {
  const head: string[] = [];
  if (replay.name !== undefined) head.push(`  "name": ${JSON.stringify(replay.name)}`);
  if (replay.description !== undefined) {
    head.push(`  "description": ${JSON.stringify(replay.description)}`);
  }
  head.push(`  "seed": ${replay.seed}`);
  if (replay.feelParams !== undefined) {
    head.push(`  "feelParams": ${JSON.stringify(replay.feelParams)}`);
  }
  head.push(`  "numPlayers": ${replay.numPlayers}`);
  if (replay.teams !== undefined) {
    head.push(`  "teams": ${JSON.stringify(replay.teams)}`);
  }
  if (replay.spawnOrder !== undefined) {
    head.push(`  "spawnOrder": ${JSON.stringify(replay.spawnOrder)}`);
  }
  head.push(`  "ticks": ${replay.ticks}`);
  const events = replay.inputs.map(
    (ev) =>
      `    { "tick": ${ev.tick}, "slot": ${ev.slot}, "dir": ${ev.dir}, "action": ${ev.action} }`,
  );
  const inputs =
    events.length === 0 ? '  "inputs": []' : `  "inputs": [\n${events.join(',\n')}\n  ]`;
  return `{\n${head.join(',\n')},\n${inputs}\n}\n`;
}
