/**
 * Bot-vs-bot SPECTATOR mode (?mode=spectate). Watch two (or more) AI bots fight
 * with NO human player. Purely additive: ?mode=solo and the online/net path are
 * untouched.
 *
 * Like solo and net, the spectator runs through the SAME LockstepEngine, driven
 * by an in-process LoopbackTransport wrapped by the unified MatchRunner. Every
 * slot is a bot: the runner's nominal local slot (0) is also a bot slot, so the
 * loopback's echoed NO_INPUT is ignored and slot 0's bot brain fills it — no
 * keyboard input ever enters the sim. Math.random() picks the per-match seed
 * only (exactly as solo documents); the sim given that seed stays deterministic.
 *
 * Match config comes from URL params (all with sensible defaults):
 *   ?lineup=2-chaosv,1-gambler  one VERSION-ARCHETYPE token per slot (2..4)
 *   ?map=classic|pirate         arena layout (default classic)
 *   ?speed=1|2|4|8              sim-speed multiplier (default 4); bounded by the
 *                               engine's MAX_TICKS_PER_FRAME cap (~2× a 60fps
 *                               frame), the firm anti-spiral contract.
 *   ?maxTicks=…                 ACCEPTED for compatibility but no longer honored
 *                               as a hard cut: the unified engine runs the sim to
 *                               its own OVER (the sudden-death shrink always ends
 *                               a match well before MATCH_MAX_TICKS).
 *
 * On every match end a running SCOREBOARD (keyed by contestant label) updates,
 * then a fresh match auto-restarts shortly after with a fresh seed.
 */
import { AI_VERSIONS, type BotSpec, type IBotController, LATEST_AI_VERSION } from '../ai';
import { makeFeelParams } from '../config/FeelParams';
import { KeyboardInput } from '../input/KeyboardInput';
import { LoopbackTransport } from '../net/LoopbackTransport';
import { MatchRunner, type MatchBot, type MatchSpec } from '../net/MatchRunner';
import { MsgType, type MatchStartMsg } from '../net/protocolCodec';
import { Renderer } from '../render/Renderer';
import { NO_INPUT, type InputFrame } from '../sim/InputBuffer';
import { MAP_KINDS, type MapKind } from '../sim/Map';

/**
 * Pick a fresh uint32 seed for a match. Using Math.random() here is fine: it
 * only PICKS the seed — the simulation given that seed stays fully deterministic
 * and the spectator has no lockstep partner. (Never use Math.random() inside the
 * sim itself; see sim/Prng.ts.)
 */
const randomSeed = (): number => Math.floor(Math.random() * 0x1_0000_0000) >>> 0;

/**
 * Archetype keys spectate accepts in `?lineup=`. Covers every key across all AI
 * versions: v1/v2 use aggressor/turtle/gambler/chaosv; v3 is the 7-archetype
 * limited-kill roster hunter/farmer/zoner/runner/trapper/reactive/noise. A key a
 * given version doesn't define falls back to that version's difficulty tuning
 * (e.g. 2-trapper → v2 normal).
 */
const ARCHETYPE_KEYS = [
  'aggressor', 'turtle', 'gambler', 'chaosv', 'farmer',
  'hunter', 'zoner', 'runner', 'trapper', 'reactive', 'noise',
] as const;
type ArchetypeKey = (typeof ARCHETYPE_KEYS)[number];

/** Display name per archetype key (note ChaosV's mixed case). */
const ARCHETYPE_LABEL: Readonly<Record<ArchetypeKey, string>> = {
  aggressor: 'Aggressor',
  turtle: 'Turtle',
  gambler: 'Gambler',
  chaosv: 'ChaosV',
  farmer: 'Farmer',
  hunter: 'Hunter',
  zoner: 'Zoner',
  runner: 'Runner',
  trapper: 'Trapper',
  reactive: 'Reactive',
  noise: 'Noise',
};

/** Allowed sim-speed multipliers. */
const SPEEDS = [1, 2, 4, 8] as const;
type Speed = (typeof SPEEDS)[number];

/** A contestant: an AI version paired with an archetype key, plus its label. */
interface Contestant {
  version: number;
  archetypeKey: ArchetypeKey;
  /** "v{ver}-{Archetype}", e.g. "v2-ChaosV". */
  label: string;
}

/** Build a contestant from a version + archetype key, deriving its label. */
function makeContestant(version: number, archetypeKey: ArchetypeKey): Contestant {
  return {
    version,
    archetypeKey,
    label: `v${version}-${ARCHETYPE_LABEL[archetypeKey]}`,
  };
}

/** Build the deterministic bot controller for a contestant in a given slot. */
function makeController(c: Contestant, seed: number, slot: number): IBotController {
  const spec: BotSpec = { difficulty: 'normal', strategyRaw: c.archetypeKey };
  return AI_VERSIONS[c.version]!.createBot(seed, slot, spec);
}

/**
 * Parse a "VERSION-ARCHETYPE" token (e.g. "2-chaosv"). Splits on '-': part 0 is
 * the integer AI version (unknown → LATEST_AI_VERSION), part 1 is the archetype
 * key (unknown/missing → 'aggressor').
 */
