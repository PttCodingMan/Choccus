/**
 * Solo loss recorder: capture a match as a replay fixture so an AI loss can be
 * reproduced and diagnosed headless.
 *
 * The sim is deterministic, so seed + map + every slot's per-tick input fully
 * reproduces a match. We record exactly the `Replay` fixture shape that
 * tools/sim-runner/src/replay.ts already consumes — so a captured loss runs
 * straight through `npm run replay -- <file>.json` with zero new tooling. Inputs
 * are stored sparsely (one event per slot only when its frame changes), matching
 * the loader's persist-until-changed semantics.
 *
 * "AI lost" = the human (slot 0) side won. On that, the replay is pushed to
 * localStorage (and `window.aiLosses`) for later extraction; everything else is
 * a no-op so normal play is untouched. Render-layer only — never imported by the
 * sim, so its wall-clock/storage use is fine.
 */
import { type InputFrame } from '../sim/InputBuffer';
import { type MapKind } from '../sim/Map';
import { resolveOutcome } from '../sim/Outcome';
import { type SimState } from '../sim/Sim';

/** Sparse input event (mirrors sim-runner's ReplayInputEvent). */
export interface ReplayInputEvent {
  tick: number;
  slot: number;
  dir: number;
  action: number;
}

/** A recorded match in the sim-runner Replay fixture shape (+ diagnostics). */
export interface LossReplay {
  name: string;
  description: string;
  seed: number;
  map: MapKind;
  numPlayers: number;
  teams: number[];
  /** Spawn-corner index per slot (slot i spawns at SPAWN_CORNERS[spawnOrder[i]]). */
  spawnOrder: number[];
  ticks: number;
  inputs: ReplayInputEvent[];
  /** Who died, when, and how — 'crush' = sudden-death wall, 'kill' = bomb/enemy. */
  deaths: { slot: number; tick: number; cause: 'crush' | 'kill' }[];
}

const STORAGE_KEY = 'choccus.aiLosses';
const MAX_STORED = 10;

export class LossRecorder {
  private seed = 0;
  private map: MapKind = 'classic';
  private numPlayers = 0;
  private teams: number[] = [];
  private spawnOrder: number[] = [];
  private events: ReplayInputEvent[] = [];
  private prev: InputFrame[] = [];
  private deaths: LossReplay['deaths'] = [];

  /** Begin recording a fresh match. */
  start(
    seed: number,
    map: MapKind,
    numPlayers: number,
    teams: number[],
    spawnOrder: number[],
  ): void {
    this.seed = seed >>> 0;
    this.map = map;
    this.numPlayers = numPlayers;
    this.teams = teams.slice();
    this.spawnOrder = spawnOrder.slice();
    this.events = [];
    this.prev = [];
    this.deaths = [];
  }

  /**
   * Record one advanced tick. `applyTick` = the index of the state being
   * advanced (prevState.tick); `inputs` produced `nextState` from `prevState`.
   * Emits a sparse event for each slot whose frame changed, and logs any
   * alive→dead transition with its cause (a player trapped before death was
   * killed by a bomb/enemy; one alive-and-untrapped before death was crushed by
   * the sudden-death wall).
   */
  tick(
    applyTick: number,
    inputs: readonly InputFrame[],
    prevState: SimState,
    nextState: SimState,
  ): void {
    for (let s = 0; s < this.numPlayers; s++) {
      const f = inputs[s];
      if (f === undefined) continue;
      const p = this.prev[s];
      if (p === undefined || p.dir !== f.dir || p.action !== f.action) {
        this.events.push({ tick: applyTick, slot: s, dir: f.dir, action: f.action });
        this.prev[s] = { dir: f.dir, action: f.action };
      }
    }
    for (let s = 0; s < this.numPlayers; s++) {
      const was = prevState.players[s];
      const now = nextState.players[s];
      if (was?.alive && now !== undefined && !now.alive) {
        this.deaths.push({
          slot: s,
          tick: nextState.tick,
          cause: was.trapped ? 'kill' : 'crush',
        });
      }
    }
  }

  /** True if the human (slot 0) side won this final state — i.e. the AI lost. */
  aiLost(finalState: SimState): boolean {
    const humanTeam = finalState.players[0]?.team;
    return humanTeam !== undefined && resolveOutcome(finalState).winnerTeam === humanTeam;
  }

  /** Pure: build the replay fixture for the recorded match (no side effects). */
  toReplay(finalState: SimState): LossReplay {
    const deathStr =
      this.deaths.map((d) => `s${d.slot}@${d.tick}:${d.cause}`).join(', ') || 'none';
    return {
      name: `ai-loss-${this.seed}`,
      description: `Solo AI loss on ${this.map}: human (slot 0) won. Deaths: ${deathStr}.`,
      seed: this.seed,
      map: this.map,
      numPlayers: this.numPlayers,
      teams: this.teams,
      spawnOrder: this.spawnOrder,
      ticks: finalState.tick,
      inputs: this.events,
      deaths: this.deaths,
    };
  }

  /**
   * At match end: if the AI lost, persist the replay and return a one-line
   * summary; otherwise return null. Persistence is best-effort (a full or
   * blocked localStorage never interrupts play).
   */
  finishIfAiLost(finalState: SimState): string | null {
    if (!this.aiLost(finalState)) return null;
    const replay = this.toReplay(finalState);
    persist(replay);
    return (
      `[AI LOSS] seed=${replay.seed} map=${replay.map} ticks=${replay.ticks} ` +
      `deaths=[${replay.deaths.map((d) => `s${d.slot}@${d.tick}:${d.cause}`).join(', ')}] ` +
      `— saved to localStorage['${STORAGE_KEY}'] (window.aiLosses)`
    );
  }
}

/** Minimal localStorage shape — typed structurally so this module compiles
 *  under tsconfigs without the DOM lib (e.g. the sim-runner test runner). */
interface MiniStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Append `replay` to the stored loss list, evicting oldest on quota/size. */
function persist(replay: LossReplay): void {
  const g = globalThis as unknown as {
    localStorage?: MiniStorage;
    aiLosses?: LossReplay[];
  };
  const store = g.localStorage;
  if (store === undefined) return; // headless/blocked — best-effort, skip.
  try {
    const raw = store.getItem(STORAGE_KEY);
    const list: LossReplay[] = raw ? (JSON.parse(raw) as LossReplay[]) : [];
    list.push(replay);
    while (list.length > MAX_STORED) list.shift();
    for (;;) {
      try {
        store.setItem(STORAGE_KEY, JSON.stringify(list));
        break;
      } catch {
        if (list.length <= 1) {
          list.length = 0;
          break;
        }
        list.shift(); // quota exceeded: drop the oldest and retry
      }
    }
    g.aiLosses = list;
  } catch {
    // localStorage unavailable/blocked — recording is best-effort, ignore.
  }
}
