/**
 * Offline waiting-room: the "create a room, add bots, play — no relay" half of
 * the unified lobby. It reuses LobbyUI's room view (a dumb, RoomState-driven
 * screen) by feeding it synthetic snapshots and routing the room callbacks here
 * instead of to the relay; on start it runs a fully local match via
 * runLocalMatch (client-side sim + bots, no server). Humans-vs-humans still goes
 * through the relay (netMode); this is purely the alone-vs-bots path.
 *
 * MVP scope (#1): FFA on the classic map, add/remove bots, start, return. The
 * host settings (map / 1v2·1v3·2v2 / strength) and seat-colour picking layer on
 * top in later tasks (#2/#3); the match runner already takes arbitrary teams.
 */
import { GamePhase } from '../../../shared/types';
import { AI_VERSIONS, type BotSpec, type IBotController } from '../ai';
import { asTier, botForTier } from '../ai/botDifficulty';
import { makeFeelParams } from '../config/FeelParams';
import { Renderer } from '../render/Renderer';
import { MAP_KINDS, type MapKind } from '../sim/Map';
import { type LocalMatchConfig, type LocalMatchHandle, runLocalMatch } from '../solo/localMatch';
import type { LobbyUI } from './LobbyUI';
import { MsgType, type RoomStateMsg } from './protocolCodec';

const MAX_SLOTS = 4;
const HUMAN_SLOT = 0;

/** Team format → fixed bot count required (null = FFA, any count ≥1). */
type Format = 'ffa' | '1v2' | '1v3' | '2v2';
const FORMAT_LABEL: Record<Format, string> = {
  ffa: 'Free For All',
  '1v2': '1 vs 2',
  '1v3': '1 vs 3',
  '2v2': '2v2',
};
function requiredBots(format: Format): number | null {
  return format === 'ffa' ? null : format === '1v2' ? 2 : 3;
}

/** Per-slot team/palette ids (compacted: human slot 0, bots slots 1..n). The
 *  team id IS the body-palette index (teamPalette), so the human shows their
 *  chosen `color`; teammates share it and the enemy side takes a distinct hue.
 *  FFA gives every player a distinct colour (still all-vs-all). */
