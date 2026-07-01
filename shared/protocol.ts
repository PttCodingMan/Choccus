/**
 * Chocco — WebSocket lockstep protocol (type definitions only).
 *
 * Wire format: MessagePack payload prefixed by a 1-byte message-type id
 * (the `MsgType` values below). The Python relay mirrors these ids by hand;
 * this file is the single source of truth.
 *
 * No runtime logic lives here — encoding/decoding comes in M3/M4.
 */

import type { GamePhase } from './types';

// ---------------------------------------------------------------------------
// Message type ids (1-byte wire header). C→S: 0x01–0x0F, S→C: 0x10–0x1F.
// ---------------------------------------------------------------------------

export const MsgType = {
  // Client → Server
  JOIN_ROOM: 0x01,
  LEAVE_ROOM: 0x02,
  READY_TOGGLE: 0x03,
  INPUT_FRAME: 0x04,
  HASH_REPORT: 0x05,
  ADD_BOT: 0x06,
  REMOVE_BOT: 0x07,
  MATCH_RESULT: 0x08,
  GET_LEADERBOARD: 0x09,
  REPLAY_UPLOAD: 0x0a,
  SET_ROOM_SETTINGS: 0x0b,
  SET_PLAYER_TEAM: 0x0c,

  // Server → Client
  ROOM_STATE: 0x10,
  MATCH_START: 0x11,
  INPUT_BROADCAST: 0x12,
  TICK_READY: 0x13,
  STALL_NOTICE: 0x14,
  HASH_MISMATCH: 0x15,
  PLAYER_DISCONNECT: 0x16,
  LEADERBOARD: 0x17,
} as const;
export type MsgType = (typeof MsgType)[keyof typeof MsgType];

// ---------------------------------------------------------------------------
// Shared payload pieces
// ---------------------------------------------------------------------------

/**
 * Feel parameters, sent by the server with MatchStart and frozen for the
 * whole match so every client simulates with identical values.
 */
export interface FeelParams {
  /** Tiles/s (3–8, default 5.0). */
  moveSpeed: number;
  /** Corner-assist tolerance in tiles (0–0.5, default 0.25). */
  cornerAssist: number;
  /** Input buffer in ms (0–250, default 120). */
  inputBufferMs: number;
}

/** One player's packed input for a single sim tick. */
export interface SlotInput {
  /** Direction bit flags (shared/types Direction). */
  dirs: number;
  /** Action bit flags (shared/types ActionFlags). */
  actions: number;
}

/**
 * Map layout selector. The sim's MapKind (client/src/sim/Map.ts) is a bare
 * string alias of the registered map-template keys ('classic', 'pirate', …);
 * shared/ cannot import from client/, so this mirrors it as `string`. Stays in
 * sync structurally — any value here feeds createInitialState's `map` option.
 */
export type MapKind = string;

export interface RoomPlayer {
  slot: number;
  name: string;
  ready: boolean;
  connected: boolean;
  /** True = an AI bot filling this slot (no socket; driven client-side). */
  isBot?: boolean;
  /** Bot strength tier ('easy' | 'normal' | 'hard'); resolved to a BT rung
   *  per map on every client. Present only when isBot. */
  botDifficulty?: string;
  /** Conservative rating score (μ − 3σ); shown in the roster. */
  score?: number;
  /**
   * Team id for this slot = the body-palette/colour index (0..MAX_PLAYERS-1).
   * Teams are MANUAL per-slot: clicking a roster card cycles its team. Default =
   * the slot index (FFA: everyone on their own team). The relay is the authority
   * — it carries this in RoomState so every client renders the same team colours,
   * and the same array goes out in MatchStart.teams. Falls back to the slot index
   * when absent (older relays / pre-Phase-2 byte-identical default).
   */
  team?: number;
}

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

export interface JoinRoomMsg {
  type: typeof MsgType.JOIN_ROOM;
  /** Room to join; empty string = create a new room. */
  roomId: string;
  name: string;
  /** Persistent client id (localStorage) — the rating key for this player. */
  playerId: string;
}

export interface LeaveRoomMsg {
  type: typeof MsgType.LEAVE_ROOM;
}

export interface ReadyToggleMsg {
  type: typeof MsgType.READY_TOGGLE;
  ready: boolean;
}