function parseToken(token: string): Contestant {
  const parts = token.split('-');
  const verNum = Number.parseInt((parts[0] ?? '').trim(), 10);
  const version =
    Number.isFinite(verNum) && AI_VERSIONS[verNum] !== undefined
      ? verNum
      : LATEST_AI_VERSION;
  const keyRaw = (parts[1] ?? '').trim().toLowerCase();
  const archetypeKey = (ARCHETYPE_KEYS as readonly string[]).includes(keyRaw)
    ? (keyRaw as ArchetypeKey)
    : 'aggressor';
  return makeContestant(version, archetypeKey);
}

/** Parse ?lineup= into 2..4 contestants (default a v2-ChaosV vs v1-Gambler 1v1). */
function parseLineup(raw: string | null): Contestant[] {
  const tokens = (raw ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length < 2) {
    return [parseToken('2-chaosv'), parseToken('1-gambler')];
  }
  return tokens.slice(0, 4).map(parseToken);
}

/** Map kind: ?map=<any registered kind> (case-insensitive); else → classic. */
function parseMapKind(raw: string | null): MapKind {
  const k = (raw ?? '').toLowerCase();
  return MAP_KINDS.includes(k) ? k : 'classic';
}

/** Speed multiplier: ?speed=1|2|4|8; anything else → 4. */
function parseSpeed(raw: string | null): Speed {
  const n = Number.parseInt((raw ?? '').trim(), 10);
  return (SPEEDS as readonly number[]).includes(n) ? (n as Speed) : 4;
}

