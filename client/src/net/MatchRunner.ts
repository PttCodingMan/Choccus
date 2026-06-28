/**
 * MatchRunner: the SINGLE runner for every match path — online relay,
 * solo practice, bot-vs-bot spectate and the offline waiting-room. It owns ONE
 * LockstepEngine, the rAF render loop, the keyboard attachment and the SFX for
 * that match's lifetime. The only thing that varies between paths is the
 * Transport (relay NetClient vs in-process LoopbackTransport) and a handful of
 * orchestration options below; the deterministic sim runs identically through
 * the engine in all of them.
 *
 * Constructed when a match begins, stop()ped when it is torn down (rematch,
 * disconnect, back to lobby, picker change). The Renderer / NetClient are
 * long-lived and passed in.
 *
 * - countdown (default true): a wall-clock 3·2·1·GO! hold on the frozen initial
 *   board before the first engine.update(). No sim ticks happen during it, so it
 *   never affects determinism; in lockstep the per-client skew is absorbed by the
 *   tick barrier (purely cosmetic). Enabled for net too.
 * - autoRestart (local only): ~2.5s after OVER, rebuild a fresh match (new seed)
 *   from the supplied `rebuild` factory. R also forces an immediate restart.
 * - record: 'aiLoss' persists a solo replay to localStorage when the human wins
 *   (existing LossRecorder behavior); 'humanLoss' captures the dense replay every
 *   tick and, on OVER if the local player lost, fires onReplayReady with a
 *   self-contained ReplayUpload object (Phase 2b uploads it — not done here).
 * - onOver fires exactly once when the sim reaches OVER (the engine keeps
 *   rendering the frozen end state until stop() / restart).
 * - onStatus fires every frame with the engine's LockstepStatus.
 * - speed (spectate): multiplies the wall-clock dt fed to the engine so a match
 *   can be watched faster — bounded by the engine's MAX_TICKS_PER_FRAME cap (so
 *   the effective ceiling is ~2× a 60fps frame; the cap exists to stop slow-frame
 *   spirals and is the firm contract).
 * - Hidden-tab fallback: rAF stops when a tab is hidden, which would stall a
 *   whole lockstep room, so a 250 ms interval keeps pumping the engine while
 *   hidden (browsers throttle it to ~1 Hz).
 */
import { GamePhase } from '../../../shared/types';
import type { IBotController } from '../ai';
import { matchSound } from '../audio/MatchSound';
import { sfx } from '../audio/Sfx';
import type { FeelParams } from '../config/FeelParams';
import { KeyboardInput } from '../input/KeyboardInput';
import { sampleLocalInput } from '../input/InputMapper';
import type { Renderer } from '../render/Renderer';
import { type InputFrame } from '../sim/InputBuffer';
import { spawnOrderFromSeed } from '../sim/Map';
import type { SimState } from '../sim/Sim';
import { resolveOutcome } from '../sim/Outcome';
import { LossRecorder } from '../solo/lossRecorder';
import { LockstepEngine, type LockstepStatus } from './LockstepEngine';
import type { Transport } from './Transport';
import type { MatchStartMsg, ReplayTick, ReplayUploadMsg } from './protocolCodec';

/** Match-intro hold (wall-clock only; no sim ticks): 3·2·1 then a brief 'GO!'. */
const COUNTDOWN_MS = 3000;
const GO_MS = 600;

/**
 * Per-pump tick cap for the HIDDEN-tab background pump. The engine clamps a
 * single update() delta to 1000 ms (≈60 ticks), so this finite cap comfortably
 * covers a full catch-up while staying well clear of any runaway. Foreground
 * frames keep the engine's small default cap (paint/spiral protection).
 */
const HIDDEN_PUMP_MAX_TICKS = 256;

/** A finished match's self-contained replay (the ReplayUpload payload). */
export type MatchReplay = Omit<ReplayUploadMsg, 'type'>;

/** Bot spec for a slot: a tier (net resolves it) or a pre-built brain (local). */
export interface MatchBot {
  slot: number;
  difficulty?: string;
  brain?: IBotController;
}

/**
 * Everything needed to (re)build a match instance. The autoRestart factory and
 * the initial construction both produce one of these; the runner re-creates the
 * engine from it on restart.
 */
export interface MatchSpec {
  start: MatchStartMsg;
  /** Slot count = highest occupied slot + 1. */
  numPlayers: number;
  bots?: ReadonlyArray<MatchBot>;
}

