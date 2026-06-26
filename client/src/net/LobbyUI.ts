/**
 * LobbyUI: DOM screens for the online flow (M5). Pure view — it renders
 * lobby state and forwards button presses through the on* callbacks; all
 * decisions live in netMode.ts (orchestrator) + NetLobby.ts (state).
 *
 * Screens (one visible at a time, plus two in-match elements):
 *   landing       name + room-code inputs, Create / Join / Quick Match;
 *   room          room code + copy-invite-link, roster, Ready toggle;
 *   disconnected  connection-lost notice + manual Reconnect;
 *   result        post-match Victory/Defeat panel, Rematch / Back to room;
 *   matchNotice   small in-match banner (player disconnected, stall, desync).
 *
 * Visual language = the "milk-cream" (牛奶奶油) candy world shared with the
 * arena (render/candyArt.ts): cream panels, Baloo 2 / Nunito fonts, and the
 * SAME chef-hat blob characters (playerHtml) in the roster cards — so the
 * lobby and the match read as one game, not two. All original assets per the
 * clean-room rules in CLAUDE.md.
 */
import { playerHtml, TEAM_PALETTE, TW } from '../render/candyArt';
import { sfx } from '../audio/Sfx';
import { MAP_KINDS } from '../sim/Map';
import type { RoomStateMsg, RoomPlayer } from './protocolCodec';

const FONT = "'Nunito',system-ui,sans-serif";
const FONT_HEAD = "'Baloo 2',system-ui,sans-serif";

// Milk-cream candy palette — aligned with candyArt.ts MILK / TEAM_PALETTE.
const PALETTE = {
  card: 'linear-gradient(180deg,#FFFDF8,#FFF3DC)', // cream panel
  cardBorder: 'rgba(214,170,110,0.45)',
  text: '#5B3B1E', // deep cocoa
  soft: '#9A7B53', // muted caramel
  accent: '#7A4A2B', // heading ink
  mint: '#4FAF94', // ready / positive
  mintBg: 'rgba(127,209,185,0.22)',
  button: '#F2DFBC', // soft cream button
  buttonInk: '#7A4A2B',
  primary: 'linear-gradient(180deg,#F2B765,#E8A24A)', // caramel CTA
  danger: '#D85F7C', // strawberry
  input: '#FFFDF8',
  inputBorder: 'rgba(201,156,99,0.55)',
};

// Avatar geometry: candyArt draws the blob around the tile-centre origin (CX).
const AV_CX = TW / 2; // 24

// One slot per spawn corner of the 15x13 map (= sim Map.SPAWN_CORNERS.length).
const ROOM_SLOTS = 4;

/** Display label for a bot strength tier. */
function tierLabel(tier: string | undefined): string {
  return tier === 'easy' ? 'Easy' : tier === 'hard' ? 'Hard' : 'Normal';
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  css: string,
  parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.style.cssText = css;
  parent?.appendChild(node);
  return node;
}

function card(parent: HTMLElement): HTMLDivElement {
  return el(
    'div',
    [
      'display:none',
      'min-width:340px',
      'max-width:420px',
      'padding:24px 28px',
      `background:${PALETTE.card}`,
      `color:${PALETTE.text}`,
      `font:600 14px/1.5 ${FONT}`,
      `border:2px solid ${PALETTE.cardBorder}`,
      'border-radius:20px',
      'box-shadow:0 14px 36px rgba(150,108,58,0.22),inset 0 2px 4px rgba(255,255,255,0.8)',
    ].join(';'),
    parent,
  );
}

function heading(parent: HTMLElement, text: string): HTMLDivElement {
  const h = el(
    'div',
    `font:800 22px ${FONT_HEAD};color:${PALETTE.accent};margin-bottom:14px;`,
    parent,
  );
  h.textContent = text;
  return h;
}

function button(
  parent: HTMLElement,
  label: string,
  bg: string = PALETTE.button,
): HTMLButtonElement {
  const b = el(
    'button',
    [
      'display:inline-block',
      'margin:4px 8px 4px 0',
      'padding:9px 18px',
      `background:${bg}`,
      `color:${PALETTE.buttonInk}`,
      `font:700 14px ${FONT_HEAD}`,
      'border:none',
      'border-radius:12px',
      'cursor:pointer',
      'box-shadow:0 3px 0 rgba(150,108,58,0.28),inset 0 1px 1px rgba(255,255,255,0.7)',
      'transition:filter .12s,transform .06s',
    ].join(';'),
    parent,
  );
  b.textContent = label;
  b.addEventListener('mouseenter', () => (b.style.filter = 'brightness(1.06)'));
  b.addEventListener('mouseleave', () => (b.style.filter = ''));
  b.addEventListener('mousedown', () => (b.style.transform = 'translateY(1px)'));
  b.addEventListener('mouseup', () => (b.style.transform = ''));
  return b;
}

