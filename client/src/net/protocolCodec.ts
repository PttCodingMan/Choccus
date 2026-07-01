/**
 * Wire codec for the lockstep protocol (M4a).
 *
 * Framing (mirrors server/relay/protocol.py exactly):
 * ``[1-byte MsgType id][MessagePack map payload]``.
 *
 * The `type` field of each shared/protocol.ts interface is the discriminated
 * union tag carried by the 1-byte header — it is NOT duplicated inside the
 * msgpack payload. Message-type ids and field names are imported from
 * shared/protocol.ts (the single source of truth); nothing is re-declared.
 */
import { decode as unpackPayload, encode as packPayload } from '@msgpack/msgpack';

import { MsgType } from '../../../shared/protocol';
import type {
  FeelParams,
  HashMismatchMsg,
  InputBroadcastMsg,
  LeaderboardEntry,
  LeaderboardMsg,
  MapKind,
  MatchStartMsg,
  PlayerDisconnectMsg,
  ReplayTick,
  ReplayUploadMsg,
  RoomPlayer,
  RoomStateMsg,
  ServerMsg,
  SetPlayerTeamMsg,
  SetRoomSettingsMsg,
  SlotInput,
  StallNoticeMsg,
  TickReadyMsg,
} from '../../../shared/protocol';
import type { GamePhase } from '../../../shared/types';

export { MsgType };
export type {
  FeelParams,
  HashMismatchMsg,
  InputBroadcastMsg,
  LeaderboardEntry,
  LeaderboardMsg,
  MapKind,
  MatchStartMsg,
  PlayerDisconnectMsg,
  ReplayTick,
  ReplayUploadMsg,
  RoomPlayer,
  RoomStateMsg,
  ServerMsg,
  SetPlayerTeamMsg,
  SetRoomSettingsMsg,
  SlotInput,
  StallNoticeMsg,
  TickReadyMsg,
};

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

/** Frame a message: 1-byte type id + msgpack payload (always a map). */
export function encodeMsg(
  typeId: MsgType,
  payload: Record<string, unknown>,
): Uint8Array {
  const body = packPayload(payload);
  const frame = new Uint8Array(1 + body.length);
  frame[0] = typeId;
  frame.set(body, 1);
  return frame;
}