export async function runSpectate(params: URLSearchParams): Promise<void> {
  // Mutable match config (the on-screen pickers mutate these, then restart()).
  // `lineup` itself is never rebound — the contestant pickers replace its slot
  // entries in place — so it stays const.
  const lineup: Contestant[] = parseLineup(params.get('lineup'));
  let mapKind: MapKind = parseMapKind(params.get('map'));
  let speed: Speed = parseSpeed(params.get('speed'));

  const feel = makeFeelParams();

  // Per-contestant-label running tally + a shared draws/played counter.
  let wins = new Map<string, number>();
  let draws = 0;
  let played = 0;

  const renderer = await Renderer.create();
  const mount = document.getElementById('app');
  if (!mount) {
    throw new Error('#app mount point missing');
  }
  mount.appendChild(renderer.canvas);

  // Render-layer-only HUD bits (never touch the sim).
  const applyHud = (): void => {
    renderer.setSlotLabels(lineup.map((c) => c.label));
    // Spectate is bot-vs-bot: every slot renders as a robot-chef.
    renderer.setBotSlots(new Set(lineup.map((_, slot) => slot)));
    const a = lineup[0]?.label ?? '?';
    const b = lineup[1]?.label ?? '?';
    renderer.setHudHint(`Spectator — ${a} vs ${b}`, false);
  };
  applyHud();

  // ---- Scoreboard panel (top-center) -------------------------------------
  const scoreboard = document.createElement('div');
  scoreboard.style.cssText =
    'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:900;' +
    'padding:6px 16px;background:rgba(61,28,2,0.85);color:#f5e6d3;border-radius:8px;' +
    'font:14px system-ui,sans-serif;white-space:nowrap;text-align:center;';
  document.body.appendChild(scoreboard);

  const renderScoreboard = (): void => {
    const parts = lineup.map((c) => `${c.label}  ${wins.get(c.label) ?? 0}`);
    scoreboard.textContent = `${parts.join('   —   ')}   (draws ${draws}, ${played} played)`;
  };
  renderScoreboard();

  // ---- Config pickers (top-left, same brown style as solo) ----------------
  const pickerCss =
    'position:fixed;left:8px;z-index:900;padding:6px 12px;' +
    'background:rgba(61,28,2,0.85);color:#f5e6d3;border:none;border-radius:8px;' +
    'font:13px system-ui,sans-serif;cursor:pointer;';

  // Every selectable agent = each version × ONLY the archetypes it actually
  // defines (v1/v2: 4 each, v3: 7), so the picker never lists phantom combos
  // that would silently fall back to that version's difficulty tuning.
  const versions = Object.keys(AI_VERSIONS).map(Number).sort((x, y) => x - y);
  const allAgents: Contestant[] = [];
  for (const v of versions) {
    for (const k of AI_VERSIONS[v]!.strategyKeys) {
      allAgents.push(makeContestant(v, k as ArchetypeKey));
    }
  }
  /** Build a <select> of every agent, pre-selecting `current`. */
  const buildAgentPicker = (top: number, current: Contestant): HTMLSelectElement => {
    const sel = document.createElement('select');
    sel.style.cssText = `${pickerCss}top:${top}px;`;
    for (const a of allAgents) {
      const opt = document.createElement('option');
      opt.value = `${a.version}-${a.archetypeKey}`;
      opt.textContent = a.label;
      if (a.version === current.version && a.archetypeKey === current.archetypeKey) {
        opt.selected = true;
      }
      sel.appendChild(opt);
    }
    return sel;
  };

  // Map picker.
  const mapPicker = document.createElement('select');
  mapPicker.style.cssText = `${pickerCss}top:8px;`;
  for (const value of MAP_KINDS) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value.charAt(0).toUpperCase() + value.slice(1);
    if (value === mapKind) opt.selected = true;
    mapPicker.appendChild(opt);
  }
  mapPicker.addEventListener('change', () => {
    mapKind = parseMapKind(mapPicker.value);
    restartFresh();
  });
  document.body.appendChild(mapPicker);

  // Speed picker.
  const speedPicker = document.createElement('select');
  speedPicker.style.cssText = `${pickerCss}top:44px;`;
  for (const s of SPEEDS) {
    const opt = document.createElement('option');
    opt.value = String(s);
    opt.textContent = `${s}×`;
    if (s === speed) opt.selected = true;
    speedPicker.appendChild(opt);
  }
  speedPicker.addEventListener('change', () => {
    speed = parseSpeed(speedPicker.value);
    // Speed alone doesn't change the match outcome, but resetting keeps the
    // scoreboard semantics consistent (a knob change starts a fresh contest).
    restartFresh();
  });
  document.body.appendChild(speedPicker);

  // Two contestant pickers (slot0 / slot1). Even when a URL lineup has >2 slots
  // we expose only the first two (the default/important case is 1v1).
  const slot0Picker = buildAgentPicker(80, lineup[0] ?? makeContestant(LATEST_AI_VERSION, 'aggressor'));
  const slot1Picker = buildAgentPicker(116, lineup[1] ?? makeContestant(LATEST_AI_VERSION, 'aggressor'));
  const onContestantChange = (): void => {
    lineup[0] = parseToken(slot0Picker.value);
    lineup[1] = parseToken(slot1Picker.value);
    restartFresh();
  };
  slot0Picker.addEventListener('change', onContestantChange);
  slot1Picker.addEventListener('change', onContestantChange);
  document.body.appendChild(slot0Picker);
  document.body.appendChild(slot1Picker);

  // ---- Match lifecycle ----------------------------------------------------
  // No human slot at all: the nominal local slot is a PHANTOM index past every
  // real slot (max lineup = 4 → real slots 0..3, phantom = 4). The engine still
  // runs its local input cadence on this slot (warmup + send + echo), but it is
  // never required by the per-slot completeness check and never read into the
  // dense input array, so the loopback's NO_INPUT for it is inert — every real
  // slot is bot-filled inside the engine. (Using a real bot slot would let the
  // send-site's NO_INPUT shadow that bot's brain; the phantom avoids that.)
  const LOCAL_SLOT = 4;
  const transport = new LoopbackTransport(LOCAL_SLOT);
  const keyboard = new KeyboardInput();
  let runner: MatchRunner | null = null;

  /** Build the next match spec (new seed, all-bot lineup) from current config. */
  const rebuild = (): MatchSpec => {
    const seed = randomSeed();
    const bots: MatchBot[] = lineup.map((c, slot) => ({
      slot,
      brain: makeController(c, seed, slot),
    }));
    // FFA: teams omitted → team = slot, last-bot-standing wins (pvp).
    const start: MatchStartMsg = {
      type: MsgType.MATCH_START,
      seed,
      slot: LOCAL_SLOT, // phantom local slot (see above)
      config: feel,
      t0: 0,
      map: mapKind,
    };
    applyHud();
    return { start, numPlayers: lineup.length, bots };
  };

  /** Tally the finished match into the scoreboard (winnerTeam = winnerSlot in
   *  FFA): clean last-bot-standing, or — at the cap — most survivors → item
   *  tiebreak → draw (resolved by the runner via resolveOutcome). */
  const scoreMatch = (winnerTeam: number | null): void => {
    played += 1;
    if (winnerTeam === null) {
      draws += 1;
    } else {
      const label = lineup[winnerTeam]?.label;
      if (label !== undefined) wins.set(label, (wins.get(label) ?? 0) + 1);
    }
    renderScoreboard();
  };

  /** (Re)build the runner from current config (speed/lineup/map). */
  const buildRunner = (): MatchRunner => {
    const initial = rebuild();
    return new MatchRunner({
      transport,
      start: initial.start,
      numPlayers: initial.numPlayers,
      bots: initial.bots,
      renderer,
      keyboard,
      // No human: the phantom local slot is never read, so feed NO_INPUT.
      sampleLocalInput: (): InputFrame => NO_INPUT,
      countdown: false, // spectate skips the intro hold (watch immediately)
      autoRestart: true,
      restartDelayMs: 1500,
      rebuild,
      showMuteButton: false, // spectate has no audio chrome
      speed, // wall-clock multiplier (bounded by the engine tick cap)
      onOver: (_result, _final, winnerTeam) => scoreMatch(winnerTeam),
    });
  };

  /** A config knob changed: reset the scoreboard, tear down + rebuild the runner
   *  (so a new speed takes effect; lineup/map are read by the rebuild factory). */
  function restartFresh(): void {
    wins = new Map<string, number>();
    draws = 0;
    played = 0;
    renderScoreboard();
    runner?.stop();
    runner = buildRunner();
  }

  runner = buildRunner();
}