function input(parent: HTMLElement, placeholder: string): HTMLInputElement {
  const i = el(
    'input',
    [
      'display:block',
      'width:100%',
      'box-sizing:border-box',
      'margin:4px 0 12px',
      'padding:9px 12px',
      `background:${PALETTE.input}`,
      `color:${PALETTE.text}`,
      `font:600 14px ${FONT}`,
      `border:2px solid ${PALETTE.inputBorder}`,
      'border-radius:10px',
      'outline:none',
    ].join(';'),
    parent,
  );
  i.placeholder = placeholder;
  return i;
}

function label(parent: HTMLElement, text: string): void {
  const l = el('div', `font:600 12px ${FONT};color:${PALETTE.soft};`, parent);
  l.textContent = text;
}

/** A small labelled <select> column (host room settings). */
function labeledSelect(
  parent: HTMLElement,
  labelText: string,
  options: ReadonlyArray<readonly [string, string]>,
): HTMLSelectElement {
  const col = el('div', 'display:flex;flex-direction:column;gap:3px;', parent);
  label(col, labelText);
  const sel = el(
    'select',
    'padding:6px 8px;border-radius:10px;cursor:pointer;' +
      `background:${PALETTE.input};color:${PALETTE.text};font:700 12px ${FONT_HEAD};` +
      `border:2px solid ${PALETTE.inputBorder};outline:none;`,
    col,
  );
  for (const [value, text] of options) {
    const opt = el('option', '', sel);
    opt.value = value;
    opt.textContent = text;
  }
  return sel;
}

export class LobbyUI {
  readonly root: HTMLDivElement;

  // -- orchestrator callbacks --------------------------------------------------
  onCreateRoom?: (name: string) => void;
  onJoinRoom?: (name: string, roomId: string) => void;
  onQuickMatch?: (name: string) => void;
  onReadyToggle?: (ready: boolean) => void;
  onAddBot?: (slot: number, difficulty: string) => void;
  onRemoveBot?: (slot: number) => void;
  onLeaveRoom?: () => void;
  onRematch?: () => void;
  onBackToRoom?: () => void;
  onReconnect?: () => void;
  /** Enter the offline single-player practice mode. */
  onSolo?: () => void;
  /** Open the illustrated how-to-play guide page. */
  onGuide?: () => void;
  /** Start the OAuth login flow for a provider (navigates away). */
  onLogin?: (provider: 'discord' | 'google') => void;
  /** Clear the stored session (stay on the landing screen). */
  onLogout?: () => void;
  /** Host map pick (offline LocalRoom + net host; map picker hidden otherwise). */
  onSelectMap?: (map: string) => void;
  /** Manual team assignment: a roster card was clicked → cycle `slot` to
   *  `nextTeam` (the team after its current one, wrapping 0..MAX-1). */
  onCycleTeam?: (slot: number, nextTeam: number) => void;
  /** Offline seat colour swatch picked (offline LocalRoom only). */
  onSelectColor?: (color: number) => void;
  /** Build the shareable invite URL for a room id (injected by netMode). */
  buildInviteUrl?: (roomId: string) => string;

  // -- landing ------------------------------------------------------------------
  private readonly landing: HTMLDivElement;
  private readonly authRow: HTMLDivElement;
  private loginEnabled = true;
  private readonly leaderboardEl: HTMLDivElement;
  private readonly leaderboardRows: HTMLDivElement;
  private readonly nameInput: HTMLInputElement;
  private readonly roomInput: HTMLInputElement;
  private readonly landingStatus: HTMLDivElement;
  private readonly soundToggleBtn: HTMLButtonElement;
  private readonly soundHintEl: HTMLSpanElement;

  // -- room ---------------------------------------------------------------------
  private readonly roomScreen: HTMLDivElement;
  private readonly roomCode: HTMLSpanElement;
  private readonly copyBtn: HTMLButtonElement;
  private readonly hostSettingsEl: HTMLDivElement;
  private readonly mapSelect: HTMLSelectElement;
  private readonly colorCol: HTMLDivElement;
  private readonly colorSwatches: HTMLButtonElement[] = [];
  private readonly rosterEl: HTMLDivElement;
  private readonly roomStatus: HTMLDivElement;
  private readonly readyBtn: HTMLButtonElement;
  private localReady = false;
  private currentRoomId = '';
  /** DDA-suggested bot tier; pre-selects empty-seat pickers. */
  private suggestedBotTier = 'normal';
  private lastRoomState: RoomStateMsg | null = null;
  /** Whether a roster card's team may be cycled by the local client. Default:
   *  every card editable (offline LocalRoom — you are host). Net narrows it to
   *  host:any / non-host:own via setTeamEditable. */
  private teamEditable: (slot: number) => boolean = () => true;

