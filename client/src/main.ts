/**
 * Entry point. Mode switch via URL:
 *   (default)       — online lobby (create / join / quick match); see net/netMode.ts.
 *   ?mode=solo      — solo practice: one human player vs N AI bots (last survivor wins).
 *   ?mode=spectate  — bot-vs-bot spectator: watch AI bots fight (see spectate/spectateMode.ts).
 *
 * Solo runs through the SAME LockstepEngine as net play, driven by an in-process
 * LoopbackTransport (no socket) wrapped by the unified MatchRunner — which owns
 * the rAF loop, the fixed-timestep accumulator, the countdown intro, auto-restart
 * and the loss recorder. This file only parses URL params, builds the picker UI,
 * and hands the MatchRunner a `rebuild` factory that re-reads the current config.
 *
 * Controls — Arrows move · Space drops chocolate · R: start a new random match.
 *
 * Each match uses a FRESH random seed (initial load and every reset), so item
 * drops and bot play vary from match to match. The layout still depends on the
 * chosen MapKind: authored kinds (e.g. 'pirate') look the same every match,
 * while the rolled kind ('classic') also varies with the seed. The R key
 * starts a NEW random match rather than replaying the same one.
 *
 * Feel params (hotseat only): the ⚙ FeelPanel adjusts move speed / corner
 * assist / input buffer. Releasing a slider rebuilds the initial state (an
 * R-reset, never a mid-match swap), which re-rolls the seed too. Online mode
 * never shows the panel — its params come from MatchStart.
 */
import {
  AI_VERSIONS,
  type BotSpec,
  type IBotController,
  LATEST_AI_VERSION,
  parseDifficulty,
} from './ai';
import { championFor } from './ai/mapChampions';
import { sfx } from './audio/Sfx';
import { type FeelParams, makeFeelParams } from './config/FeelParams';
import { KeyboardInput } from './input/KeyboardInput';
import { LoopbackTransport } from './net/LoopbackTransport';
import { MatchRunner, type MatchBot, type MatchSpec } from './net/MatchRunner';
import { runNetMode } from './net/netMode';
import { MsgType, type MatchStartMsg } from './net/protocolCodec';
import { Renderer } from './render/Renderer';
import { MAP_KINDS, type MapKind } from './sim/Map';
import { runSpectate } from './spectate/spectateMode';
import { FeelPanel } from './ui/FeelPanel';
import { runGuide } from './ui/guidePage';

/**
 * Pick a fresh uint32 seed for a solo match. Using Math.random() here is fine:
 * it only PICKS the seed — the simulation given that seed stays fully
 * deterministic. Solo has no lockstep partner, so this never affects netcode.
 * (Never use Math.random() inside the sim itself; see sim/Prng.ts.)
 */
const randomSeed = (): number => Math.floor(Math.random() * 0x1_0000_0000) >>> 0;

