/**
 * Sfx: Web Audio API synthesiser for all in-game sound effects.
 *
 * All sounds are 100% procedurally generated — no external audio files.
 * AudioContext is created lazily on the first call to resumeContext() (called
 * on first user gesture) so browsers never block autoplay.
 *
 * Mute state is persisted in localStorage under the key "choccus_muted".
 * A master GainNode lets every sound honour the mute flag without per-sound
 * branching (gain is set to 0 when muted).
 */

const STORAGE_KEY = 'choccus_muted';

class SfxEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private _muted: boolean;

  constructor() {
    // Read persisted mute state; default to unmuted.
    const stored = localStorage.getItem(STORAGE_KEY);
    this._muted = stored === 'true';
  }

  // ---------------------------------------------------------------------------
  // Context bootstrap
  // ---------------------------------------------------------------------------

  /** Call once on the first user gesture (click / keydown) to unlock audio. */
  resumeContext(): void {
    if (this.ctx === null) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this._muted ? 0 : 1;
      this.master.connect(this.ctx.destination);
    } else if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
  }

  private ensure(): AudioContext | null {
    if (this.ctx === null) return null; // not yet unlocked — silent
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  // ---------------------------------------------------------------------------
  // Mute controls
  // ---------------------------------------------------------------------------

  get muted(): boolean {
    return this._muted;
  }

  setMuted(muted: boolean): void {
    this._muted = muted;
    localStorage.setItem(STORAGE_KEY, String(muted));
    if (this.master !== null) {
      this.master.gain.setTargetAtTime(muted ? 0 : 1, this.ctx!.currentTime, 0.01);
    }
  }

  /** Toggle mute and return the new state. */
  toggleMute(): boolean {
    this.setMuted(!this._muted);
    return this._muted;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Create an OscillatorNode + GainNode chain connected to master, already
   * started. Returns [osc, env].
   */
  private osc(
    type: OscillatorType,
    freq: number,
    when: number,
  ): [OscillatorNode, GainNode] {
    const ctx = this.ctx!;
    const gain = ctx.createGain();
    gain.connect(this.master!);
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    o.connect(gain);
    o.start(when);
    return [o, gain];
  }

  /**
   * Create a white-noise buffer source connected through a BiquadFilter to
   * master. Returns [src, filter, env].
   */
  private noise(
    filterType: BiquadFilterType,
    freq: number,
    when: number,
    duration: number,
  ): [AudioBufferSourceNode, BiquadFilterNode, GainNode] {
    const ctx = this.ctx!;
    const bufLen = Math.ceil(ctx.sampleRate * duration) + 1024;
    const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buf;

    const filt = ctx.createBiquadFilter();
    filt.type = filterType;
    filt.frequency.value = freq;

    const env = ctx.createGain();

    src.connect(filt);
    filt.connect(env);
    env.connect(this.master!);
    src.start(when);
    return [src, filt, env];
  }

  // ---------------------------------------------------------------------------
  // SFX methods
  // ---------------------------------------------------------------------------

  /**
   * place() — soft "plop".
   * Quick low sine pitch-drop + tiny noise burst.
   * 60 ms total.
   */
  place(): void {
    const ctx = this.ensure();
    if (ctx === null) return;
    const t = ctx.currentTime;

    // Sine blip: 220 Hz → 100 Hz over 50 ms.
    const [osc, env] = this.osc('sine', 220, t);
    osc.frequency.setTargetAtTime(100, t, 0.02);
    env.gain.setValueAtTime(0.35, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    osc.stop(t + 0.07);

    // Short noise tick.
    const [, , nEnv] = this.noise('bandpass', 800, t, 0.04);
    nEnv.gain.setValueAtTime(0.08, t);
    nEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
  }

  /**
   * explode() — long wet cream squeeze "噗嘰~~~".
   * Deliberately noise-dominated (wet/airy, barely tonal) so it reads as piped
   * cream, not electronics: a soft low "噗" body + a gentle TRIANGLE squeak that
   * bends up then eases down (the "嘰~", NO buzzy flutter LFO) + a lowpass-noise
   * "ffff" spray sweeping down. Softer + longer (~0.85 s) than the old sawtooth.
   */
  explode(): void {
    const ctx = this.ensure();
    if (ctx === null) return;
    const t = ctx.currentTime;
    const dur = 0.85; // drawn-out 噗嘰~~~

    // Soft squish body "噗": low sine plop leads the squeeze, gives it weight.
    const [sub, sEnv] = this.osc('sine', 95, t);
    sub.frequency.exponentialRampToValueAtTime(42, t + 0.35);
    sEnv.gain.setValueAtTime(0.3, t);
    sEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    sub.stop(t + 0.42);

    // Squeeze squeak "嘰~": a SOFT triangle (not buzzy sawtooth, no flutter LFO).
    // Bends up as cream is forced out, then eases down. Kept quiet so the wet
    // noise dominates → squelchy and organic, not tonal/electronic.
    const [osc, oEnv] = this.osc('triangle', 130, t);
    osc.frequency.setValueAtTime(130, t);
    osc.frequency.linearRampToValueAtTime(240, t + 0.12);
    osc.frequency.exponentialRampToValueAtTime(85, t + dur);
    oEnv.gain.setValueAtTime(0.0, t);
    oEnv.gain.linearRampToValueAtTime(0.18, t + 0.05);
    oEnv.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.stop(t + dur + 0.02);

    // Wet airy "ffff" spray: LOWPASS noise (rounder/wetter than bandpass), centre
    // sweeping down as the cream eases out — this is the bulk of the sound.
    const [, nFilt, nEnv] = this.noise('lowpass', 1500, t, dur);
    nFilt.frequency.setValueAtTime(1500, t);
    nFilt.frequency.exponentialRampToValueAtTime(240, t + dur);
    nFilt.Q.value = 0.7;
    nEnv.gain.setValueAtTime(0.0, t);
    nEnv.gain.linearRampToValueAtTime(0.22, t + 0.04);
    nEnv.gain.exponentialRampToValueAtTime(0.001, t + dur);
  }

  /**
   * trap() — glassy/icy chime for shell crystallise.
   * High triangle wave + ring modulation (carrier × AM oscillator).
   * 400 ms total.
   */
  trap(): void {
    const ctx = this.ensure();
    if (ctx === null) return;
    const t = ctx.currentTime;

    // Carrier: triangle at 1200 Hz.
    const [carrier, cEnv] = this.osc('triangle', 1200, t);
    cEnv.gain.setValueAtTime(0.4, t);
    cEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    carrier.stop(t + 0.36);

    // Ring-mod AM at 440 Hz multiplied against carrier via a gain node.
    const amOsc = ctx.createOscillator();
    amOsc.type = 'sine';
    amOsc.frequency.value = 440;
    const amGain = ctx.createGain();
    amGain.gain.value = 0; // starts silent — AM modulates
    amOsc.connect(amGain.gain);
    carrier.connect(amGain);
    amGain.connect(this.master!);
    amOsc.start(t);
    amOsc.stop(t + 0.36);

    // High sparkle overlay: 2400 Hz triangle.
    const [osc2, env2] = this.osc('triangle', 2400, t);
    env2.gain.setValueAtTime(0.15, t);
    env2.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    osc2.stop(t + 0.21);
  }

  /**
   * rescue() — bright rising arpeggio (4 notes).
   * C5→E5→G5→C6, each 80 ms.
   */
  rescue(): void {
    const ctx = this.ensure();
    if (ctx === null) return;
    const t = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    notes.forEach((freq, i) => {
      const start = t + i * 0.07;
      const [osc, env] = this.osc('triangle', freq, start);
      env.gain.setValueAtTime(0.28, start);
      env.gain.exponentialRampToValueAtTime(0.001, start + 0.1);
      osc.stop(start + 0.11);
    });
  }

  /**
   * item() — short pleasant two-note ding.
   * E5 → A5, each ~100 ms.
   */
  item(): void {
    const ctx = this.ensure();
    if (ctx === null) return;
    const t = ctx.currentTime;
    const pairs: [number, number][] = [
      [659.25, t],
      [880.0, t + 0.08],
    ];
    for (const [freq, start] of pairs) {
      const [osc, env] = this.osc('triangle', freq, start);
      env.gain.setValueAtTime(0.25, start);
      env.gain.exponentialRampToValueAtTime(0.001, start + 0.12);
      osc.stop(start + 0.13);
    }
  }

  /**
   * eliminate() — dull crack for shell-break / elimination.
   * Mid-frequency bandpass noise burst with a low thud.
   * 200 ms total.
   */
  eliminate(): void {
    const ctx = this.ensure();
    if (ctx === null) return;
    const t = ctx.currentTime;

    // Crack noise.
    const [, , nEnv] = this.noise('bandpass', 1200, t, 0.2);
    nEnv.gain.setValueAtTime(0.45, t);
    nEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.18);

    // Dull thud.
    const [osc, oEnv] = this.osc('sine', 120, t);
    osc.frequency.setTargetAtTime(50, t, 0.04);
    oEnv.gain.setValueAtTime(0.35, t);
    oEnv.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    osc.stop(t + 0.16);
  }

  /**
   * win() — short major-key jingle (5 notes ascending).
   * C5→E5→G5→C6→E6, each 120 ms.
   */
  win(): void {
    const ctx = this.ensure();
    if (ctx === null) return;
    const t = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5, 1318.51]; // C5 E5 G5 C6 E6
    notes.forEach((freq, i) => {
      const start = t + i * 0.1;
      const [osc, env] = this.osc('triangle', freq, start);
      env.gain.setValueAtTime(0.3, start);
      env.gain.exponentialRampToValueAtTime(0.001, start + 0.18);
      osc.stop(start + 0.19);
    });
  }

  /**
   * lose() — short minor-key jingle (4 notes descending).
   * A4→F4→D4→A3, each 140 ms.
   */
  lose(): void {
    const ctx = this.ensure();
    if (ctx === null) return;
    const t = ctx.currentTime;
    const notes = [440.0, 349.23, 293.66, 220.0]; // A4 F4 D4 A3
    notes.forEach((freq, i) => {
      const start = t + i * 0.12;
      const [osc, env] = this.osc('triangle', freq, start);
      env.gain.setValueAtTime(0.3, start);
      env.gain.exponentialRampToValueAtTime(0.001, start + 0.2);
      osc.stop(start + 0.21);
    });
  }
}

/** Singleton sfx engine — import and call methods directly. */
export const sfx = new SfxEngine();
