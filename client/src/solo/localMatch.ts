/**
 * Reusable offline match runner — the wall-clock loop that drives a fully local
 * match (human + AI bots, no relay). Lifted out of main.ts so the same loop
 * backs solo practice AND the offline waiting-room (net/LocalRoom). It owns the
 * rAF + fixed-timestep accumulator, the keyboard, the per-match state, the loss
 * recorder and the auto-restart; the sim only ever receives whole ticks and the
 * renderer interpolates between the last two states.
 *
 * Determinism is unaffected: this is pure render/timing orchestration. A fresh
 * uint32 seed is rolled per match with Math.random() (it only PICKS the seed —
 * the sim given that seed stays bit-deterministic; never used inside the sim).
 *
 * Config carries everything except the seed; `buildBots(seed)` returns a
 * slot-indexed array of bot brains with the human slot's entry null. Swap the
 * whole config on a picker change via `reset(newConfig)`; an internal R-press /
 * auto-restart re-rolls the seed but keeps the current config.
 */
import { TICK_MS } from '../../../shared/constants';
import { GamePhase } from '../../../shared/types';
import type { IBotController } from '../ai';
import { matchSound } from '../audio/MatchSound';
import { sfx } from '../audio/Sfx';
import type { FeelParams } from '../config/FeelParams';
import { KeyboardInput } from '../input/KeyboardInput';
import { sampleLocalInput } from '../input/InputMapper';
import type { Renderer } from '../render/Renderer';
import { type InputFrame, NO_INPUT } from '../sim/InputBuffer';
import { type MapKind, spawnOrderFromSeed } from '../sim/Map';
import { type SimState, createInitialState, tick } from '../sim/Sim';
import { LossRecorder } from './lossRecorder';

const randomSeed = (): number => Math.floor(Math.random() * 0x1_0000_0000) >>> 0;

/** Clamp big frame gaps (tab switch, breakpoint) to avoid a spiral of death. */
const MAX_FRAME_MS = 250;

/** Match-intro hold: render the frozen board with a 3·2·1 countdown + a ring on
 *  the local spawn before the first tick. Pure wall-clock (no sim ticks happen),
 *  so it never affects determinism. 'GO!' lingers briefly once play starts. */
const COUNTDOWN_MS = 3000;
const GO_MS = 600;

export interface LocalMatchConfig {
  map: MapKind;
  feel: FeelParams;
  /** Total players = human + bots. */
  numPlayers: number;
  /** Per-slot team ids; undefined = FFA (team = slot). */
  teams?: readonly number[];
  /** Slot-indexed bot brains for a fresh seed; the human slot's entry is null. */
  buildBots: (seed: number) => ReadonlyArray<IBotController | null>;
  slotLabels: ReadonlyArray<string | undefined>;
  hudHint: string;
  /** Slots rendered as bots; default = every slot except humanSlot. */
  botSlots?: ReadonlySet<number>;
  /** Slot driven by the local keyboard (default 0). */
  humanSlot?: number;
}

export interface LocalMatchOptions {
  /** Auto-start a fresh match ~2.5s after OVER (solo). Default true. */
  autoRestart?: boolean;
  /** Persist a replay fixture on an AI loss (solo diagnostics). Default true. */
  recordLoss?: boolean;
  /** Called once when the match reaches OVER (e.g. to return to a room). */
  onMatchOver?: (final: SimState) => void;
}

export interface LocalMatchHandle {
  /** Start a fresh random match; pass a config to swap it (picker change). */
  reset(config?: LocalMatchConfig): void;
  stop(): void;
}

