/**
 * Offline waiting-room: the "create a room, add bots, play — no relay" half of
 * the unified lobby. It reuses LobbyUI's room view (a dumb, RoomState-driven
 * screen) by feeding it synthetic snapshots and routing the room callbacks here
 * instead of to the relay; on start it runs a fully local match through the
 * unified MatchRunner driven by an in-process LoopbackTransport (the same
 * LockstepEngine as net, client-side sim + bots, no server). Humans-vs-humans
 * still goes through the relay (netMode); this is purely the alone-vs-bots path.
 *
 * Teams are MANUAL per-slot: you are always the host here, so clicking any
 * roster card (yours or a bot's) cycles that slot's team colour. Default =
 * team[slot] = slot (FFA). The map picker + bots + strength layer on top; the
 * resulting per-slot teams feed the loopback MatchStart.
 */
import { GamePhase } from '../../../shared/types';
import { AI_VERSIONS, type BotSpec, type IBotController } from '../ai';
import { asTier, botForTier } from '../ai/botDifficulty';
import { makeFeelParams } from '../config/FeelParams';
import { KeyboardInput } from '../input/KeyboardInput';
import { Renderer } from '../render/Renderer';
import { MAP_KINDS, type MapKind } from '../sim/Map';
import { LoopbackTransport } from './LoopbackTransport';
import { MatchRunner, type MatchBot, type MatchSpec } from './MatchRunner';
import type { LobbyUI } from './LobbyUI';
import { MsgType, type MatchStartMsg, type RoomStateMsg } from './protocolCodec';

const randomSeed = (): number => Math.floor(Math.random() * 0x1_0000_0000) >>> 0;

const MAX_SLOTS = 4;
const HUMAN_SLOT = 0;

/** Short HUD label for a bot tier, e.g. "Hunter v6". */
function botLabel(difficulty: string, map: MapKind): string {
  const { version, archetype } = botForTier(asTier(difficulty), map);
  return `${archetype.charAt(0).toUpperCase()}${archetype.slice(1)} v${version}`;
}

export interface LocalRoomOptions {
  mount: HTMLElement;
  ui: LobbyUI;
  name: string;
  /** Leave the offline room back to the landing screen. */
  onExitToLanding: () => void;
}

export class LocalRoom {
  private readonly mount: HTMLElement;
  private readonly ui: LobbyUI;
  private readonly name: string;
  private readonly onExitToLanding: () => void;

  /** slot -> bot difficulty tier ('easy' | 'normal' | 'hard'). */
  private readonly bots = new Map<number, string>();
  /** Host map pick. */
  private map: MapKind = 'classic';
  /** MANUAL per-slot team assignment: slot -> team (= colour index). Default for
   *  a slot = its own index (FFA). Cycled by clicking a roster card. */
  private readonly teams = new Map<number, number>([[HUMAN_SLOT, HUMAN_SLOT]]);

  private renderer: Renderer | null = null;
  private match: MatchRunner | null = null;
  private keyboard: KeyboardInput | null = null;
  private readonly exitBtn: HTMLButtonElement;

  constructor(opts: LocalRoomOptions) {
    this.mount = opts.mount;
    this.ui = opts.ui;
    this.name = opts.name;
    this.onExitToLanding = opts.onExitToLanding;

    // Floating "leave match" button, shown only while a local match runs (the
    // canvas hides the lobby, so this is the way back to the room).
    this.exitBtn = document.createElement('button');
    this.exitBtn.textContent = '← 離開對戰';
    this.exitBtn.style.cssText =
      'position:fixed;top:8px;left:8px;z-index:950;display:none;padding:6px 14px;' +
      'background:#fff;color:#7A4A2B;border:none;border-radius:999px;' +
      "box-shadow:0 4px 0 #EAD6B8;font:700 13px 'Nunito',system-ui,sans-serif;cursor:pointer;";
    this.exitBtn.addEventListener('click', () => this.endMatch());
    document.body.appendChild(this.exitBtn);
  }

  /** Team for a slot (default = the slot index, FFA). */
  private team(slot: number): number {
    return this.teams.get(slot) ?? slot;
  }

  /** RoomStateMsg snapshot driving LobbyUI.showRoom (host = slot 0). Each entry
   *  carries its manual team so the roster cards render the right colours. */
  private snapshot(): RoomStateMsg {
    const players = [
      {
        slot: HUMAN_SLOT,
        name: this.name,
        ready: false,
        connected: true,
        team: this.team(HUMAN_SLOT),
      },
      ...[...this.bots.entries()].map(([slot, difficulty]) => ({
        slot,
        name: 'CocoaBot',
        ready: true,
        connected: true,
        isBot: true,
        botDifficulty: difficulty,
        team: this.team(slot),
      })),
    ];
    return {
      type: MsgType.ROOM_STATE,
      roomId: '本機練習',
      phase: GamePhase.LOBBY,
      youSlot: HUMAN_SLOT,
      players,
    };
  }

  /** Render the room view + the host map picker. You are always host here, so
   *  every roster card is team-editable (LobbyUI's default predicate). */
  private render(): void {
    this.ui.setTeamEditable(() => true);
    this.ui.showRoom(this.snapshot());
    // Offline: the swatch picker sets the HUMAN's own colour (= team), aligning
    // with the card-click model (it's a shortcut for cycling your own card).
    this.ui.setHostSettings({ map: this.map, color: this.team(HUMAN_SLOT) });
  }