export interface MatchRunnerOptions {
  /** Input transport: relay NetClient for net, LoopbackTransport for local. */
  transport: Transport;
  start: MatchStartMsg;
  /** Slot count = highest occupied slot + 1 at MatchStart. */
  numPlayers: number;
  /** Bot slots (tier for net, pre-built brain for local). */
  bots?: ReadonlyArray<MatchBot>;
  renderer: Renderer;
  /** Long-lived; attached to window for the match, detached on stop(). */
  keyboard: KeyboardInput;
  /**
   * Sample the LOCAL player's raw input for a sim tick. Defaults to reading the
   * keyboard; spectate (no human) passes one that always returns NO_INPUT.
   */
  sampleLocalInput?: (forTick: number) => InputFrame;
  /** Show the 3·2·1·GO! intro before the first tick. Default true. */
  countdown?: boolean;
  /** Rebuild a fresh match (new seed) after OVER + on R. Local only. */
  autoRestart?: boolean;
  /** Delay before the post-OVER auto-restart fires (default 2500 ms). */
  restartDelayMs?: number;
  /** Factory for the next match on autoRestart / R (required if autoRestart). */
  rebuild?: () => MatchSpec;
  /**
   * Replay recording: 'aiLoss' = solo behavior (persist on human win);
   * 'humanLoss' = capture every tick, fire onReplayReady on OVER if the local
   * player lost; 'none' = off. Default 'none'.
   */
  record?: 'aiLoss' | 'humanLoss' | 'none';
  /** Fired with the self-contained replay when record='humanLoss' and we lost. */
  onReplayReady?: (replay: MatchReplay) => void;
  /** Show the mute toggle button (top-right). Default true. */
  showMuteButton?: boolean;
  /** Speed multiplier for the wall-clock dt fed to the engine (spectate). */
  speed?: number;
  /** Fired once when the sim reaches OVER. `winnerTeam` is the absolute winning
   *  team (= winning slot in FFA), or null for a draw. `result` is that outcome
   *  relative to the local player. `final` is the frozen OVER state. */
  onOver?: (
    result: 'win' | 'loss' | 'draw',
    finalState: SimState,
    winnerTeam: number | null,
  ) => void;
  /** Fired every animation frame with the engine status. */
  onStatus?: (status: LockstepStatus) => void;
}

export class MatchRunner {
  engine: LockstepEngine;
  private readonly opts: MatchRunnerOptions;
  private spec: MatchSpec;
  private rafId = 0;
  private readonly bgPump: ReturnType<typeof setInterval>;
  private last: number | undefined;
  private stopped = false;
  private overFired = false;
  private readonly countdownEnabled: boolean;
  private readonly speed: number;
  private readonly sample: (forTick: number) => InputFrame;

  // Intro state: countdownLeft counts COUNTDOWN_MS→0 (no ticks), then goLeft
  // holds 'GO!' on screen while play has already started.
  private countdownLeft: number;
  private goLeft = 0;
  private lastCountSec = 0;

  // Auto-restart bookkeeping (overFired guards single-fire; this cancels a
  // still-pending restart timer on an explicit R / stop()).
  private restartTimer: ReturnType<typeof setTimeout> | undefined;

  // Recorder (record !== 'none'). Solo persists; humanLoss captures dense ticks.
  private readonly recorder: LossRecorder | null;
  private replayTicks: ReplayTick[] = [];

  private readonly muteBtn: HTMLButtonElement | null;

