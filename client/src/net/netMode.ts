/**
 * M5 net mode orchestrator: lobby screens → lockstep match → result/rematch,
 * plus disconnect/reconnect handling.
 *
 * URL params (all optional):
 *   ?mode=net          select this path (main.ts)
 *   &room=test         room id (auto-created server-side if missing)
 *   &name=p1           player name (room + name together = deep link that
 *                      joins the room view with zero clicks)
 *   &autoready=1       legacy zero-click path: auto-join + auto-ready once
 *                      ≥2 players are in the room (used by automated tests)
 *   &port=8765         relay port (default 8765, env CHOCCUS_PORT server-side)
 *   &debug=1           show the NetDebugOverlay (implied by autoready=1)
 *
 * Flow: LobbyUI (DOM screens, view) is driven by NetLobby (state) and this
 * orchestrator; each MatchStart spins up a MatchRunner (engine + rAF loop).
 * Rematch: the relay resets a PLAYING room to LOBBY on the first post-match
 * ReadyToggle, so "Rematch" simply readies up again → fresh MatchStart with
 * a new seed.
 *
 * Reconnect limitation (documented; resync is post-M5): NetClient restores
 * only the SOCKET after a drop. The relay has no session resume, so a client
 * that loses its connection mid-match cannot rejoin that match — it lands on
 * a "disconnected" screen and re-enters via the lobby (the room itself stays
 * playable for the others through the relay's ghost-input handling; the
 * room becomes joinable again after the survivors trigger a rematch reset).
 */
import { KeyboardInput } from '../input/KeyboardInput';
import { Renderer } from '../render/Renderer';
import { LobbyUI } from './LobbyUI';
import { LocalRoom } from './LocalRoom';
import { MatchRunner } from './MatchRunner';
import { NetClient } from './NetClient';
import { NetDebugOverlay } from './NetDebugOverlay';
import { NetLobby } from './NetLobby';
import { asTier, botForTier } from '../ai/botDifficulty';
import { captureSessionFromUrl, getAuth, login, logout, oauthEnabled, ratingKey } from './auth';
import { recordBotResult, suggestedTier } from './dda';
import { resolveWsUrl } from './wsUrl';
import type { LockstepStatus } from './LockstepEngine';
import type {
  LeaderboardEntry,
  MatchStartMsg,
  RoomPlayer,
  RoomStateMsg,
} from './protocolCodec';

/** Resolve a leaderboard row's display label: humans show their name; a bot id
 *  (`bot:<tier>`) becomes its friendly archetype name (champion table is the
 *  same on every map, so 'classic' is a fine representative). */
function leaderboardRow(e: LeaderboardEntry): {
  label: string;
  score: number;
  games: number;
  isBot: boolean;
} {
  if (e.playerId.startsWith('bot:')) {
    const tier = asTier(e.playerId.slice(4));
    const { version, archetype } = botForTier(tier, 'classic');
    const tierName = tier.charAt(0).toUpperCase() + tier.slice(1);
    return {
      label: `🤖 v${version}-${archetype} · ${tierName}`,
      score: e.score,
      games: e.games,
      isBot: true,
    };
  }
  return { label: e.name || 'Player', score: e.score, games: e.games, isBot: false };
}

/** autoready waits for this roster size before readying up. */
const AUTOREADY_MIN_PLAYERS = 2;

type Screen = 'landing' | 'room' | 'match' | 'result' | 'disconnected';