/** Add an AI bot to a specific empty slot (lobby only). */
export interface AddBotMsg {
  type: typeof MsgType.ADD_BOT;
  slot: number;
  /** Strength tier: 'easy' | 'normal' | 'hard' (default 'normal'). */
  difficulty: string;
}

/** Remove a bot from a slot (lobby only). */
export interface RemoveBotMsg {
  type: typeof MsgType.REMOVE_BOT;
  slot: number;
}

/**
 * Reported by clients when the sim reaches OVER: the winning team (= winning
 * slot in the current FFA setup), or null for a draw. The relay never
 * simulates, so this is how it learns the outcome — backed by lockstep hash
 * agreement, and applied once per match.
 */
export interface MatchResultMsg {
  type: typeof MsgType.MATCH_RESULT;
  winnerTeam: number | null;
}

/** Local input sampled at tick t, scheduled for sim tick t + INPUT_DELAY_TICKS. */
export interface InputFrameMsg {
  type: typeof MsgType.INPUT_FRAME;
  /** Target sim tick this input applies to. */
  t: number;
  dirs: number;
  actions: number;
}

/** Sent every HASH_REPORT_INTERVAL ticks for desync detection. */
export interface HashReportMsg {
  type: typeof MsgType.HASH_REPORT;
  t: number;
  /** FNV-1a state hash (uint32). */
  hash: number;
}

/** Request the global rating leaderboard (any time; not room-scoped). */
export interface GetLeaderboardMsg {
  type: typeof MsgType.GET_LEADERBOARD;
  /** Max rows wanted (server clamps; default 10). */
  limit?: number;
}

/** One sim tick's inputs for a replay, dense in slot order. */
export interface ReplayTick {
  /** Sim tick index this frame advances (0-based; the tick() that takes
   *  state.tick from t to t+1). */
  t: number;
  /** One {dirs, actions} per slot, length numPlayers. */
  slots: SlotInput[];
}

/**
 * A complete, self-contained match replay uploaded by the loser at OVER.
 *
 * Self-sufficient: seed + map + teams + numPlayers + t0 + frozen config + the
 * full dense per-tick inputs reproduce the match bit-for-bit (same determinism
 * contract as the sim-runner Replay fixture — the relay can derive a fixture
 * from this with no extra data). MessagePack-friendly: only plain
 * objects/arrays/numbers/strings. Phase 2b adds the actual storage; Phase 1
 * only locks the shape.
 */
export interface ReplayUploadMsg {
  type: typeof MsgType.REPLAY_UPLOAD;
  /** Shared PRNG seed (uint32) — map + drops derive from it. */
  seed: number;
  /** Map layout the match ran on. */
  map: MapKind;
  /** Team id per slot (length numPlayers; FFA = [0,1,2,…]). */
  teams: number[];
  /** Player count (= teams.length = each ReplayTick.slots length). */
  numPlayers: number;
  /** First sim tick the match stepped from (matches MatchStart.t0). */
  t0: number;
  /** Frozen feel parameters used for the whole match. */
  config: FeelParams;
  /** Every advanced tick's inputs, dense in slot order, in tick order. */
  inputs: ReplayTick[];
  /** Outcome relative to the uploading (local) player. */
  result: 'win' | 'loss' | 'draw';
  /** Absolute winning team (= winning slot in FFA), or null for a draw. */
  winnerTeam: number | null;
  /**
   * Bots present in this match whose team did NOT win (i.e. the bot lost to a
   * human) — real counter-examples for the AI diagnostics tooling (v5-diag /
   * npm run replay), distinct from self-play bench data. Omitted when empty.
   */
  botLoss?: Array<{ slot: number; difficulty: string }>;
}

/**
 * Host-only map pick, changed in the lobby. The relay stores it on the room,
 * reflects it in RoomState, and sends it in MatchStart. Sent from a non-host
 * slot is ignored server-side.
 */
export interface SetRoomSettingsMsg {
  type: typeof MsgType.SET_ROOM_SETTINGS;
  /** Map layout key (one of MAP_KINDS); invalid values ignored. */
  map: MapKind;
}

/**
 * Manual per-slot team assignment (click a roster card to cycle its team). The
 * relay enforces permissions: the HOST (lowest-slot human) may set ANY slot; a
 * non-host may set ONLY its own slot. `team` is the palette/colour index
 * (0..MAX_PLAYERS-1). Ignored once the match is playing; malformed dropped.
 */