  // -- disconnected ---------------------------------------------------------------
  private readonly discScreen: HTMLDivElement;
  private readonly discMessage: HTMLDivElement;
  private readonly reconnectBtn: HTMLButtonElement;

  // -- result ---------------------------------------------------------------------
  private readonly resultPanel: HTMLDivElement;
  private readonly resultTitle: HTMLDivElement;
  private readonly resultDetail: HTMLDivElement;
  private readonly resultStatus: HTMLDivElement;

  // -- in-match notice --------------------------------------------------------------
  private readonly noticeEl: HTMLDivElement;

  constructor() {
    this.root = el('div', 'display:flex;justify-content:center;');

    // --- landing ---
    // Use a wider card for the polished landing screen.
    this.landing = el(
      'div',
      [
        'display:none',
        'min-width:380px',
        'max-width:460px',
        'padding:32px 34px 28px',
        `background:${PALETTE.card}`,
        `color:${PALETTE.text}`,
        `font:600 14px/1.5 ${FONT}`,
        `border:2px solid ${PALETTE.cardBorder}`,
        'border-radius:24px',
        'box-shadow:0 18px 48px rgba(150,108,58,0.28),inset 0 2px 5px rgba(255,255,255,0.85)',
      ].join(';'),
      this.root,
    );

    // Big game-title with caramel gradient (Baloo 2, like the arena HUD).
    const titleEl = el(
      'div',
      [
        `font:800 40px ${FONT_HEAD}`,
        'letter-spacing:-0.5px',
        'margin-bottom:2px',
        'background:linear-gradient(135deg,#F2B765 0%,#E8A24A 42%,#C57E25 72%,#7A4A2B 100%)',
        '-webkit-background-clip:text',
        '-webkit-text-fill-color:transparent',
        'background-clip:text',
        'line-height:1.1',
      ].join(';'),
      this.landing,
    );
    titleEl.textContent = '奶油啵啵爆';

    // Tagline.
    const taglineEl = el(
      'div',
      `font:700 13px ${FONT};letter-spacing:2px;color:${PALETTE.soft};margin-bottom:20px;text-transform:uppercase;`,
      this.landing,
    );
    taglineEl.textContent = 'Place. Melt. Escape.';

    // Divider.
    el(
      'div',
      `height:2px;background:linear-gradient(90deg,transparent,${PALETTE.cardBorder},transparent);margin-bottom:18px;`,
      this.landing,
    );

    // Account row (login buttons / logged-in pill). Filled by setAuthName().
    this.authRow = el('div', 'margin-bottom:16px;', this.landing);
    this.setAuthName(null);

    label(this.landing, 'Your name');
    this.nameInput = input(this.landing, 'Player0000');
    this.nameInput.maxLength = 16;
    label(this.landing, 'Room code (leave blank to create a new room)');
    this.roomInput = input(this.landing, 'e.g. QK7PD');
    this.roomInput.maxLength = 16;
    const row = el('div', 'margin-top:8px;display:flex;flex-wrap:wrap;gap:4px;', this.landing);
    button(row, 'Create Room', PALETTE.primary).addEventListener('click', () =>
      this.onCreateRoom?.(this.nameValue()),
    );
    button(row, 'Join Room').addEventListener('click', () =>
      this.onJoinRoom?.(this.nameValue(), this.roomInput.value.trim()),
    );
    button(row, 'Quick Match').addEventListener('click', () =>
      this.onQuickMatch?.(this.nameValue()),
    );
    this.landingStatus = el(
      'div',
      `margin-top:12px;min-height:18px;font:600 13px ${FONT};color:${PALETTE.soft};`,
      this.landing,
    );

    // Offline room: create a room, add bots, play — no relay (see net/LocalRoom).
    const soloRow = el('div', 'margin-top:4px;', this.landing);
    button(soloRow, '🍫 開房間 (vs Bot)').addEventListener('click', () =>
      this.onSolo?.(),
    );
    button(soloRow, '📖 玩法介紹').addEventListener('click', () =>
      this.onGuide?.(),
    );

    // Leaderboard panel (filled by setLeaderboard once the relay replies;
    // hidden until then / when unreachable).
    this.leaderboardEl = el(
      'div',
      `display:none;margin-top:16px;padding-top:14px;border-top:2px solid ${PALETTE.cardBorder};`,
      this.landing,
    );
    const lbTitle = el(
      'div',
      `font:800 14px ${FONT_HEAD};color:${PALETTE.text};margin-bottom:8px;`,
      this.leaderboardEl,
    );
    lbTitle.textContent = '🏆 天梯 Top 10';
    this.leaderboardRows = el('div', 'display:flex;flex-direction:column;gap:3px;', this.leaderboardEl);

    // Sound toggle + "click to enable" hint.
    const soundRow = el('div', 'margin-top:16px;display:flex;align-items:center;gap:10px;', this.landing);
    this.soundToggleBtn = el(
      'button',
      [
        'padding:6px 14px',
        `background:${PALETTE.button}`,
        `color:${PALETTE.buttonInk}`,
        'border:none',
        'border-radius:10px',
        `font:700 12px ${FONT_HEAD}`,
        'cursor:pointer',
        'box-shadow:0 2px 0 rgba(150,108,58,0.28)',
      ].join(';'),
      soundRow,
    );
    this.updateSoundBtn();
    this.soundToggleBtn.addEventListener('click', () => {
      sfx.resumeContext();
      sfx.toggleMute();
      this.updateSoundBtn();
      this.soundHintEl.style.display = 'none';
    });
    this.soundHintEl = el(
      'span',
      `font:600 11px ${FONT};color:${PALETTE.soft};opacity:0.85;`,
      soundRow,
    );
    this.soundHintEl.textContent = 'Click anywhere to enable sound';
    // Hide hint after first click anywhere.
    window.addEventListener('click', () => {
      sfx.resumeContext();
      this.soundHintEl.style.display = 'none';
    }, { once: true });

    // --- room ---
    this.roomScreen = card(this.root);
    this.roomScreen.style.minWidth = '380px';
    this.roomScreen.style.maxWidth = '460px';
    heading(this.roomScreen, 'Room');
    const codeRow = el('div', 'margin:-6px 0 14px;display:flex;align-items:center;', this.roomScreen);
    this.roomCode = el(
      'span',
      `font:800 26px ${FONT_HEAD};letter-spacing:3px;color:${PALETTE.accent};margin-right:12px;`,
      codeRow,
    );
    this.copyBtn = button(codeRow, 'Copy invite link');
    this.copyBtn.addEventListener('click', () => this.copyInviteLink());

    // Host-only settings: the map picker (offline LocalRoom + net host). Teams
    // are MANUAL per-slot — click a roster card to cycle its team colour (see
    // showRoom / rosterCard); there is no format picker. Hidden by default
    // (showRoom hides it; setHostSettings re-shows it).
    this.hostSettingsEl = el(
      'div',
      'display:none;gap:10px;margin-bottom:12px;flex-wrap:wrap;',
      this.roomScreen,
    );
    this.mapSelect = labeledSelect(
      this.hostSettingsEl,
      '地圖',
      MAP_KINDS.map((k) => [k, k.charAt(0).toUpperCase() + k.slice(1)] as const),
    );
    this.mapSelect.addEventListener('change', () => this.onSelectMap?.(this.mapSelect.value));

    // Colour picker: one swatch per body palette; the chosen one = the player's
    // own team/colour in the match (see net/LocalRoom). Offline-room only —
    // hidden in relay rooms, where each player sets their team by clicking cards.
    this.colorCol = el('div', 'display:flex;flex-direction:column;gap:3px;', this.hostSettingsEl);
    const colorCol = this.colorCol;
    label(colorCol, '顏色');
    const swatchRow = el('div', 'display:flex;gap:6px;', colorCol);
    TEAM_PALETTE.forEach((pal, i) => {
      const sw = el(
        'button',
        `width:26px;height:26px;border-radius:50%;cursor:pointer;padding:0;` +
          `background:linear-gradient(165deg,${pal.hi},${pal.base} 58%,${pal.lo});` +
          `border:3px solid transparent;box-shadow:0 2px 0 rgba(150,108,58,0.28);`,
        swatchRow,
      );
      sw.addEventListener('click', () => this.onSelectColor?.(i));
      this.colorSwatches.push(sw);
    });

    this.rosterEl = el('div', 'margin-bottom:10px;', this.roomScreen);
    this.roomStatus = el(
      'div',
      `min-height:18px;font:600 13px ${FONT};color:${PALETTE.soft};margin-bottom:10px;`,
      this.roomScreen,
    );
    this.readyBtn = button(this.roomScreen, 'Ready', PALETTE.primary);
    this.readyBtn.addEventListener('click', () =>
      this.onReadyToggle?.(!this.localReady),
    );
    button(this.roomScreen, 'Leave').addEventListener('click', () =>
      this.onLeaveRoom?.(),
    );

    // --- disconnected ---
    this.discScreen = card(this.root);
    heading(this.discScreen, 'Disconnected');
    this.discMessage = el('div', 'margin-bottom:14px;', this.discScreen);
    this.reconnectBtn = button(this.discScreen, 'Reconnect', PALETTE.primary);
    this.reconnectBtn.addEventListener('click', () => this.onReconnect?.());

    // --- result panel (fixed overlay above the canvas) ---
    this.resultPanel = el(
      'div',
      [
        'display:none',
        'position:fixed',
        'top:50%',
        'left:50%',
        'transform:translate(-50%,-50%)',
        'z-index:1200',
        'min-width:300px',
        'padding:24px 28px',
        `background:${PALETTE.card}`,
        `color:${PALETTE.text}`,
        `font:600 14px/1.5 ${FONT}`,
        `border:2px solid ${PALETTE.cardBorder}`,
        'border-radius:20px',
        'box-shadow:0 16px 44px rgba(150,108,58,0.3),inset 0 2px 5px rgba(255,255,255,0.85)',
        'text-align:center',
      ].join(';'),
    );
    this.resultTitle = el(
      'div',
      `font:800 26px ${FONT_HEAD};color:${PALETTE.accent};margin-bottom:6px;`,
      this.resultPanel,
    );
    this.resultDetail = el('div', 'margin-bottom:12px;', this.resultPanel);
    const resultRow = el('div', '', this.resultPanel);
    button(resultRow, 'Rematch', PALETTE.primary).addEventListener('click', () =>
      this.onRematch?.(),
    );
    button(resultRow, 'Back to room').addEventListener('click', () =>
      this.onBackToRoom?.(),
    );
    this.resultStatus = el(
      'div',
      `margin-top:10px;min-height:18px;font:600 13px ${FONT};color:${PALETTE.soft};`,
      this.resultPanel,
    );
    document.body.appendChild(this.resultPanel);

    // --- in-match notice pill ---
    this.noticeEl = el(
      'div',
      [
        'display:none',
        'position:fixed',
        'top:10px',
        'left:50%',
        'transform:translateX(-50%)',
        'z-index:1100',
        'padding:7px 16px',
        `background:${PALETTE.danger}`,
        'color:#FFF',
        `font:700 13px ${FONT_HEAD}`,
        'border-radius:999px',
        'box-shadow:0 4px 14px rgba(216,95,124,0.45)',
      ].join(';'),
    );
    document.body.appendChild(this.noticeEl);
  }