/** Split a frame into its raw (type id, payload map) parts. Throws on junk. */
export function decodeMsg(data: Uint8Array): {
  type: number;
  payload: Record<string, unknown>;
} {
  if (data.length < 1) {
    throw new Error('empty frame');
  }
  const type = data[0] as number;
  const payload: unknown = unpackPayload(data.subarray(1));
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error(`payload is not a map (type 0x${type.toString(16)})`);
  }
  return { type, payload: payload as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Client → Server builders (field names mirror server/relay/protocol.py)
// ---------------------------------------------------------------------------

/** JoinRoomMsg — roomId '' means create a new room. */
export function buildJoinRoom(
  roomId: string,
  name: string,
  playerId: string,
): Uint8Array {
  return encodeMsg(MsgType.JOIN_ROOM, { roomId, name, playerId });
}

/** MatchResultMsg — winning team (= winning slot in FFA), or null for a draw. */
export function buildMatchResult(winnerTeam: number | null): Uint8Array {
  return encodeMsg(MsgType.MATCH_RESULT, { winnerTeam });
}

export function buildLeaveRoom(): Uint8Array {
  return encodeMsg(MsgType.LEAVE_ROOM, {});
}

export function buildReadyToggle(ready: boolean): Uint8Array {
  return encodeMsg(MsgType.READY_TOGGLE, { ready });
}

export function buildAddBot(slot: number, difficulty: string): Uint8Array {
  return encodeMsg(MsgType.ADD_BOT, { slot, difficulty });
}

export function buildRemoveBot(slot: number): Uint8Array {
  return encodeMsg(MsgType.REMOVE_BOT, { slot });
}

export function buildInputFrame(
  t: number,
  dirs: number,
  actions: number,
): Uint8Array {
  return encodeMsg(MsgType.INPUT_FRAME, { t, dirs, actions });
}

export function buildHashReport(t: number, hash: number): Uint8Array {
  return encodeMsg(MsgType.HASH_REPORT, { t, hash });
}

export function buildGetLeaderboard(limit: number): Uint8Array {
  return encodeMsg(MsgType.GET_LEADERBOARD, { limit });
}

/** SetRoomSettingsMsg — host's map pick (relay ignores non-hosts). */
export function buildSetRoomSettings(map: string): Uint8Array {
  return encodeMsg(MsgType.SET_ROOM_SETTINGS, { map });
}

/** SetPlayerTeamMsg — manual per-slot team (host: any slot; non-host: own only). */
export function buildSetPlayerTeam(slot: number, team: number): Uint8Array {
  return encodeMsg(MsgType.SET_PLAYER_TEAM, { slot, team });
}

/**
 * ReplayUploadMsg — a self-contained match replay (seed + map + teams + dense
 * per-tick inputs + frozen config), uploaded by the loser at OVER. The payload
 * is built from plain objects/arrays/numbers so MessagePack carries it as-is;
 * Phase 2b adds the relay-side storage that consumes it.
 */
export function buildReplayUpload(replay: Omit<ReplayUploadMsg, 'type'>): Uint8Array {
  return encodeMsg(MsgType.REPLAY_UPLOAD, {
    seed: replay.seed,
    map: replay.map,
    teams: replay.teams,
    numPlayers: replay.numPlayers,
    t0: replay.t0,
    config: replay.config,
    inputs: replay.inputs,
    result: replay.result,
    winnerTeam: replay.winnerTeam,
    ...(replay.botLoss !== undefined ? { botLoss: replay.botLoss } : {}),
  });
}

// ---------------------------------------------------------------------------
// Server → Client typed decode
// ---------------------------------------------------------------------------

/**
 * Decode an incoming frame and narrow it to the ServerMsg union.
 *
 * Field shapes are trusted (the Python relay is hand-mirrored from
 * shared/protocol.ts and covered by server/tests/test_protocol.py); only the
 * framing and the type id are validated here.
 */
export function decodeServerMsg(data: Uint8Array): ServerMsg {
  const { type, payload: p } = decodeMsg(data);
  switch (type) {
    case MsgType.ROOM_STATE: {
      // map is optional (older relays omit it → client defaults to classic).
      // Per-slot teams ride on each RoomPlayer.team. Only attach map when present
      // so undefined never leaks onto the decoded message.
      const rsMap = p['map'];
      return {
        type: MsgType.ROOM_STATE,
        roomId: p['roomId'] as string,
        phase: p['phase'] as GamePhase,
        youSlot: p['youSlot'] as number,
        players: p['players'] as RoomPlayer[],
        ...(typeof rsMap === 'string' ? { map: rsMap as MapKind } : {}),
      } satisfies RoomStateMsg;
    }
    case MsgType.MATCH_START: {
      // Decode config field-by-field so each wire field name appears explicitly
      // at the boundary — a rename in shared/protocol.ts then fails to compile
      // here instead of slipping through an opaque `as FeelParams` cast.
      const c = p['config'] as Record<string, unknown>;
      const config: FeelParams = {
        moveSpeed: c['moveSpeed'] as number,
        cornerAssist: c['cornerAssist'] as number,
        inputBufferMs: c['inputBufferMs'] as number,
      };
      // map/teams are optional (the relay omits them today → classic + team=slot
      // defaults inside the engine). Only attach them when present so an
      // undefined value never leaks onto the wire-decoded message.
      const map = p['map'];
      const teams = p['teams'];
      const inputDelayTicks = p['inputDelayTicks'];
      return {
        type: MsgType.MATCH_START,
        seed: p['seed'] as number,
        slot: p['slot'] as number,
        config,
        t0: p['t0'] as number,
        ...(typeof map === 'string' ? { map: map as MapKind } : {}),
        ...(Array.isArray(teams) ? { teams: teams as number[] } : {}),
        ...(typeof inputDelayTicks === 'number' ? { inputDelayTicks } : {}),
      } satisfies MatchStartMsg;
    }
    case MsgType.INPUT_BROADCAST:
      return {
        type: MsgType.INPUT_BROADCAST,
        t: p['t'] as number,
        inputs: p['inputs'] as SlotInput[],
      } satisfies InputBroadcastMsg;
    case MsgType.TICK_READY:
      return { type: MsgType.TICK_READY, t: p['t'] as number } satisfies TickReadyMsg;
    case MsgType.STALL_NOTICE:
      return {
        type: MsgType.STALL_NOTICE,
        t: p['t'] as number,
        waiting: p['waiting'] as number[],
      } satisfies StallNoticeMsg;
    case MsgType.HASH_MISMATCH:
      return {
        type: MsgType.HASH_MISMATCH,
        t: p['t'] as number,
        hashes: p['hashes'] as number[],
      } satisfies HashMismatchMsg;
    case MsgType.PLAYER_DISCONNECT:
      return {
        type: MsgType.PLAYER_DISCONNECT,
        slot: p['slot'] as number,
      } satisfies PlayerDisconnectMsg;
    case MsgType.LEADERBOARD:
      return {
        type: MsgType.LEADERBOARD,
        entries: p['entries'] as LeaderboardEntry[],
      } satisfies LeaderboardMsg;
    default:
      throw new Error(`unknown server message type 0x${type.toString(16)}`);
  }
}