export interface SetPlayerTeamMsg {
  type: typeof MsgType.SET_PLAYER_TEAM;
  /** The slot whose team to change. */
  slot: number;
  /** New team id (= colour index, 0..MAX_PLAYERS-1). */
  team: number;
}

export type ClientMsg =
  | JoinRoomMsg
  | LeaveRoomMsg
  | ReadyToggleMsg
  | AddBotMsg
  | RemoveBotMsg
  | MatchResultMsg
  | InputFrameMsg
  | HashReportMsg
  | GetLeaderboardMsg
  | ReplayUploadMsg
  | SetRoomSettingsMsg
  | SetPlayerTeamMsg;

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

export interface RoomStateMsg {
  type: typeof MsgType.ROOM_STATE;
  roomId: string;
  phase: GamePhase;
  /** Receiver's own slot index. */
  youSlot: number;
  players: RoomPlayer[];
  /**
   * Host's current map pick. Optional: omitted by older relays → the client
   * shows the default ('classic'). Reflects SetRoomSettings so every client's
   * picker stays in sync with the host. Per-slot teams live on each RoomPlayer
   * (`team`), mutated by SetPlayerTeam.
   */
  map?: MapKind;
}

export interface MatchStartMsg {
  type: typeof MsgType.MATCH_START;
  /** Shared PRNG seed (uint32) — map and drops all derive from it. */
  seed: number;
  /** Receiver's player slot. */
  slot: number;
  /** Frozen feel parameters for the whole match. */
  config: FeelParams;
  /** First sim tick (clients start stepping from here). */
  t0: number;
  /**
   * Map layout for the whole match (whose grid tiles ARE hashed). Optional:
   * omitted by the relay today → every client defaults to 'classic'
   * (byte-identical to before). The in-process loopback transport sets it so
   * solo/spectate/offline-room can request any registered map.
   */
  map?: MapKind;
  /**
   * Team id per slot (a non-hashed match constant), one entry per slot. Manual
   * teams: the relay sends the room's full per-slot teams array (default
   * team[i] = i). Optional only so an untouched default room can omit it and stay
   * byte-identical (omitted → engine defaults team = slot, == the default array).
   */
  teams?: number[];
  /**
   * Ticks a local input is scheduled ahead of the tick it applies to (the
   * lockstep round-trip buffer). The relay measures each connected human's
   * RTT to itself right before start and picks the max (clamped, +margin) so
   * one room's ping doesn't force a fixed buffer on every room. Falls back to
   * shared/constants.ts INPUT_DELAY_TICKS when absent (older relay / loopback).
   */
  inputDelayTicks?: number;
}

/** All slots' inputs for sim tick t; clients only step once a tick is complete. */
export interface InputBroadcastMsg {
  type: typeof MsgType.INPUT_BROADCAST;
  t: number;
  /** Indexed by slot. */
  inputs: SlotInput[];
}

export interface TickReadyMsg {
  type: typeof MsgType.TICK_READY;
  t: number;
}

/** Inputs missing for tick t beyond STALL_TIMEOUT_MS; display "waiting". */
export interface StallNoticeMsg {
  type: typeof MsgType.STALL_NOTICE;
  t: number;
  /** Slots the server is still waiting on. */
  waiting: number[];
}

/** Desync detected (v1: detection only — clients end the match gracefully). */
export interface HashMismatchMsg {
  type: typeof MsgType.HASH_MISMATCH;
  t: number;
  /** Reported hash per slot (uint32), indexed by slot. */
  hashes: number[];
}

/** From here on this slot is driven by ghost input (repeat last input). */
export interface PlayerDisconnectMsg {
  type: typeof MsgType.PLAYER_DISCONNECT;
  slot: number;
}

/** One leaderboard row. `playerId` lets the client tag bots (`bot:<tier>`) and
 *  render a friendly archetype label; humans show `name`. */
export interface LeaderboardEntry {
  playerId: string;
  name: string;
  /** Conservative rating score (μ − 3σ), rounded. */
  score: number;
  games: number;
}

/** The global rating leaderboard, top rows by score (reply to GET_LEADERBOARD). */
export interface LeaderboardMsg {
  type: typeof MsgType.LEADERBOARD;
  entries: LeaderboardEntry[];
}

export type ServerMsg =
  | RoomStateMsg
  | MatchStartMsg
  | InputBroadcastMsg
  | TickReadyMsg
  | StallNoticeMsg
  | HashMismatchMsg
  | PlayerDisconnectMsg
  | LeaderboardMsg;