  // -- input access ----------------------------------------------------------------

  setName(name: string): void {
    this.nameInput.value = name;
  }

  /** Current name-field value (trimmed; 'Player' if blank). */
  getName(): string {
    return this.nameValue();
  }

  /** Hide the whole account row (OAuth disabled until the apps are live). When
   *  false, setAuthName renders nothing. Call before setAuthName. */
  setLoginEnabled(enabled: boolean): void {
    this.loginEnabled = enabled;
  }

  /** Render the account row: logged-in pill + Logout, or the provider buttons.
   *  `name` null = logged out. (Discord/Google login navigates the page away.) */
  setAuthName(name: string | null): void {
    this.authRow.replaceChildren();
    if (!this.loginEnabled) return; // OAuth off → no account UI at all
    if (name !== null) {
      const who = el('div', `font:700 13px ${FONT};color:${PALETTE.text};margin-bottom:4px;`, this.authRow);
      who.textContent = `🔓 已登入：${name}`;
      button(this.authRow, '登出').addEventListener('click', () => this.onLogout?.());
      return;
    }
    const hint = el('div', `font:600 12px ${FONT};color:${PALETTE.soft};margin-bottom:4px;`, this.authRow);
    hint.textContent = '登入以保留評分（跨裝置；可略過直接玩）';
    button(this.authRow, 'Discord 登入', '#5865F2').addEventListener('click', () =>
      this.onLogin?.('discord'),
    );
    button(this.authRow, 'Google 登入').addEventListener('click', () => this.onLogin?.('google'));
  }

