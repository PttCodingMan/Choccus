/**
 * Entry point. Mode switch via URL:
 *   (default)   — online lobby (create / join / quick match); see net/netMode.ts.
 *   ?mode=solo  — solo practice: one human player vs N AI bots (last survivor wins).
 *
 * Solo mode owns ALL wall-clock timing: a rAF loop with a fixed-timestep
 * accumulator. The sim only ever receives whole ticks; rendering interpolates
 * between the last two states with alpha = acc / TICK_MS.
 *
 * Controls — Arrows move · Space drops chocolate · R: start a new random match.
 *
 * Each match uses a FRESH random seed (initial load and every reset), so item
 * drops and bot play vary from match to match. The layout still depends on the
 * chosen MapKind: authored kinds (e.g. 'pirate') look the same every match,
 * while rolled kinds ('classic' / 'open') also vary with the seed. The R key
 * starts a NEW random match rather than replaying the same one.
 *
 * Feel params (hotseat only): the ⚙ FeelPanel adjusts move speed / corner
 * assist / input buffer. Releasing a slider rebuilds the initial state (an
 * R-reset, never a mid-match swap), which re-rolls the seed too. Online mode
 * never shows the panel — its params come from MatchStart.
 */
import { TICK_MS } from '../../shared/constants';
import { BotController } from './ai/BotController';
import { botSeed, parseDifficulty, tuningFor } from './ai/BotConfig';
import { matchSound } from './audio/MatchSound';
import { sfx } from './audio/Sfx';
import { type FeelParams, makeFeelParams } from './config/FeelParams';
import { KeyboardInput } from './input/KeyboardInput';
import { sampleLocalInput } from './input/InputMapper';
import { runNetMode } from './net/netMode';
import { Renderer } from './render/Renderer';
import { type InputFrame, NO_INPUT } from './sim/InputBuffer';
import type { MapKind } from './sim/Map';
import { type SimState, createInitialState, tick } from './sim/Sim';
import { FeelPanel } from './ui/FeelPanel';

/**
 * Pick a fresh uint32 seed for a solo match. Using Math.random() here is fine:
 * it only PICKS the seed — the simulation given that seed stays fully
 * deterministic. Solo has no lockstep partner, so this never affects netcode.
 * (Never use Math.random() inside the sim itself; see sim/Prng.ts.)
 */
const randomSeed = (): number => Math.floor(Math.random() * 0x1_0000_0000) >>> 0;

/** Clamp big frame gaps (tab switch, breakpoint) to avoid a spiral of death. */
const MAX_FRAME_MS = 250;