  /** Show the room view. */
  open(): void {
    this.render();
  }

  addBot(slot: number, difficulty: string): void {
    if (slot === HUMAN_SLOT || slot < 0 || slot >= MAX_SLOTS) return;
    this.bots.set(slot, difficulty);
    if (!this.teams.has(slot)) this.teams.set(slot, slot); // default team = slot
    this.render();
  }

  removeBot(slot: number): void {
    if (this.bots.delete(slot)) {
      this.teams.delete(slot);
      this.render();
    }
  }

  setMap(map: string): void {
    if (MAP_KINDS.includes(map)) {
      this.map = map;
      this.render();
    }
  }

  /** Manual team set for a slot (you are host → any occupied slot). team =
   *  colour index 0..MAX_SLOTS-1; ignored for empty slots. */
  setPlayerTeam(slot: number, team: number): void {
    if (!Number.isInteger(team) || team < 0 || team >= MAX_SLOTS) return;
    if (slot !== HUMAN_SLOT && !this.bots.has(slot)) return; // not an occupied slot
    this.teams.set(slot, team);
    this.render();
  }

  /** Offline colour swatch = set the HUMAN's own team colour. */
  setColor(color: number): void {
    this.setPlayerTeam(HUMAN_SLOT, color);
  }

  /** Leave the room entirely (back to landing). */
  leave(): void {
    this.dispose();
    this.onExitToLanding();
  }

  /** Tear down (stop any match, remove DOM). Idempotent. */
  dispose(): void {
    this.match?.stop();
    this.match = null;
    this.keyboard = null;
    this.exitBtn.remove();
    if (this.renderer !== null) {
      this.renderer.canvas.remove();
      this.renderer = null;
    }
  }

  /** Start the local match (the room's "Ready" = start, since nobody to wait on).
   *  Needs at least one bot opponent. Slots are compacted to 0..n-1 so a bot
   *  added to a non-adjacent seat never leaves an inert gap player; each player's
   *  manual team rides along with its compacted slot. */
  async start(): Promise<void> {
    if (this.match !== null) return; // already playing
    const botEntries = [...this.bots.entries()].sort((a, b) => a[0] - b[0]);
    if (botEntries.length === 0) {
      this.ui.setRoomStatus('加一個 Bot 才能開始');
      return;
    }
    const tiers = botEntries.map(([, difficulty]) => difficulty);

    const numPlayers = 1 + tiers.length;
    // Compacted per-slot teams: human at compacted slot 0, bots at 1..n in
    // sorted order; each keeps the team it was assigned in the room view.
    const teams: number[] = [this.team(HUMAN_SLOT)];
    for (const [origSlot] of botEntries) teams.push(this.team(origSlot));
    const feel = makeFeelParams();

    if (this.renderer === null) {
      this.renderer = await Renderer.create();
      this.mount.appendChild(this.renderer.canvas);
    }
    const renderer = this.renderer;
    renderer.canvas.style.display = '';
    this.ui.showMatch();
    this.exitBtn.style.display = '';
    window.addEventListener('keydown', this.onEscape);

    // Build the next match spec from the host settings; re-rolls the seed each
    // time (auto-restart / R). Bots are pre-built deterministic brains per slot
    // (local loopback path → caller supplies the exact controller, like solo).
    // HUD labels/bot-slots are refreshed here so every fresh match shows them.
    const rebuild = (): MatchSpec => {
      const seed = randomSeed();
      const bots: MatchBot[] = tiers.map((difficulty, i) => {
        const slot = i + 1; // human is slot 0
        const rung = botForTier(asTier(difficulty), this.map);
        const spec: BotSpec = { difficulty: 'champion', strategyRaw: rung.archetype };
        const brain: IBotController = AI_VERSIONS[rung.version]!.createBot(seed, slot, spec);
        return { slot, brain };
      });
      const start: MatchStartMsg = {
        type: MsgType.MATCH_START,
        seed,
        slot: HUMAN_SLOT,
        config: feel,
        t0: 0,
        map: this.map,
        teams: teams.slice(),
      };
      renderer.setSlotLabels(['YOU', ...tiers.map((d) => botLabel(d, this.map))]);
      renderer.setHudHint(
        `Solo +${tiers.length} — 方向鍵移動 · 空白鍵放巧克力 · R 重新開始 · Esc 離開`,
        true,
      );
      renderer.setBotSlots(new Set(tiers.map((_, i) => i + 1)));
      return { start, numPlayers, bots };
    };

    const transport = new LoopbackTransport(HUMAN_SLOT);
    this.keyboard = new KeyboardInput();
    const initial = rebuild();
    this.match = new MatchRunner({
      transport,
      start: initial.start,
      numPlayers: initial.numPlayers,
      bots: initial.bots,
      renderer,
      keyboard: this.keyboard,
      countdown: true,
      autoRestart: true, // plays like solo until the player leaves
      rebuild,
      record: 'none',
    });
  }

  /** Esc during a local match returns to the room. */
  private readonly onEscape = (e: KeyboardEvent): void => {
    if (e.code === 'Escape') this.endMatch();
  };

  /** Stop the running match and go back to the room screen. */
  private endMatch(): void {
    if (this.match === null) return;
    this.match.stop();
    this.match = null;
    this.keyboard = null;
    window.removeEventListener('keydown', this.onEscape);
    this.exitBtn.style.display = 'none';
    if (this.renderer !== null) this.renderer.canvas.style.display = 'none';
    this.render();
  }
}