export function runLocalMatch(
  renderer: Renderer,
  initialConfig: LocalMatchConfig,
  options: LocalMatchOptions = {},
): LocalMatchHandle {
  const autoRestart = options.autoRestart ?? true;
  const recordLoss = options.recordLoss ?? true;

  let cfg = initialConfig;
  const humanSlot = (): number => cfg.humanSlot ?? 0;

  const keyboard = new KeyboardInput();
  keyboard.attach(window);

  // Explicit team-per-slot (FFA default = team = slot), matching what
  // createInitialState builds — passed to the recorder so a replay reproduces
  // the exact teams.
  const explicitTeams = (): number[] =>
    cfg.teams?.slice() ?? Array.from({ length: cfg.numPlayers }, (_, i) => i);

  const lossRecorder = new LossRecorder();

  let seed = randomSeed();
  let bots: ReadonlyArray<IBotController | null> = [];
  // Assigned by reset() below before the rAF loop reads them.
  let cur!: SimState;
  let prev!: SimState;
  let acc = 0;
  let last: number | undefined;
  let restartScheduled = false;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  // Match-intro state: countdownLeft counts 3000→0 (no ticks); then goLeft holds
  // 'GO!' on screen while play has already begun.
  let countdownLeft = COUNTDOWN_MS;
  let goLeft = 0;
  // Last intro number we beeped for, so count() fires once per 3→2→1 step.
  let lastCountSec = 0;

  const reset = (next?: LocalMatchConfig): void => {
    if (next !== undefined) cfg = next;
    if (restartTimer !== undefined) {
      clearTimeout(restartTimer);
      restartTimer = undefined;
    }
    restartScheduled = false;
    seed = randomSeed();
    bots = cfg.buildBots(seed);
    cur = createInitialState(seed, cfg.feel, cfg.numPlayers, {
      pvp: true,
      map: cfg.map,
      teams: cfg.teams,
      spawnOrder: spawnOrderFromSeed(seed),
    });
    prev = cur;
    if (recordLoss) {
      lossRecorder.start(
        seed,
        cfg.map,
        cfg.numPlayers,
        explicitTeams(),
        spawnOrderFromSeed(seed).slice(0, cfg.numPlayers),
      );
    }
    renderer.setSlotLabels(cfg.slotLabels);
    renderer.setHudHint(cfg.hudHint, true);
    if (cfg.botSlots !== undefined) renderer.setBotSlots(cfg.botSlots);
    acc = 0;
    // Arm the intro: countdown + spawn ring on the local player.
    countdownLeft = COUNTDOWN_MS;
    goLeft = 0;
    lastCountSec = 0;
    renderer.setCountdown('3');
    renderer.setSpawnHighlight(cfg.humanSlot ?? 0);
  };

  // R = fresh random match (auto-restart mode only; a host-driven room owns its
  // own restart). Also unlocks the audio context on the first key.
  const onKey = (e: KeyboardEvent): void => {
    sfx.resumeContext();
    if (autoRestart && e.code === 'KeyR') reset();
  };
  window.addEventListener('keydown', onKey);

  reset(); // build the first match (assigns cur/prev)

  const frame = (now: number): void => {
    if (stopped) return;
    const dt = last === undefined ? 0 : Math.min(now - last, MAX_FRAME_MS);
    last = now;

    // Intro countdown: hold the frozen initial board (no ticks) for 3s.
    if (countdownLeft > 0) {
      countdownLeft -= dt;
      if (countdownLeft > 0) {
        const sec = Math.min(3, Math.ceil(countdownLeft / 1000));
        if (sec !== lastCountSec) {
          lastCountSec = sec;
          sfx.count(sec); // soft music-box tick per 3→2→1 (silent until audio unlocked)
        }
        renderer.setCountdown(String(sec));
        renderer.render(cur, cur, 0);
        requestAnimationFrame(frame);
        return;
      }
      // Countdown finished: flash GO!, drop the spawn ring, start play next frame.
      sfx.go();
      renderer.setCountdown('GO!');
      renderer.setSpawnHighlight(null);
      goLeft = GO_MS;
      acc = 0;
      renderer.render(cur, cur, 0);
      requestAnimationFrame(frame);
      return;
    }
    if (goLeft > 0) {
      goLeft -= dt;
      if (goLeft <= 0) renderer.setCountdown(null);
    }

    acc += dt;

    while (acc >= TICK_MS) {
      const inputs: InputFrame[] = [];
      for (let s = 0; s < cfg.numPlayers; s++) {
        if (s === humanSlot()) {
          inputs.push(sampleLocalInput(keyboard));
        } else {
          const b = bots[s];
          inputs.push(b ? b.sample(cur, s) : NO_INPUT);
        }
      }
      const prevTick = cur;
      prev = cur;
      cur = tick(cur, inputs);
      if (recordLoss) lossRecorder.tick(prevTick.tick, inputs, prevTick, cur);
      matchSound.tick(prevTick, cur);
      acc -= TICK_MS;
    }

    if (cur.phase === GamePhase.OVER && !restartScheduled) {
      restartScheduled = true;
      if (recordLoss) {
        const lossSummary = lossRecorder.finishIfAiLost(cur);
        if (lossSummary !== null) console.log(lossSummary);
      }
      options.onMatchOver?.(cur);
      if (autoRestart) restartTimer = setTimeout(() => reset(), 2500);
    }

    renderer.render(prev, cur, acc / TICK_MS);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  return {
    reset,
    stop(): void {
      stopped = true;
      if (restartTimer !== undefined) {
        clearTimeout(restartTimer);
        restartTimer = undefined;
      }
      renderer.setCountdown(null);
      renderer.setSpawnHighlight(null);
      keyboard.detach(window);
      window.removeEventListener('keydown', onKey);
    },
  };
}