async function bootstrapSolo(params: URLSearchParams): Promise<void> {
  // Bot count: default 1 when ?bots is absent; clamped to 0..3 otherwise.
  const botsRaw = Number(params.get('bots'));
  const bots = !params.has('bots')
    ? 1
    : Number.isNaN(botsRaw)
      ? 1
      : Math.max(0, Math.min(3, Math.trunc(botsRaw)));
  const difficulty = parseDifficulty(params.get('difficulty'));
  const numPlayers = 1 + bots;

  // Map kind: ?map=classic|open|pirate (case-insensitive); anything else → classic.
  const parseMapKind = (raw: string | null): MapKind => {
    switch (raw?.toLowerCase()) {
      case 'open':
        return 'open';
      case 'pirate':
        return 'pirate';
      default:
        return 'classic';
    }
  };
  let mapKind: MapKind = parseMapKind(params.get('map'));

  let feel: FeelParams = makeFeelParams();
  // Current match seed — re-rolled on every reset() so each match plays out
  // differently (item drops + bot play). buildBots / createInitialState below
  // read this current value.
  let seed = randomSeed();
  // team = slot (default): the human is team 0 vs each bot on its own team;
  // last survivor wins.
  let cur: SimState = createInitialState(seed, feel, numPlayers, {
    pvp: true,
    map: mapKind,
  });
  let prev: SimState = cur;

  // Deterministic bot brains, one per AI slot (1..bots). Reads the current
  // match seed at call time → bots re-derive from the new seed each match.
  const buildBots = (): BotController[] => {
    const arr: BotController[] = [];
    for (let slot = 1; slot <= bots; slot++) {
      arr.push(new BotController(botSeed(seed, slot), tuningFor(difficulty), slot));
    }
    return arr;
  };
  let botControllers = buildBots();

  const keyboard = new KeyboardInput();
  keyboard.attach(window);

  const renderer = await Renderer.create();
  renderer.setHudHint(
    bots > 0
      ? `Solo +${bots} AI (${difficulty}) — Arrows move · Space drops chocolate`
      : 'Solo — Arrows move · Space drops chocolate',
    true,
  );
  const mount = document.getElementById('app');
  if (!mount) {
    throw new Error('#app mount point missing');
  }
  mount.appendChild(renderer.canvas);

  let acc = 0;
  let last: number | undefined;
  let audioUnlocked = false;

  /** Start a NEW random match (R-reset / feel apply / map change). */
  const reset = (): void => {
    // Re-roll first so buildBots() and createInitialState() see the new seed.
    seed = randomSeed();
    botControllers = buildBots();
    // team = slot (default): human team 0 vs each bot on its own team.
    cur = createInitialState(seed, feel, numPlayers, {
      pvp: true,
      map: mapKind,
    });
    prev = cur;
    acc = 0;
  };

  // Unlock audio on first user gesture.
  const unlockAudio = (): void => {
    if (audioUnlocked) return;
    audioUnlocked = true;
    sfx.resumeContext();
    soundHint.style.display = 'none';
  };

  // R = reset: start a new random match (fresh seed).
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    unlockAudio();
    if (e.code === 'KeyR') reset();
  });
  window.addEventListener('click', unlockAudio, { once: false });

  // Mute toggle button.
  const muteBtn = document.createElement('button');
  muteBtn.style.cssText =
    'position:fixed;top:8px;right:8px;z-index:900;padding:6px 12px;' +
    'background:rgba(61,28,2,0.85);color:#f5e6d3;border:none;border-radius:8px;' +
    'font:13px system-ui,sans-serif;cursor:pointer;';
  const updateMuteBtn = (): void => {
    muteBtn.textContent = sfx.muted ? '🔇 Muted' : '🔊 Sound On';
  };
  updateMuteBtn();
  muteBtn.addEventListener('click', () => {
    sfx.toggleMute();
    updateMuteBtn();
  });
  document.body.appendChild(muteBtn);

  // Solo map picker (top-left; mute button is top-right). Changing it starts a
  // new random match with the chosen layout.
  const mapPicker = document.createElement('select');
  mapPicker.style.cssText =
    'position:fixed;top:8px;left:8px;z-index:900;padding:6px 12px;' +
    'background:rgba(61,28,2,0.85);color:#f5e6d3;border:none;border-radius:8px;' +
    'font:13px system-ui,sans-serif;cursor:pointer;';
  const mapOptions: ReadonlyArray<readonly [MapKind, string]> = [
    ['classic', 'Classic'],
    ['open', 'Open'],
    ['pirate', 'Pirate'],
  ];
  for (const [value, label] of mapOptions) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    if (value === mapKind) opt.selected = true;
    mapPicker.appendChild(opt);
  }
  mapPicker.addEventListener('change', () => {
    mapKind = parseMapKind(mapPicker.value);
    reset();
  });
  document.body.appendChild(mapPicker);

  // "Click anywhere to enable sound" hint.
  const soundHint = document.createElement('div');
  soundHint.style.cssText =
    'position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:900;' +
    'padding:5px 14px;background:rgba(61,28,2,0.75);color:#f5e6d3;' +
    'font:12px system-ui,sans-serif;border-radius:999px;pointer-events:none;';
  soundHint.textContent = 'Click anywhere to enable sound';
  document.body.appendChild(soundHint);

  // Feel-params panel (hotseat only; see the header comment).
  const feelPanel = new FeelPanel();
  feelPanel.onApply = (next) => {
    feel = next;
    reset();
  };
  document.body.appendChild(feelPanel.root);

  const frame = (now: number): void => {
    const dt = last === undefined ? 0 : Math.min(now - last, MAX_FRAME_MS);
    last = now;
    acc += dt;

    while (acc >= TICK_MS) {
      const inputs: InputFrame[] = [sampleLocalInput(keyboard)];
      for (let slot = 1; slot <= bots; slot++) {
        const c = botControllers[slot - 1];
        inputs.push(c ? c.sample(cur, slot) : NO_INPUT);
      }
      const prevTick = cur;
      prev = cur;
      cur = tick(cur, inputs);
      matchSound.tick(prevTick, cur);
      acc -= TICK_MS;
    }

    renderer.render(prev, cur, acc / TICK_MS);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

const params = new URLSearchParams(window.location.search);
if (params.get('mode') === 'solo') {
  void bootstrapSolo(params);
} else {
  // Default (and ?mode=net) → online lobby.
  void runNetMode(params);
}