  /** Render the lobby leaderboard. null = couldn't load (hide the panel);
   *  [] = no games yet (show a note). Rows are pre-labelled by netMode (bot ids
   *  resolved to friendly archetype names there). */
  setLeaderboard(
    rows: ReadonlyArray<{ label: string; score: number; games: number; isBot: boolean }> | null,
  ): void {
    if (rows === null) {
      this.leaderboardEl.style.display = 'none';
      return;
    }
    this.leaderboardEl.style.display = 'block';
    this.leaderboardRows.replaceChildren();
    if (rows.length === 0) {
      const empty = el('div', `font:600 12px ${FONT};color:${PALETTE.soft};`, this.leaderboardRows);
      empty.textContent = '尚無線上對戰紀錄';
      return;
    }
    rows.forEach((r, i) => {
      const row = el('div', 'display:flex;align-items:center;gap:8px;', this.leaderboardRows);
      const rank = el(
        'div',
        `width:20px;text-align:right;font:800 13px ${FONT_HEAD};color:${PALETTE.soft};`,
        row,
      );
      rank.textContent = `${i + 1}`;
      const nameEl = el(
        'div',
        `flex:1;min-width:0;font:700 13px ${FONT};color:${PALETTE.text};` +
          'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
        row,
      );
      nameEl.textContent = r.label;
      const scoreEl = el('div', `font:800 13px ${FONT_HEAD};color:${PALETTE.primary};`, row);
      scoreEl.textContent = r.score.toFixed(1);
    });
  }