async function bootstrapSolo(params: URLSearchParams): Promise<void> {
  // Bot count: default 1 when ?bots is absent; clamped to 0..3 otherwise.
  // Mutable so the bot-count picker can change it; reset() then rebuilds the
  // match with 1 + bots players. numPlayers is computed at each use site.
  const botsRaw = Number(params.get('bots'));
  let bots = !params.has('bots')
    ? 1
    : Number.isNaN(botsRaw)
      ? 1
      : Math.max(0, Math.min(3, Math.trunc(botsRaw)));
  const difficulty = parseDifficulty(params.get('difficulty'));

  // MANUAL per-slot teams (consistent with the net + offline rooms): team[slot]
  // = colour index 0..3. Default = team[i] = i (FFA: everyone on their own team).
  // Edited via the per-slot team pickers (you are always host in solo). Indexed
  // by slot 0..3; only the first numPlayers entries are used. A team array that
  // equals the default [0,1,2,…] is treated as FFA (teams omitted → byte-
  // identical to before).
  const teams: number[] = [0, 1, 2, 3];

  // Named-strategy mode (?strategy=). Independent of difficulty: when a strategy
  // is given, every bot uses the strategy tuning and difficulty is ignored;
  // when absent, bots fall back to the difficulty tuning. Strategy/tuning/name
  // resolution lives in each AI version's module (see ai/index.ts); we just pass
  // the raw spec through. All assignment is fully deterministic (no Math.random)
  // — safe for lockstep.
  //   ?strategy=aggressor|turtle|gambler|chaosv → all bots use that archetype.
  //   ?strategy=mix (or random)                 → each bot cycles a distinct
  //                                               archetype by its bot index.
  //
  // Per-slot AI version (?botVersions=). Comma list, index = slot-1 (slot 1 is
  // the first bot), e.g. ?botVersions=2,1,2. Missing/short/empty entries → the
  // latest version; unknown numbers are clamped to the latest. Default (param
  // absent) → every bot runs the latest version. Version choice is a render/
  // factory concern only; it NEVER enters SimState/stateHash.
  const strategyRaw = (params.get('strategy') ?? '').toLowerCase().trim();
  // Did the user give an EXPLICIT strategy override? Any ?strategy= value
  // (including 'mix'/'random') counts as explicit and must win over the per-map
  // champion default and the bot-strength picker. When absent ('') the
  // bot-strength mode decides (see botMode / effectiveSpec below).
  const explicitStrategy = strategyRaw !== '';

  // Bot-strength mode (on-screen picker, strong → weak): 'champion' uses the
  // current map's matrix-bench champion archetype (ChaosV on classic, Aggressor
  // on pirate; HUD shows the archetype name); 'hard'/'normal'/'easy' use a
  // generic bot on that DIFFICULTY_PRESETS tier (no archetype; HUD shows the
  // tier name). Mutable so the picker can change it; reset() rebuilds the bots.
  // Initial value: when ?strategy= is explicit the picker is disabled and not
  // the controlling input, so default to 'champion'; otherwise honor an explicit
  // ?difficulty= tier, else 'champion'.
  type BotMode = 'champion' | 'easy' | 'normal' | 'hard';
  const initialBotMode = (): BotMode => {
    if (explicitStrategy) return 'champion';
    const d = params.get('difficulty');
    if (d !== null) {
      const v = d.toLowerCase().trim();
      if (v === 'easy' || v === 'normal' || v === 'hard') return v;
      if (v === 'medium') return 'normal'; // player-facing alias for 'normal'.
    }
    return 'champion';
  };
  let botMode: BotMode = initialBotMode();

  // Version-agnostic spec handed to the chosen AI version module per slot. Map-
  // dependent so switching maps re-derives the champion (reset() rebuilds bots).
  // Precedence: an explicit ?strategy= URL archetype wins on every map; else the
  // bot-strength picker decides — 'champion' → the map champion archetype (HUD
  // shows the archetype name); a difficulty tier → empty strategy so
  // tuningForSlot picks that DIFFICULTY_PRESETS tier (HUD shows the tier name).
  const effectiveSpec = (map: MapKind): BotSpec => {
    if (explicitStrategy) return { difficulty, strategyRaw };
    if (botMode === 'champion') {
      return { difficulty, strategyRaw: championFor(map).archetype };
    }
    return { difficulty: botMode, strategyRaw: '' };
  };

  // Parse ?botVersions= into a per-bot-index list of AI version numbers.
  const versionList: number[] = (params.get('botVersions') ?? '')
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10));
  // AI version for an AI slot (1..bots) on a given map. bot index = slot - 1. An
  // explicit ?botVersions= entry wins; otherwise the map champion's version
  // (driven by the champion table, not bare LATEST_AI_VERSION).
  const versionForSlot = (slot: number, map: MapKind): number => {
    const v = versionList[slot - 1];
    return v !== undefined && Number.isFinite(v) && AI_VERSIONS[v] !== undefined
      ? v
      : championFor(map).version;
  };
  // The AI version module driving a given AI slot on a given map.
  const moduleForSlot = (slot: number, map: MapKind): (typeof AI_VERSIONS)[number] =>
    AI_VERSIONS[versionForSlot(slot, map)]!;

  // Render-layer-only slot→label table (index = player slot). slot 0 = human.
  // NEVER goes into SimState/stateHash; consumed solely by the HUD. Rebuilt on
  // every reset() so HUD labels track the current bot count.
  // Bot brain display name for an AI slot (1..N): the chosen version module's
  // name, suffixed with ` vN` when the slot is not on the latest version so a
  // mixed-version match is legible in the HUD (render-only).
  const botName = (slot: number): string => {
    const version = versionForSlot(slot, mapKind);
    const base = AI_VERSIONS[version]!.botNameFor(slot, effectiveSpec(mapKind));
    return version === LATEST_AI_VERSION ? base : `${base} v${version}`;
  };
  // True when any of the active slots share a team (manual teams in play); used
  // to annotate HUD labels with the team number so groupings are legible.
  const teamsActive = (): boolean => {
    const n = 1 + bots;
    return teams.slice(0, n).some((t, i) => t !== i);
  };
  const buildSlotLabels = (): (string | undefined)[] => {
    const grouped = teamsActive();
    const tag = (slot: number): string => (grouped ? ` [T${teams[slot]! + 1}]` : '');
    const labels: (string | undefined)[] = [`YOU${tag(0)}`];
    for (let slot = 1; slot <= bots; slot++) labels.push(`${botName(slot)}${tag(slot)}`);
    return labels;
  };

  // Human-readable label for the current bot-strength mode (render-only). For
  // 'champion' it appends the map's champion archetype display name (e.g.
  // "Champion (ChaosV)"); for a difficulty tier it shows the capitalized tier
  // (e.g. "Hard"). An explicit ?strategy= override (picker disabled) shows the
  // archetype name driving every bot instead.
  const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
  const buildStrengthLabel = (): string => {
    if (explicitStrategy) {
      return AI_VERSIONS[championFor(mapKind).version]!.botNameFor(1, effectiveSpec(mapKind));
    }
    if (botMode === 'champion') {
      const champName = AI_VERSIONS[championFor(mapKind).version]!.botNameFor(
        1,
        effectiveSpec(mapKind),
      );
      return `Champion (${champName})`;
    }
    return cap(botMode);
  };

  // Render-layer-only HUD hint text. Rebuilt on every reset() so the bot count
  // and bot-strength mode shown track the current picker selections.
  const buildHint = (): string => {
    if (bots === 0) return 'Solo — Arrows move · Space drops chocolate';
    const teamNote = teamsActive() ? ' · 隊伍已分組' : '';
    return `Solo +${bots} AI (${buildStrengthLabel()})${teamNote} — Arrows move · Space drops chocolate`;
  };

  // Map kind: ?map=<any registered kind> (case-insensitive); else → classic.
  const parseMapKind = (raw: string | null): MapKind => {
    const k = (raw ?? '').toLowerCase();
    return MAP_KINDS.includes(k) ? k : 'classic';
  };
  let mapKind: MapKind = parseMapKind(params.get('map'));

  let feel: FeelParams = makeFeelParams();

  const keyboard = new KeyboardInput();

  const renderer = await Renderer.create();
  const mount = document.getElementById('app');
  if (!mount) {
    throw new Error('#app mount point missing');
  }
  mount.appendChild(renderer.canvas);

  let audioUnlocked = false;

  // Build the next match spec from the CURRENT picker config. Re-reads every
  // mutable (bots/teams/map/feel) + re-rolls the seed, so a picker change or R
  // just calls runner.restart(). Bots are pre-built deterministic brains (slot
  // 1..N): solo is local, so the loopback path supplies the exact controller per
  // slot (any archetype/version) rather than a net strength tier. HUD labels are
  // refreshed here so a changed bot count shows on the very next match.
  const rebuild = (): MatchSpec => {
    const seed = randomSeed();
    const numPlayers = 1 + bots;
    const botSpecs: MatchBot[] = [];
    for (let slot = 1; slot <= bots; slot++) {
      const brain: IBotController = moduleForSlot(slot, mapKind).createBot(
        seed,
        slot,
        effectiveSpec(mapKind),
      );
      botSpecs.push({ slot, brain });
    }
    // Manual per-slot teams (first numPlayers entries). Omit when they equal the
    // default [0,1,…] so an untouched FFA solo match stays byte-identical.
    const slotTeams = teams.slice(0, numPlayers);
    const isDefault = slotTeams.every((t, i) => t === i);
    const start: MatchStartMsg = {
      type: MsgType.MATCH_START,
      seed,
      slot: 0, // human is always slot 0 in solo
      config: feel,
      t0: 0,
      map: mapKind,
      ...(isDefault ? {} : { teams: slotTeams }),
    };
    renderer.setSlotLabels(buildSlotLabels());
    renderer.setHudHint(buildHint(), true);
    return { start, numPlayers, bots: botSpecs };
  };

  const transport = new LoopbackTransport(0);
  const initial = rebuild();
  const runner = new MatchRunner({
    transport,
    start: initial.start,
    numPlayers: initial.numPlayers,
    bots: initial.bots,
    renderer,
    keyboard,
    countdown: true,
    autoRestart: true, // R + ~2.5s after OVER → a fresh random match
    rebuild,
    record: 'aiLoss', // persist + log a replay when the human (vs AI) wins
    showMuteButton: false, // main.ts keeps its own candy-styled mute button
  });

  /** Start a NEW random match (R-reset / feel apply / map change / auto-restart). */
  const reset = (): void => runner.restart();

  // Unlock audio on first user gesture.
  const unlockAudio = (): void => {
    if (audioUnlocked) return;
    audioUnlocked = true;
    sfx.resumeContext();
    soundHint.style.display = 'none';
  };

  // First key/click hides the sound hint + unlocks audio. R-to-restart is owned
  // by the MatchRunner (autoRestart) so it isn't handled here (avoids a double
  // restart); this listener is purely the audio-unlock UI cue.
  window.addEventListener('keydown', unlockAudio);
  window.addEventListener('click', unlockAudio, { once: false });

  // Mute toggle button.
  const muteBtn = document.createElement('button');
  muteBtn.style.cssText =
    'position:fixed;top:8px;right:8px;z-index:900;padding:6px 12px;' +
    'background:#fff;color:#7A4A2B;border:none;border-radius:999px;' +
    "box-shadow:0 4px 0 #EAD6B8;font:700 13px 'Nunito',system-ui,sans-serif;cursor:pointer;";
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
    'background:#fff;color:#7A4A2B;border:none;border-radius:999px;' +
    "box-shadow:0 4px 0 #EAD6B8;font:700 13px 'Nunito',system-ui,sans-serif;cursor:pointer;";
  const mapOptions: ReadonlyArray<readonly [MapKind, string]> = MAP_KINDS.map(
    (k) => [k, k.charAt(0).toUpperCase() + k.slice(1)] as const,
  );
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

  // Solo bot-count picker (second row, below the map picker; top-right stays the
  // mute button). Changing it starts a new random match with 1 + N players.
  const botPicker = document.createElement('select');
  botPicker.style.cssText =
    'position:fixed;top:44px;left:8px;z-index:900;padding:6px 12px;' +
    'background:#fff;color:#7A4A2B;border:none;border-radius:999px;' +
    "box-shadow:0 4px 0 #EAD6B8;font:700 13px 'Nunito',system-ui,sans-serif;cursor:pointer;";
  for (let n = 0; n <= 3; n++) {
    const opt = document.createElement('option');
    opt.value = String(n);
    opt.textContent = n === 1 ? '1 Bot' : `${n} Bots`;
    if (n === bots) opt.selected = true;
    botPicker.appendChild(opt);
  }
  botPicker.addEventListener('change', () => {
    bots = Math.max(0, Math.min(3, Math.trunc(Number(botPicker.value))));
    renderTeamPickers(); // active-slot count changed → re-render team selects
    reset();
  });
  document.body.appendChild(botPicker);

  // Solo per-slot TEAM pickers (third row): one tiny colour <select> per active
  // slot (you = slot 0, bots = 1..N). Manual teams — picking a colour groups
  // teammates (consistent with the net/offline rooms; you are always host).
  // Re-rendered when the bot count changes; a change rebuilds the match.
  const teamRow = document.createElement('div');
  teamRow.style.cssText =
    'position:fixed;top:80px;left:8px;z-index:900;display:flex;gap:6px;align-items:center;';
  const TEAM_LABELS = ['🍓', '🍃', '🍮', '🫐']; // 4 team colours (palette 0..3)
  const renderTeamPickers = (): void => {
    teamRow.textContent = '';
    const tag = document.createElement('span');
    tag.style.cssText =
      "font:700 12px 'Nunito',system-ui,sans-serif;color:#7A4A2B;" +
      'background:#fff;padding:6px 8px;border-radius:999px;box-shadow:0 4px 0 #EAD6B8;';
    tag.textContent = '隊伍';
    teamRow.appendChild(tag);
    for (let slot = 0; slot <= bots; slot++) {
      const sel = document.createElement('select');
      sel.style.cssText =
        'padding:6px 8px;background:#fff;color:#7A4A2B;border:none;border-radius:999px;' +
        "box-shadow:0 4px 0 #EAD6B8;font:700 12px 'Nunito',system-ui,sans-serif;cursor:pointer;";
      sel.title = slot === 0 ? '你的隊伍' : `Bot ${slot} 的隊伍`;
      for (let t = 0; t < TEAM_LABELS.length; t++) {
        const opt = document.createElement('option');
        opt.value = String(t);
        opt.textContent = `${slot === 0 ? 'YOU' : `B${slot}`} ${TEAM_LABELS[t]}`;
        if (teams[slot] === t) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.addEventListener('change', () => {
        teams[slot] = Math.max(0, Math.min(3, Math.trunc(Number(sel.value))));
        reset();
      });
      teamRow.appendChild(sel);
    }
  };
  renderTeamPickers();
  document.body.appendChild(teamRow);

  // Solo bot-strength picker (fourth row, below the team pickers). One dropdown
  // strong → weak: 'Champion' uses the current map's champion archetype (stays
  // map-reactive via reset() → effectiveSpec(mapKind)); the difficulty tiers run
  // a generic bot on that DIFFICULTY_PRESETS tier. Disabled when ?strategy= is
  // explicit (that URL override wins over the picker on every map).
  const strengthPicker = document.createElement('select');
  strengthPicker.style.cssText =
    'position:fixed;top:116px;left:8px;z-index:900;padding:6px 12px;' +
    'background:#fff;color:#7A4A2B;border:none;border-radius:999px;' +
    "box-shadow:0 4px 0 #EAD6B8;font:700 13px 'Nunito',system-ui,sans-serif;cursor:pointer;";
  const strengthOptions: ReadonlyArray<readonly [BotMode, string]> = [
    ['champion', "Champion (map's best)"],
    ['hard', 'Hard'],
    ['normal', 'Medium'],
    ['easy', 'Easy'],
  ];
  for (const [value, label] of strengthOptions) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    if (value === botMode) opt.selected = true;
    strengthPicker.appendChild(opt);
  }
  strengthPicker.addEventListener('change', () => {
    botMode = strengthPicker.value as BotMode;
    reset();
  });
  document.body.appendChild(strengthPicker);
  // Grey + disable when an explicit ?strategy= override is controlling the bots.
  // Static (explicitStrategy is fixed for the session), so applied once here.
  if (explicitStrategy) {
    strengthPicker.disabled = true;
    strengthPicker.style.opacity = '0.4';
  }

  // "Click anywhere to enable sound" hint.
  const soundHint = document.createElement('div');
  soundHint.style.cssText =
    'position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:900;' +
    "padding:6px 16px;background:rgba(255,255,255,.85);color:#A07C56;font-weight:700;" +
    "font:700 12px 'Nunito',system-ui,sans-serif;border-radius:999px;" +
    'box-shadow:0 3px 0 #EAD6B8;pointer-events:none;';
  soundHint.textContent = 'Click anywhere to enable sound';
  document.body.appendChild(soundHint);

  // Feel-params panel (hotseat only; see the header comment). Applying it swaps
  // the feel, then restarts the match (an R-reset, never a mid-match swap) — the
  // rebuild factory reads the new `feel`.
  const feelPanel = new FeelPanel();
  feelPanel.onApply = (next) => {
    feel = next;
    reset();
  };
  document.body.appendChild(feelPanel.root);

  // The MatchRunner (constructed above) owns the rAF loop, countdown, recorder
  // and auto-restart; nothing left to drive here.
}

const params = new URLSearchParams(window.location.search);
// Default mode when ?mode= is absent. Normally the online lobby, but a static
// deploy with no relay (e.g. GitHub Pages, practice-only) sets
// VITE_DEFAULT_MODE=solo at build time so the homepage lands on offline
// practice instead of a lobby that can never connect. Dev/serve builds leave
// the env unset → unchanged online-lobby default.
const mode = params.get('mode') ?? import.meta.env.VITE_DEFAULT_MODE ?? null;
if (mode === 'spectate') {
  void runSpectate(params);
} else if (mode === 'solo') {
  void bootstrapSolo(params);
} else if (mode === 'guide') {
  runGuide();
} else {
  // Default (and ?mode=net) → online lobby.
  void runNetMode(params);
}