export async function runNetMode(params: URLSearchParams): Promise<void> {
  // Capture a fresh ?session= token (post-login redirect) before anything reads
  // the identity, then strip it from the URL.
  captureSessionFromUrl();

  const url = resolveWsUrl(params);
  const roomParam = params.get('room') ?? '';
  const nameParam = params.get('name') ?? '';
  const autoReady = params.get('autoready') === '1';
  const debug = autoReady || params.get('debug') === '1';
  // Name precedence: explicit ?name= → logged-in provider name → random guest.
  const name =
    nameParam ||
    getAuth()?.name ||
    `Player${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;

  const mount = document.getElementById('app');
  if (!mount) {
    throw new Error('#app mount point missing');
  }

  const client = new NetClient();
  client.enableAutoReconnect();
  const lobby = new NetLobby(client);
  lobby.playerId = ratingKey(); // signed session token when logged in, else anon id
  const keyboard = new KeyboardInput(); // attached only while a match runs

  const ui = new LobbyUI();
  mount.appendChild(ui.root);
  ui.setName(name);
  ui.setRoomId(roomParam);
  ui.setLoginEnabled(oauthEnabled()); // OAuth UI is off until VITE_OAUTH_ENABLED=1
  ui.setAuthName(getAuth()?.name ?? null);
  // Invite link deliberately omits `name` so the friend picks their own.
  ui.buildInviteUrl = (roomId) => {
    const u = new URL(window.location.href);
    u.search = '';
    u.searchParams.set('mode', 'net');
    u.searchParams.set('room', roomId);
    if (params.has('ws')) u.searchParams.set('ws', params.get('ws')!);
    else if (params.has('port')) u.searchParams.set('port', params.get('port')!);
    return u.toString();
  };

  let overlay: NetDebugOverlay | null = null;
  if (debug) {
    overlay = new NetDebugOverlay();
    // Top-right so the panel does not cover the arena (canvas mounts left).
    overlay.root.style.left = 'auto';
    overlay.root.style.right = '8px';
    document.body.appendChild(overlay.root);
    client.on('stallNotice', (m) =>
      overlay?.log(`StallNotice t=${m.t} waiting=[${m.waiting.join(',')}]`),
    );
    client.on('hashMismatch', (m) =>
      overlay?.log(`HashMismatch t=${m.t} hashes=[${m.hashes.join(',')}]`),
    );
    client.on('playerDisconnect', (m) =>
      overlay?.log(`PlayerDisconnect slot=${m.slot}`),
    );
    client.on('error', (ev) => overlay?.log(`error: ${ev.message}`));
    lobby.onPhase = (phase) =>
      overlay?.setStatus(`${phase} · ${url} · name=${name}`);
  }

  let screen: Screen = 'landing';
  let renderer: Renderer | null = null;
  let runner: MatchRunner | null = null;
  /** Active offline room (alone-vs-bots, no relay); null = relay path. While
   *  set, the room callbacks below dispatch here instead of to the relay. */
  let localRoom: LocalRoom | null = null;
  /** Roster snapshot at MatchStart — names disconnect notices by slot. */
  let rosterAtStart: RoomPlayer[] = [];
  let everConnected = false;
  let lastRoomId = roomParam;
  /** Whether the in-progress match includes bots (drives the DDA update). */
  let matchHadBots = false;

  const errText = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);

  const stopRunner = (): void => {
    runner?.stop();
    runner = null;
    ui.setMatchNotice(null);
    if (renderer !== null) renderer.canvas.style.display = 'none';
  };

  // -- net room host settings + manual teams ------------------------------------
  // The host = the lowest-slot HUMAN (matches the relay's host_slot). Only the
  // host may change the map / any slot's team; a non-host may change ONLY its own
  // team. The map picker reflects RoomState; teams are per-slot on each player
  // (clicking a roster card cycles its team — wired via ui.onCycleTeam).

  const isLocalHost = (state: RoomStateMsg): boolean => {
    const humanSlots = state.players
      .filter((p) => !p.isBot)
      .map((p) => p.slot);
    return humanSlots.length > 0 && Math.min(...humanSlots) === state.youSlot;
  };

  /** Show the relay room view + the host map picker (net rooms). The colour
   *  picker is hidden (net teams are per-slot manual via card clicks); the map
   *  picker is enabled only for the host. Card click-to-cycle is gated by
   *  `teamEditable` (host: any card; non-host: own card only). */
  const showNetRoom = (state: RoomStateMsg): void => {
    const host = isLocalHost(state);
    ui.setTeamEditable((slot) => host || slot === state.youSlot);
    ui.showRoom(state);
    ui.setHostSettings({ map: state.map ?? 'classic', host });
  };

  // -- lobby events → screens ---------------------------------------------------

  lobby.onRoomState = (state: RoomStateMsg): void => {
    overlay?.setRoomState(state);
    lastRoomId = state.roomId;
    if (screen === 'room') {
      // Only the relay path reaches here (the offline LocalRoom renders itself);
      // show the room + the host map picker + per-slot team colours from state.
      if (localRoom === null) showNetRoom(state);
      else ui.showRoom(state);
    } else if (screen === 'result') {
      // Someone pressed Rematch: the room is back in LOBBY — show progress.
      const ready = state.players.filter((p) => p.connected && p.ready).length;
      const present = state.players.filter((p) => p.connected).length;
      ui.setResultStatus(
        present < 2
          ? 'Waiting for another player to join the room…'
          : `Rematch: ${ready}/${present} ready…`,
      );
    }
  };

  lobby.onMatchStart = (start: MatchStartMsg): void => {
    void startMatch(start);
  };

  async function startMatch(start: MatchStartMsg): Promise<void> {
    overlay?.setMatchStart(start);
    overlay?.log(`MatchStart seed=${start.seed} slot=${start.slot} t0=${start.t0}`);

    // numPlayers = highest occupied slot + 1 from the last RoomState (the
    // roster is identical on every client at MatchStart, so this stays
    // deterministic; it also matches the relay's InputBroadcast width).
    rosterAtStart = lobby.roomState?.players ?? [];
    const numPlayers =
      Math.max(start.slot, ...rosterAtStart.map((p) => p.slot)) + 1;
    // Bots come from the final roster (isBot + botDifficulty). The roster is
    // identical on every client at MatchStart, so every client runs the same
    // bots → no desync. They render as robot-chefs (humans as chef-hat cuties).
    const bots = rosterAtStart
      .filter((p) => p.isBot)
      .map((p) => ({ slot: p.slot, difficulty: p.botDifficulty ?? 'normal' }));
    matchHadBots = bots.length > 0;

    if (renderer === null) {
      renderer = await Renderer.create();
      mount?.appendChild(renderer.canvas);
    }
    renderer.setBotSlots(new Set(bots.map((b) => b.slot)));
    renderer.setHudHint(
      `Online — you are P${start.slot + 1} · Arrows + Space`,
      false,
    );
    renderer.canvas.style.display = '';

    runner?.stop();
    screen = 'match';
    ui.showMatch();
    ui.setMatchNotice(null);
    runner = new MatchRunner({
      transport: client,
      start,
      numPlayers,
      bots,
      renderer,
      keyboard,
      // Capture the match; on OVER if WE lost, hand the replay up for upload
      // (the relay-side storage is Phase 2b — uploadReplay() is wired, dormant).
      record: 'humanLoss',
      onReplayReady: (replay) => {
        // On a net loss, upload the self-contained replay so the relay can store
        // it for offline analysis (Phase 2b storage is live; see relay/replays.py).
        client.uploadReplay(replay);
      },
      onStatus: (s) => updateMatchStatus(s),
      onOver: (result, _final, winnerTeam) => {
        screen = 'result';
        // Report the outcome so the relay can update ratings (authoritative;
        // every client reports, the relay applies it once per match).
        client.reportResult(winnerTeam);
        // Local DDA: a match with bots nudges your suggested tier (win twice →
        // harder, lose twice → easier). Pre-selects the next "+ Bot" pick.
        if (matchHadBots) ui.setSuggestedTier(recordBotResult(result));
        const detail =
          result === 'win'
            ? 'Your team is the last standing!'
            : result === 'draw'
              ? "Time up — it's a draw."
              : 'Your team was eliminated…';
        ui.showResult(result, detail);
      },
    });
  }

  function updateMatchStatus(s: LockstepStatus): void {
    if (overlay !== null) {
      const hash =
        s.lastHashTick >= 0
          ? `0x${s.lastHash.toString(16).padStart(8, '0')} @ t${s.lastHashTick}`
          : '(none yet)';
      const lines = [
        `you are slot ${s.mySlot} (Arrows + Space) · players ${s.numPlayers}`,
        `tick ${s.currentTick} · hash ${hash}`,
      ];
      if (s.desynced) {
        lines.push(`*** DESYNC at t=${s.lastMismatch?.t ?? '?'} — match frozen ***`);
      } else if (s.stalled) {
        lines.push(
          `waiting for inputs…${
            s.stallWaiting.length > 0 ? ` (slots ${s.stallWaiting.join(',')})` : ''
          }`,
        );
      }
      if (s.disconnectedSlots.length > 0) {
        lines.push(`disconnected slots: ${s.disconnectedSlots.join(',')}`);
      }
      overlay.setLockstep(lines.join('\n'));
    }

    const slotName = (slot: number): string => {
      const p = rosterAtStart.find((r) => r.slot === slot);
      return p?.name ? `${p.name} (P${slot + 1})` : `P${slot + 1}`;
    };
    const notices: string[] = [];
    if (s.desynced) {
      notices.push('Desync detected — match frozen (cannot resync in this build)');
    } else if (s.stalled && s.stallWaiting.length > 0) {
      notices.push(
        `Waiting for ${s.stallWaiting.map(slotName).join(', ')}…`,
      );
    }
    if (s.disconnectedSlots.length > 0) {
      notices.push(
        `${s.disconnectedSlots.map(slotName).join(', ')} disconnected`,
      );
    }
    ui.setMatchNotice(notices.length > 0 ? notices.join(' · ') : null);
  }

  // -- UI events → lobby actions ---------------------------------------------------

  const ensureConnected = async (): Promise<void> => {
    if (!client.isOpen) {
      await lobby.connect(url);
      everConnected = true;
    }
  };

  // Lobby leaderboard: the relay replies to GET_LEADERBOARD with the global
  // top-N. Render on arrival; a best-effort connect fetches it on the landing
  // screen, and it hides itself when the relay is unreachable (offline deploy).
  client.on('leaderboard', (m) => ui.setLeaderboard(m.entries.map(leaderboardRow)));
  const refreshLeaderboard = (): void => {
    void ensureConnected().then(
      () => client.requestLeaderboard(10),
      () => ui.setLeaderboard(null),
    );
  };

  const joinFlow = async (playerName: string, roomId: string): Promise<void> => {
    ui.setLandingStatus('Connecting…');
    try {
      await ensureConnected();
      const state = await lobby.joinAndWait(roomId, playerName);
      lastRoomId = state.roomId;
      screen = 'room';
      showNetRoom(state);
    } catch (err) {
      screen = 'landing';
      ui.showLanding(`Could not join: ${errText(err)}`);
    }
  };

  ui.onCreateRoom = (n) => void joinFlow(n, '');
  ui.onJoinRoom = (n, roomId) => void joinFlow(n, roomId);
  ui.onQuickMatch = (n) => void joinFlow(n, 'test');
  // Room callbacks dispatch to the offline LocalRoom while one is active, else
  // to the relay lobby — the room view (LobbyUI) is the same for both.
  ui.onReadyToggle = (ready) =>
    localRoom !== null ? void localRoom.start() : lobby.setReady(ready);
  ui.onAddBot = (slot, difficulty) =>
    localRoom !== null ? localRoom.addBot(slot, difficulty) : lobby.addBot(slot, difficulty);
  ui.onRemoveBot = (slot) =>
    localRoom !== null ? localRoom.removeBot(slot) : lobby.removeBot(slot);
  // Host map pick: offline → LocalRoom; net → SET_ROOM_SETTINGS (relay ignores
  // non-hosts). Manual teams: clicking a roster card cycles that slot's team —
  // offline applies locally; net sends SET_PLAYER_TEAM (relay enforces host:any /
  // non-host:own). The standalone colour picker is offline-only.
  ui.onSelectMap = (map) => {
    if (localRoom !== null) localRoom.setMap(map);
    else lobby.setRoomSettings(map);
  };
  ui.onCycleTeam = (slot, nextTeam) => {
    if (localRoom !== null) localRoom.setPlayerTeam(slot, nextTeam);
    else lobby.setPlayerTeam(slot, nextTeam);
  };
  ui.onSelectColor = (color) => localRoom?.setColor(color);
  ui.setSuggestedTier(suggestedTier()); // seed the "+ Bot" picker from local DDA
  ui.onLeaveRoom = () => {
    if (localRoom !== null) {
      localRoom.leave(); // disposes + calls onExitToLanding below
      return;
    }
    lobby.leave();
    screen = 'landing';
    ui.showLanding();
    ui.setRoomId(lastRoomId);
    refreshLeaderboard(); // ratings may have changed since we last looked
  };
  ui.onRematch = () => {
    // The relay resets the room to LOBBY on this toggle (rematch signal).
    lobby.setReady(true);
    ui.setResultStatus('Ready — waiting for the other player…');
  };
  ui.onBackToRoom = () => {
    stopRunner();
    lobby.setReady(false); // also resets the room if we're the first one back
    screen = 'room';
    if (lobby.roomState !== null) showNetRoom(lobby.roomState);
  };
  ui.onSolo = () => {
    // Open an offline room (alone-vs-bots, no relay) in-place — no page reload.
    localRoom = new LocalRoom({
      mount,
      ui,
      name: getAuth()?.name ?? ui.getName(),
      onExitToLanding: () => {
        localRoom = null;
        screen = 'landing';
        ui.showLanding();
        refreshLeaderboard();
      },
    });
    screen = 'room';
    localRoom.open();
  };
  ui.onGuide = () => {
    // Navigate to the illustrated how-to-play guide page.
    const u = new URL(window.location.href);
    u.search = '?mode=guide';
    window.location.assign(u.toString());
  };
  ui.onLogin = (provider) => login(provider); // navigates to the OAuth flow
  ui.onLogout = () => {
    logout();
    ui.setAuthName(null);
    lobby.playerId = ratingKey(); // revert to the anonymous id
    ui.setLandingStatus('已登出');
  };
  ui.onReconnect = () => {
    void (async () => {
      ui.showDisconnected('Reconnecting…', false);
      try {
        await ensureConnected();
        screen = 'landing';
        ui.showLanding('Reconnected — rejoin a room to play.');
        ui.setRoomId(lastRoomId);
      } catch (err) {
        ui.showDisconnected(`Still unreachable: ${errText(err)}`, true);
      }
    })();
  };

  // -- connection loss / reconnect ---------------------------------------------------

  client.on('close', (ev) => {
    overlay?.setStatus(
      `disconnected (code ${ev.code}${ev.reason ? `: ${ev.reason}` : ''})`,
    );
    if (!everConnected) return; // initial connect failure: joinFlow reports it
    if (screen === 'disconnected') return; // failed retry: reconnect events drive the UI
    stopRunner();
    screen = 'disconnected';
    ui.showDisconnected('Connection to the server was lost.', true);
  });
  client.on('reconnecting', (info) => {
    if (screen !== 'disconnected') return;
    ui.showDisconnected(
      `Connection lost — reconnecting (attempt ${info.attempt}/${info.maxAttempts})…`,
      false,
    );
  });
  client.on('reconnected', () => {
    overlay?.setStatus('reconnected');
    if (screen !== 'disconnected') return;
    // No mid-match resume (see header) — back in via the lobby.
    screen = 'landing';
    ui.showLanding(
      'Reconnected — matches in progress cannot be rejoined; enter a room to play.',
    );
    ui.setRoomId(lastRoomId);
  });
  client.on('reconnectFailed', () => {
    if (screen !== 'disconnected') return;
    ui.showDisconnected(
      'Could not reconnect automatically — the server may be down.',
      true,
    );
  });

  // -- entry --------------------------------------------------------------------------

  if (autoReady) {
    // Legacy zero-click path (automated tests): join + ready, no UI clicks.
    screen = 'match';
    ui.showMatch();
    try {
      await ensureConnected();
      let readySent = false;
      client.on('roomState', (m) => {
        if (!readySent && m.players.length >= AUTOREADY_MIN_PLAYERS) {
          readySent = true;
          client.toggleReady(true);
        }
      });
      lobby.join(roomParam, name);
    } catch (err) {
      overlay?.setStatus(`failed: ${errText(err)}`);
      screen = 'landing';
      ui.showLanding(`Could not connect: ${errText(err)}`);
    }
  } else if (roomParam !== '' && nameParam !== '') {
    // Deep link with an explicit name: straight into the room view.
    void joinFlow(name, roomParam);
  } else {
    screen = 'landing';
    ui.showLanding();
    refreshLeaderboard();
  }
}