  constructor(opts: MatchRunnerOptions) {
    this.opts = opts;
    this.spec = { start: opts.start, numPlayers: opts.numPlayers, bots: opts.bots };
    this.countdownEnabled = opts.countdown ?? true;
    this.countdownLeft = this.countdownEnabled ? COUNTDOWN_MS : 0;
    this.speed = opts.speed ?? 1;
    this.sample = opts.sampleLocalInput ?? ((): InputFrame => sampleLocalInput(opts.keyboard));
    this.recorder =
      (opts.record ?? 'none') === 'none' ? null : new LossRecorder();

    opts.keyboard.attach(window);
    window.addEventListener('keydown', this.onKey);

    // Mute toggle button (fixed top-right, above the canvas).
    if (opts.showMuteButton ?? true) {
      this.muteBtn = document.createElement('button');
      this.muteBtn.style.cssText =
        'position:fixed;top:8px;right:8px;z-index:900;padding:6px 12px;' +
        'background:rgba(61,28,2,0.85);color:#f5e6d3;border:none;border-radius:8px;' +
        'font:13px system-ui,sans-serif;cursor:pointer;';
      const updateMuteBtn = (): void => {
        this.muteBtn!.textContent = sfx.muted ? '🔇 Muted' : '🔊 Sound On';
      };
      updateMuteBtn();
      this.muteBtn.addEventListener('click', () => {
        sfx.toggleMute();
        updateMuteBtn();
      });
      document.body.appendChild(this.muteBtn);
    } else {
      this.muteBtn = null;
    }

    // Resume audio context on first input gesture.
    window.addEventListener('keydown', () => sfx.resumeContext(), { once: true });
    window.addEventListener('click', () => sfx.resumeContext(), { once: true });

    this.engine = this.buildEngine(this.spec);
    this.armCountdown();

    this.rafId = requestAnimationFrame(this.frame);
    this.bgPump = setInterval(() => {
      if (document.visibilityState === 'hidden' && !this.stopped) {
        // Hidden: no paint to block, so let the engine fully catch up to the
        // elapsed wall clock (60 Hz) instead of the foreground per-frame cap.
        // A throttled hidden tab otherwise produces only ~8 ticks/s and stalls
        // the whole lockstep room (see LockstepEngine.update maxTicks).
        this.pump(performance.now(), HIDDEN_PUMP_MAX_TICKS);
      }
    }, 250);
  }

  /** Build a fresh engine from a spec, wiring the recorder hook when active. */
  private buildEngine(spec: MatchSpec): LockstepEngine {
    if (this.recorder !== null) {
      const { seed, map, teams } = spec.start;
      const explicitTeams =
        teams?.slice() ?? Array.from({ length: spec.numPlayers }, (_, i) => i);
      this.recorder.start(
        seed,
        map ?? 'classic',
        spec.numPlayers,
        explicitTeams,
        spawnOrderFromSeed(seed).slice(0, spec.numPlayers),
      );
    }
    this.replayTicks = [];
    return new LockstepEngine({
      transport: this.opts.transport,
      start: spec.start,
      numPlayers: spec.numPlayers,
      bots: spec.bots,
      // In net mode you control your own player with the arrow keys regardless
      // of assigned slot; spectate passes a NO_INPUT sampler (slot 0 is a bot).
      sampleLocalInput: this.sample,
      onAdvance: this.recorder !== null ? this.onAdvance : undefined,
    });
  }

  /** Recorder hook: capture the tick into the LossRecorder and the dense list. */
  private readonly onAdvance = (
    applyTick: number,
    inputs: readonly InputFrame[],
    prev: SimState,
    next: SimState,
  ): void => {
    this.recorder?.tick(applyTick, inputs, prev, next);
    if ((this.opts.record ?? 'none') === 'humanLoss') {
      this.replayTicks.push({
        t: applyTick,
        slots: inputs.map((f) => ({ dirs: f.dir, actions: f.action })),
      });
    }
  };

  /** Arm the intro (countdown + spawn ring) for the current engine state. */
  private armCountdown(): void {
    this.countdownLeft = this.countdownEnabled ? COUNTDOWN_MS : 0;
    this.goLeft = 0;
    this.lastCountSec = 0;
    if (this.countdownEnabled) {
      this.opts.renderer.setCountdown('3');
      this.opts.renderer.setSpawnHighlight(this.spec.start.slot);
    }
  }

  /** R = immediate restart (autoRestart paths only). Also unlocks audio. */
  private readonly onKey = (e: KeyboardEvent): void => {
    sfx.resumeContext();
    if ((this.opts.autoRestart ?? false) && e.code === 'KeyR') this.restart();
  };

  /**
   * Rebuild a fresh match from the rebuild factory (auto-restart / R / an
   * external picker change). Re-reads the factory, so callers that mutate the
   * match config (bot count, map, feel, …) just call this to apply it.
   */
  restart(): void {
    const rebuild = this.opts.rebuild;
    if (rebuild === undefined) return;
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    this.overFired = false;
    this.engine.stop();
    this.spec = rebuild();
    this.engine = this.buildEngine(this.spec);
    this.last = undefined;
    this.armCountdown();
  }

  private pump(now: number, maxTicks?: number): void {
    const dt = this.last === undefined ? 0 : (now - this.last) * this.speed;
    this.last = now;
    if (maxTicks === undefined) this.engine.update(dt);
    else this.engine.update(dt, maxTicks);
  }