function teamsForColor(format: Format, color: number, numBots: number): readonly number[] {
  const enemy = (color + 2) % 4; // opposite-ish hue, visually distinct
  switch (format) {
    case 'ffa': {
      const others = [0, 1, 2, 3].filter((c) => c !== color);
      return [color, ...Array.from({ length: numBots }, (_, i) => others[i % others.length]!)];
    }
    case '1v2':
      return [color, enemy, enemy];
    case '1v3':
      return [color, enemy, enemy, enemy];
    case '2v2':
      return [color, enemy, enemy, color]; // you + slot-3 ally vs slots 1,2
  }
}

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
  /** Host settings (room pickers). */
  private map: MapKind = 'classic';
  private format: Format = 'ffa';
  /** The player's chosen body-palette index (= their team colour). */
  private color = 0;

  private renderer: Renderer | null = null;
  private match: LocalMatchHandle | null = null;
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

  /** RoomStateMsg snapshot driving LobbyUI.showRoom (host = slot 0). */
  private snapshot(): RoomStateMsg {
    const players = [
      { slot: HUMAN_SLOT, name: this.name, ready: false, connected: true, color: this.color },
      ...[...this.bots.entries()].map(([slot, difficulty]) => ({
        slot,
        name: 'CocoaBot',
        ready: true,
        connected: true,
        isBot: true,
        botDifficulty: difficulty,
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

  /** Render the room view + the host-settings row (offline-only). */
  private render(): void {
    this.ui.showRoom(this.snapshot());
    this.ui.setHostSettings({ map: this.map, format: this.format, color: this.color });
    // Proactively flag a fixed-format bot-count mismatch (showRoom set a generic
    // status; override it so the host knows how many bots the format wants).
    const req = requiredBots(this.format);
    if (req !== null && this.bots.size !== req) {
      this.ui.setRoomStatus(
        `${FORMAT_LABEL[this.format]} 需要 ${req} 個 Bot（目前 ${this.bots.size}）`,
      );
    }
  }

  /** Show the room view. */
  open(): void {
    this.render();
  }

  addBot(slot: number, difficulty: string): void {
    if (slot === HUMAN_SLOT || slot < 0 || slot >= MAX_SLOTS) return;
    this.bots.set(slot, difficulty);
    this.render();
  }

  removeBot(slot: number): void {
    if (this.bots.delete(slot)) this.render();
  }

  setMap(map: string): void {
    if (MAP_KINDS.includes(map)) {
      this.map = map;
      this.render();
    }
  }

  setFormat(format: string): void {
    if (format === 'ffa' || format === '1v2' || format === '1v3' || format === '2v2') {
      this.format = format;
      this.render();
    }
  }

  setColor(color: number): void {
    if (Number.isInteger(color) && color >= 0 && color < 4) {
      this.color = color;
      this.render();
    }
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
    this.exitBtn.remove();
    if (this.renderer !== null) {
      this.renderer.canvas.remove();
      this.renderer = null;
    }
  }

  /** Start the local match (the room's "Ready" = start, since nobody to wait on).
   *  Needs at least one bot opponent. Slots are compacted to 0..n-1 so a bot
   *  added to a non-adjacent seat never leaves an inert gap player. */
  async start(): Promise<void> {
    if (this.match !== null) return; // already playing
    const tiers = [...this.bots.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, difficulty]) => difficulty);
    if (tiers.length === 0) {
      this.ui.setRoomStatus('加一個 Bot 才能開始');
      return;
    }
    // Fixed formats need an exact bot count; FFA takes any.
    const req = requiredBots(this.format);
    if (req !== null && tiers.length !== req) {
      this.ui.setRoomStatus(`${FORMAT_LABEL[this.format]} 需要 ${req} 個 Bot（目前 ${tiers.length}）`);
      return;
    }

    const numPlayers = 1 + tiers.length;
    const config: LocalMatchConfig = {
      map: this.map,
      feel: makeFeelParams(),
      numPlayers,
      teams: teamsForColor(this.format, this.color, tiers.length),
      buildBots: (seed): ReadonlyArray<IBotController | null> => {
        const arr: (IBotController | null)[] = new Array(numPlayers).fill(null);
        tiers.forEach((difficulty, i) => {
          const slot = i + 1; // human is slot 0
          const rung = botForTier(asTier(difficulty), this.map);
          const spec: BotSpec = { difficulty: 'champion', strategyRaw: rung.archetype };
          arr[slot] = AI_VERSIONS[rung.version]!.createBot(seed, slot, spec);
        });
        return arr;
      },
      slotLabels: ['YOU', ...tiers.map((d) => botLabel(d, this.map))],
      hudHint: `Solo +${tiers.length} — 方向鍵移動 · 空白鍵放巧克力 · R 重新開始 · Esc 離開`,
      botSlots: new Set(tiers.map((_, i) => i + 1)),
      humanSlot: HUMAN_SLOT,
    };

    if (this.renderer === null) {
      this.renderer = await Renderer.create();
      this.mount.appendChild(this.renderer.canvas);
    }
    this.renderer.canvas.style.display = '';
    this.ui.showMatch();
    this.exitBtn.style.display = '';
    window.addEventListener('keydown', this.onEscape);

    this.match = runLocalMatch(this.renderer, config, {
      autoRestart: true, // plays like solo until the player leaves
      recordLoss: false,
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
    window.removeEventListener('keydown', this.onEscape);
    this.exitBtn.style.display = 'none';
    if (this.renderer !== null) this.renderer.canvas.style.display = 'none';
    this.ui.showRoom(this.snapshot());
  }
}