  setRoomId(roomId: string): void {
    this.roomInput.value = roomId;
  }

  /**
   * Show + sync the host-settings row (the map picker). null = leave it hidden.
   * Call AFTER showRoom (which hides it by default). Two shapes:
   *  - offline LocalRoom: `{ map, color }` — the seat colour swatches are shown
   *    and the map picker is enabled (the lone player is always host).
   *  - net relay room: `{ map, host }` — the colour picker is hidden (net teams
   *    are set by clicking roster cards) and the map picker is enabled only for
   *    the host; a non-host sees the host's current map reflected but locked.
   * Teams themselves are rendered on the roster cards (see showRoom), not here.
   */
  setHostSettings(
    opts:
      | { map: string; color: number }
      | { map: string; host: boolean }
      | null,
  ): void {
    if (opts === null) {
      this.hostSettingsEl.style.display = 'none';
      return;
    }
    this.mapSelect.value = opts.map;
    const offline = 'color' in opts;
    const enabled = offline || opts.host;
    this.mapSelect.disabled = !enabled;
    this.mapSelect.style.opacity = enabled ? '1' : '0.55';
    this.mapSelect.style.cursor = enabled ? 'pointer' : 'not-allowed';
    // Colour swatches are offline-only (per-seat colour pick).
    this.colorCol.style.display = offline ? 'flex' : 'none';
    if (offline) {
      this.colorSwatches.forEach((sw, i) => {
        sw.style.borderColor = i === opts.color ? PALETTE.text : 'transparent';
      });
    }
    this.hostSettingsEl.style.display = 'flex';
  }

  /** Set the predicate gating which roster cards the local client may re-team
   *  (host: any slot; non-host: own slot only). Net calls this before showRoom;
   *  offline leaves the default (every card editable). */
  setTeamEditable(predicate: (slot: number) => boolean): void {
    this.teamEditable = predicate;
  }

  /** Pre-select this tier in empty-seat "+ Bot" pickers (from local DDA). */
  setSuggestedTier(tier: string): void {
    this.suggestedBotTier = tier;
    // Re-render the room so empty seats pick up the new default.
    if (this.roomScreen.style.display !== 'none' && this.lastRoomState !== null) {
      this.showRoom(this.lastRoomState);
    }
  }

  private nameValue(): string {
    return this.nameInput.value.trim() || 'Player';
  }

  private updateSoundBtn(): void {
    this.soundToggleBtn.textContent = sfx.muted ? '🔇 Muted' : '🔊 Sound On';
  }

  // -- screens ------------------------------------------------------------------------

  showLanding(status: string = ''): void {
    this.showOnly(this.landing);
    this.landingStatus.textContent = status;
  }

  setLandingStatus(status: string): void {
    this.landingStatus.textContent = status;
  }

  /** Override the room status line (e.g. an offline-room format hint). */
  setRoomStatus(text: string): void {
    this.roomStatus.textContent = text;
  }

  /** Show/refresh the room view from a RoomState snapshot. */
  showRoom(state: RoomStateMsg): void {
    this.showOnly(this.roomScreen);
    this.lastRoomState = state;
    this.currentRoomId = state.roomId;
    this.roomCode.textContent = state.roomId;
    // Host settings are offline-room only; relay rooms re-render via showRoom
    // without re-showing them. LocalRoom re-shows them after each showRoom.
    this.hostSettingsEl.style.display = 'none';

    // Always render all 4 slots: occupied ones show the player/bot card, empty
    // ones offer "+ Bot".
    this.rosterEl.textContent = '';
    for (let slot = 0; slot < ROOM_SLOTS; slot++) {
      const p = state.players.find((q) => q.slot === slot);
      this.rosterEl.appendChild(
        p === undefined ? this.emptySlotCard(slot) : this.rosterCard(p, state.youSlot),
      );
    }

    this.localReady =
      state.players.find((p) => p.slot === state.youSlot)?.ready ?? false;
    this.readyBtn.textContent = this.localReady ? 'Cancel ready' : 'Ready';
    this.readyBtn.style.background = this.localReady
      ? PALETTE.button
      : PALETTE.primary;

    const present = state.players.filter((p) => p.connected);
    this.roomStatus.textContent =
      present.length < 2
        ? 'Waiting for players… share the invite link! (2+ players to start)'
        : present.every((p) => p.ready)
          ? 'Everyone ready — starting…'
          : 'Waiting for everyone to ready up…';
  }