  private readonly frame = (now: number): void => {
    if (this.stopped) return;
    const renderer = this.opts.renderer;

    // Intro: hold the frozen initial board (no ticks) for COUNTDOWN_MS.
    if (this.countdownLeft > 0) {
      const dt = this.last === undefined ? 0 : now - this.last;
      this.last = now;
      this.countdownLeft -= dt;
      const { next } = this.engine.getRenderStates();
      if (this.countdownLeft > 0) {
        const sec = Math.min(3, Math.ceil(this.countdownLeft / 1000));
        if (sec !== this.lastCountSec) {
          this.lastCountSec = sec;
          sfx.count(sec); // soft tick per 3→2→1 (silent until audio unlocked)
        }
        renderer.setCountdown(String(sec));
        renderer.render(next, next, 0);
        this.opts.onStatus?.(this.engine.getStatus());
        this.rafId = requestAnimationFrame(this.frame);
        return;
      }
      // Countdown done: flash GO!, drop the spawn ring, start play next frame.
      sfx.go();
      renderer.setCountdown('GO!');
      renderer.setSpawnHighlight(null);
      this.goLeft = GO_MS;
      this.last = now; // reset the dt baseline so the first tick step isn't huge
      renderer.render(next, next, 0);
      this.opts.onStatus?.(this.engine.getStatus());
      this.rafId = requestAnimationFrame(this.frame);
      return;
    }
    if (this.goLeft > 0) {
      const dt = this.last === undefined ? 0 : now - this.last;
      this.goLeft -= dt;
      if (this.goLeft <= 0) renderer.setCountdown(null);
    }

    const { prev: prevBefore } = this.engine.getRenderStates();
    this.pump(now);
    const { prev, next, alpha } = this.engine.getRenderStates();
    // Drive SFX: diff the state rendered last frame against the new state.
    if (prevBefore.tick !== next.tick) {
      matchSound.tick(prevBefore, next);
    }
    renderer.render(prev, next, alpha);
    this.opts.onStatus?.(this.engine.getStatus());

    if (!this.overFired && next.phase === GamePhase.OVER) {
      this.overFired = true;
      this.handleOver(next);
    }
    this.rafId = requestAnimationFrame(this.frame);
  };

  /** Resolve the outcome at OVER, fire recorder + onOver, schedule restart. */
  private handleOver(final: SimState): void {
    // PvP: last team standing, or — at the time cap — most survivors → item
    // tiebreak → draw. Map the winning team to the local player.
    const me = final.players.find((p) => p.slot === this.spec.start.slot);
    const { winnerTeam } = resolveOutcome(final);
    const result: 'win' | 'loss' | 'draw' =
      winnerTeam === null
        ? 'draw'
        : me !== undefined && winnerTeam === me.team
          ? 'win'
          : 'loss';

    const record = this.opts.record ?? 'none';
    if (record === 'aiLoss' && this.recorder !== null) {
      // Solo: persist + log a replay when the human (AI's opponent) won.
      const summary = this.recorder.finishIfAiLost(final);
      if (summary !== null) console.log(summary);
    } else if (record === 'humanLoss' && result === 'loss') {
      // Net: hand a self-contained replay up for upload (Phase 2b).
      this.opts.onReplayReady?.(this.buildReplay(final, result, winnerTeam));
    }

    this.opts.onOver?.(result, final, winnerTeam);

    if ((this.opts.autoRestart ?? false) && this.opts.rebuild !== undefined) {
      this.restartTimer = setTimeout(
        () => this.restart(),
        this.opts.restartDelayMs ?? 2500,
      );
    }
  }

  /** Assemble the dense, self-contained replay for upload. */
  private buildReplay(
    final: SimState,
    result: 'win' | 'loss' | 'draw',
    winnerTeam: number | null,
  ): MatchReplay {
    const { start, numPlayers } = this.spec;
    const config: FeelParams = start.config;
    const teams =
      start.teams?.slice() ?? Array.from({ length: numPlayers }, (_, i) => i);
    return {
      seed: start.seed >>> 0,
      map: start.map ?? 'classic',
      teams,
      numPlayers,
      t0: start.t0,
      config,
      inputs: this.replayTicks,
      result,
      winnerTeam,
    };
  }

  /** Tear the match down (idempotent); the transport/socket stays open. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    cancelAnimationFrame(this.rafId);
    clearInterval(this.bgPump);
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    this.engine.stop();
    this.opts.keyboard.detach(window);
    window.removeEventListener('keydown', this.onKey);
    this.opts.renderer.setCountdown(null);
    this.opts.renderer.setSpawnHighlight(null);
    this.muteBtn?.remove();
  }
}