  /** A slot row shell shared by player/bot/empty cards. */
  private slotRow(bg: string, border: string): HTMLDivElement {
    return el(
      'div',
      [
        'display:flex',
        'align-items:center',
        'gap:12px',
        'padding:6px 12px 6px 8px',
        'margin-bottom:8px',
        'border-radius:16px',
        `background:${bg}`,
        `border:2px solid ${border}`,
      ].join(';'),
    );
  }

  /** A candy-blob avatar (chef-hat cutie for humans, robot-chef for bots). */
  private avatar(colorIdx: number, isBot: boolean, dim: boolean): HTMLDivElement {
    const av = el('div', 'position:relative;width:50px;height:58px;flex:0 0 auto;', undefined);
    if (dim) {
      av.style.opacity = '0.4';
      av.style.filter = 'grayscale(0.6)';
    }
    const o = el('div', `position:absolute;left:${25 - AV_CX}px;top:36px;`, av);
    o.innerHTML = playerHtml(colorIdx, isBot, 0, 0);
    return av;
  }

  /** One roster row = chef-hat cutie (human) or robot-chef (bot) + name + pill.
   *  The card is tinted by + clickable to cycle its TEAM colour when the local
   *  client may edit this slot (host: any; non-host: own). */
  private rosterCard(p: RoomPlayer, youSlot: number): HTMLDivElement {
    const you = p.slot === youSlot;
    const ready = p.connected && p.ready;
    const team = p.team ?? p.slot;
    const teamCol = TEAM_PALETTE[team % TEAM_PALETTE.length] ?? TEAM_PALETTE[0];
    const editable = this.teamEditable(p.slot);
    const row = this.slotRow(
      ready ? PALETTE.mintBg : 'rgba(255,255,255,0.5)',
      // Border carries the team colour so grouped teammates read at a glance.
      teamCol.base,
    );
    // A team-coloured left stripe reinforces the grouping beyond the border.
    row.style.borderLeft = `6px solid ${teamCol.lo}`;

    // Click the card to cycle this slot's team (next palette colour, wrapping).
    if (editable) {
      row.style.cursor = 'pointer';
      row.title = '點擊切換隊伍顏色';
      row.addEventListener('click', () => {
        const next = (team + 1) % TEAM_PALETTE.length;
        this.onCycleTeam?.(p.slot, next);
      });
    }

    // Avatar coloured by TEAM (so teammates share a body colour).
    row.appendChild(this.avatar(team, p.isBot ?? false, !p.connected));

    // Name + slot.
    const col = el('div', 'flex:1 1 auto;min-width:0;', row);
    const nm = el(
      'div',
      `font:700 16px ${FONT_HEAD};color:${PALETTE.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`,
      col,
    );
    nm.textContent = (p.name || '(unnamed)') + (you ? '（你）' : '');
    const meta = el('div', `font:600 12px ${FONT};color:${PALETTE.soft};`, col);
    meta.textContent =
      `P${p.slot + 1} · 隊伍 ${team + 1}` +
      (p.score !== undefined && p.score !== null ? `  ·  ★ ${Math.round(p.score)}` : '');

    if (p.isBot) {
      // Bots: BOT · <tier> badge + a remove (✕) button (anyone may remove).
      const badge = el(
        'div',
        `flex:0 0 auto;padding:4px 12px;border-radius:999px;font:700 12px ${FONT_HEAD};` +
          `background:rgba(143,168,232,0.25);color:#5566b0;`,
        row,
      );
      badge.textContent = `BOT · ${tierLabel(p.botDifficulty)}`;
      const x = el(
        'button',
        'flex:0 0 auto;width:26px;height:26px;border:none;border-radius:50%;cursor:pointer;' +
          `background:rgba(216,95,124,0.15);color:${PALETTE.danger};font:700 14px ${FONT_HEAD};`,
        row,
      );
      x.textContent = '✕';
      x.title = 'Remove bot';
      // Stop the click from also cycling the card's team.
      x.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.onRemoveBot?.(p.slot);
      });
      return row;
    }

    // Humans: status pill.
    const pill = el(
      'div',
      [
        'flex:0 0 auto',
        'padding:4px 12px',
        'border-radius:999px',
        `font:700 12px ${FONT_HEAD}`,
        !p.connected
          ? `background:rgba(154,123,83,0.18);color:${PALETTE.soft}`
          : p.ready
            ? `background:rgba(127,209,185,0.32);color:${PALETTE.mint}`
            : `background:rgba(232,162,74,0.2);color:${PALETTE.accent}`,
      ].join(';'),
      row,
    );
    pill.textContent = !p.connected ? '離線' : p.ready ? '已準備' : '準備中…';
    return row;
  }

  /** Empty slot = dashed placeholder with a "+ Bot" button. */
  private emptySlotCard(slot: number): HTMLDivElement {
    const row = this.slotRow('rgba(255,255,255,0.25)', 'rgba(214,170,110,0.3)');
    row.style.borderStyle = 'dashed';

    // Faint slot ghost so the 4-up grid reads as fixed seats.
    const ghost = el('div', 'width:50px;height:58px;flex:0 0 auto;', row);
    ghost.style.display = 'flex';
    ghost.style.alignItems = 'center';
    ghost.style.justifyContent = 'center';
    ghost.style.font = `700 22px ${FONT_HEAD}`;
    ghost.style.color = 'rgba(154,123,83,0.4)';
    ghost.textContent = `P${slot + 1}`;

    const col = el('div', 'flex:1 1 auto;min-width:0;', row);
    el(
      'div',
      `font:700 15px ${FONT_HEAD};color:${PALETTE.soft};`,
      col,
    ).textContent = 'Empty seat';

    // Tier picker (native select) defaulting to the DDA-suggested tier.
    const tierSel = el(
      'select',
      'flex:0 0 auto;padding:6px 8px;border-radius:10px;cursor:pointer;' +
        `background:${PALETTE.input};color:${PALETTE.text};font:700 12px ${FONT_HEAD};` +
        `border:2px solid ${PALETTE.inputBorder};outline:none;`,
      row,
    );
    for (const t of ['easy', 'normal', 'hard']) {
      const opt = el('option', '', tierSel);
      opt.value = t;
      opt.textContent = tierLabel(t);
    }
    tierSel.value = ['easy', 'normal', 'hard'].includes(this.suggestedBotTier)
      ? this.suggestedBotTier
      : 'normal';

    const addBtn = el(
      'button',
      'flex:0 0 auto;padding:7px 14px;border:none;border-radius:12px;cursor:pointer;' +
        `background:${PALETTE.button};color:${PALETTE.buttonInk};font:700 13px ${FONT_HEAD};` +
        'box-shadow:0 2px 0 rgba(150,108,58,0.28);',
      row,
    );
    addBtn.textContent = '＋ Bot';
    addBtn.addEventListener('click', () => this.onAddBot?.(slot, tierSel.value));
    return row;
  }

  showDisconnected(message: string, showRetry: boolean): void {
    this.showOnly(this.discScreen);
    this.discMessage.textContent = message;
    this.reconnectBtn.style.display = showRetry ? '' : 'none';
  }

  /** Hide every lobby screen and panel (the match canvas takes over). */
  showMatch(): void {
    this.showOnly(null);
    this.hideResult();
  }

  // -- in-match elements -----------------------------------------------------------

  setMatchNotice(text: string | null): void {
    if (text === null || text === '') {
      this.noticeEl.style.display = 'none';
    } else {
      this.noticeEl.style.display = 'block';
      this.noticeEl.textContent = text;
    }
  }

  showResult(result: 'win' | 'loss' | 'draw', detail: string): void {
    this.resultPanel.style.display = 'block';
    this.resultTitle.textContent =
      result === 'win' ? 'Victory!' : result === 'draw' ? 'Draw' : 'Defeat';
    this.resultTitle.style.color =
      result === 'win' ? PALETTE.mint : result === 'loss' ? PALETTE.danger : PALETTE.soft;
    this.resultDetail.textContent = detail;
    this.resultStatus.textContent = '';
  }

  setResultStatus(text: string): void {
    this.resultStatus.textContent = text;
  }

  hideResult(): void {
    this.resultPanel.style.display = 'none';
  }

  // -- helpers ------------------------------------------------------------------------

  private showOnly(screen: HTMLDivElement | null): void {
    for (const s of [this.landing, this.roomScreen, this.discScreen]) {
      s.style.display = s === screen ? 'block' : 'none';
    }
    if (screen !== null) this.hideResult();
  }

  private copyInviteLink(): void {
    const url =
      this.buildInviteUrl?.(this.currentRoomId) ?? window.location.href;
    const flash = (text: string): void => {
      const prior = this.copyBtn.textContent;
      this.copyBtn.textContent = text;
      setTimeout(() => (this.copyBtn.textContent = prior), 1500);
    };
    if (navigator.clipboard?.writeText !== undefined) {
      navigator.clipboard.writeText(url).then(
        () => flash('Copied!'),
        () => window.prompt('Copy this invite link:', url),
      );
    } else {
      window.prompt('Copy this invite link:', url);
    }
  }
}
