"""Python mirror of shared/protocol.ts — wire encoding for the relay.

shared/protocol.ts is the SINGLE SOURCE OF TRUTH for message-type ids and
field names; this module mirrors it by hand. Keep both in sync.

Wire format: ``[1-byte MsgType id][MessagePack payload]``. The ``type`` field
of each TS message interface is the discriminated-union tag and is carried by
the 1-byte header — it is NOT duplicated inside the msgpack payload.

Builders below return fully encoded ``bytes`` ready to send. ``decode``
returns ``(type_id, payload_dict)``.
"""

from enum import IntEnum
from typing import Any

import msgpack


class MsgType(IntEnum):
    """Mirror of shared/protocol.ts MsgType. C→S: 0x01–0x0F, S→C: 0x10–0x1F."""

    # Client → Server
    JOIN_ROOM = 0x01
    LEAVE_ROOM = 0x02
    READY_TOGGLE = 0x03
    INPUT_FRAME = 0x04
    HASH_REPORT = 0x05
    ADD_BOT = 0x06
    REMOVE_BOT = 0x07
    MATCH_RESULT = 0x08
    GET_LEADERBOARD = 0x09
    REPLAY_UPLOAD = 0x0A
    SET_ROOM_SETTINGS = 0x0B
    SET_PLAYER_TEAM = 0x0C

    # Server → Client
    ROOM_STATE = 0x10
    MATCH_START = 0x11
    INPUT_BROADCAST = 0x12
    TICK_READY = 0x13
    STALL_NOTICE = 0x14
    HASH_MISMATCH = 0x15
    PLAYER_DISCONNECT = 0x16
    LEADERBOARD = 0x17


#: Selectable map kinds (mirror of client/src/sim/Map.ts MAP_KINDS). The relay
#: never simulates, so it only needs to validate the host's pick against this
#: allow-list; add a key here whenever a new authored map ships client-side.
MAP_KINDS = ("classic", "pirate", "village")
DEFAULT_MAP = "classic"


# ---------------------------------------------------------------------------
# Framing
# ---------------------------------------------------------------------------


def encode(type_id: int, payload: dict[str, Any] | None = None) -> bytes:
    """Frame a message: 1-byte type id + msgpack payload."""
    return bytes([type_id]) + msgpack.packb(payload or {}, use_bin_type=True)


def decode(data: bytes) -> tuple[int, dict[str, Any]]:
    """Split a frame into (type_id, payload dict). Raises on malformed data."""
    if len(data) < 1:
        raise ValueError("empty frame")
    payload = msgpack.unpackb(data[1:], raw=False)
    if not isinstance(payload, dict):
        raise ValueError(f"payload is not a map: {type(payload).__name__}")
    return data[0], payload


# ---------------------------------------------------------------------------
# Client → Server builders (used by tests / smoke client)
# ---------------------------------------------------------------------------


def join_room(room_id: str, name: str, player_id: str = "") -> bytes:
    """JoinRoomMsg — roomId '' means create a new room."""
    return encode(
        MsgType.JOIN_ROOM,
        {"roomId": room_id, "name": name, "playerId": player_id},
    )


def match_result(winner_team: int | None) -> bytes:
    """MatchResultMsg — winning team (= winning slot in FFA), or None for a draw."""
    return encode(MsgType.MATCH_RESULT, {"winnerTeam": winner_team})


def leave_room() -> bytes:
    return encode(MsgType.LEAVE_ROOM, {})


def ready_toggle(ready: bool) -> bytes:
    return encode(MsgType.READY_TOGGLE, {"ready": ready})


def add_bot(slot: int, difficulty: str = "normal") -> bytes:
    return encode(MsgType.ADD_BOT, {"slot": slot, "difficulty": difficulty})


def remove_bot(slot: int) -> bytes:
    return encode(MsgType.REMOVE_BOT, {"slot": slot})


def input_frame(t: int, dirs: int, actions: int) -> bytes:
    return encode(MsgType.INPUT_FRAME, {"t": t, "dirs": dirs, "actions": actions})


def hash_report(t: int, hash_: int) -> bytes:
    return encode(MsgType.HASH_REPORT, {"t": t, "hash": hash_})


def get_leaderboard(limit: int = 10) -> bytes:
    return encode(MsgType.GET_LEADERBOARD, {"limit": limit})


def set_room_settings(map_: str) -> bytes:
    """SetRoomSettingsMsg — host's map pick (relay ignores non-hosts)."""
    return encode(MsgType.SET_ROOM_SETTINGS, {"map": map_})


def set_player_team(slot: int, team: int) -> bytes:
    """SetPlayerTeamMsg — manual per-slot team (host: any slot; non-host: own only)."""
    return encode(MsgType.SET_PLAYER_TEAM, {"slot": slot, "team": team})


def replay_upload(
    seed: int,
    map_: str,
    teams: list[int],
    num_players: int,
    t0: int,
    config: dict[str, Any],
    inputs: list[dict[str, Any]],
    result: str,
    winner_team: int | None,
) -> bytes:
    """ReplayUploadMsg — a self-contained match replay.

    inputs: [{"t": tick, "slots": [{"dirs", "actions"}, …]}, …] (dense, in tick
    order). result is 'win' | 'loss' | 'draw' relative to the uploader. Phase 2b
    adds the relay-side storage that consumes this; the shape is locked here.
    """
    return encode(
        MsgType.REPLAY_UPLOAD,
        {
            "seed": seed,
            "map": map_,
            "teams": teams,
            "numPlayers": num_players,
            "t0": t0,
            "config": config,
            "inputs": inputs,
            "result": result,
            "winnerTeam": winner_team,
        },
    )


# ---------------------------------------------------------------------------
# Server → Client builders
# ---------------------------------------------------------------------------


def room_state(
    room_id: str,
    phase: int,
    you_slot: int,
    players: list[dict[str, Any]],
    map_: str | None = None,
) -> bytes:
    """RoomStateMsg — players: [{slot, name, ready, connected, isBot, botDifficulty, score, team}], youSlot per receiver.

    map is the host's current map pick, reflected so every client's picker stays
    in sync. Per-slot teams ride on each player entry (`team`). map is optional:
    omitted keeps the payload byte-identical to pre-Phase-2 (client → classic).
    """
    payload: dict[str, Any] = {
        "roomId": room_id,
        "phase": phase,
        "youSlot": you_slot,
        "players": players,
    }
    if map_ is not None:
        payload["map"] = map_
    return encode(MsgType.ROOM_STATE, payload)


def match_start(
    seed: int,
    slot: int,
    config: dict[str, Any],
    t0: int,
    map_: str | None = None,
    teams: list[int] | None = None,
    input_delay_ticks: int | None = None,
) -> bytes:
    """MatchStartMsg — config is the frozen FeelParams dict (moveSpeed, …).

    map/teams/input_delay_ticks are OPTIONAL. The room passes its current map
    (omitted when the default 'classic') and its manual per-slot teams array
    (omitted when it equals the default team[i]=i, so an untouched FFA/classic
    room stays byte-identical to before). When present, `teams` is full-length
    (one entry per slot). input_delay_ticks is the room's ping-measured
    lockstep buffer (see room.start_match); omitted only by callers that don't
    care (tests) — the client falls back to the shared constant either way.
    """
    payload: dict[str, Any] = {"seed": seed, "slot": slot, "config": config, "t0": t0}
    if map_ is not None:
        payload["map"] = map_
    if teams is not None:
        payload["teams"] = teams
    if input_delay_ticks is not None:
        payload["inputDelayTicks"] = input_delay_ticks
    return encode(MsgType.MATCH_START, payload)


def input_broadcast(t: int, inputs: list[dict[str, int]]) -> bytes:
    """InputBroadcastMsg — inputs: [{dirs, actions}] indexed by slot."""
    return encode(MsgType.INPUT_BROADCAST, {"t": t, "inputs": inputs})


def tick_ready(t: int) -> bytes:
    return encode(MsgType.TICK_READY, {"t": t})


def stall_notice(t: int, waiting: list[int]) -> bytes:
    """StallNoticeMsg — waiting: slots the server is still waiting on."""
    return encode(MsgType.STALL_NOTICE, {"t": t, "waiting": waiting})


def hash_mismatch(t: int, hashes: list[int]) -> bytes:
    """HashMismatchMsg — hashes: uint32 per slot, indexed by slot (0 = no report)."""
    return encode(MsgType.HASH_MISMATCH, {"t": t, "hashes": hashes})


def player_disconnect(slot: int) -> bytes:
    return encode(MsgType.PLAYER_DISCONNECT, {"slot": slot})


def leaderboard(entries: list[dict[str, Any]]) -> bytes:
    """LeaderboardMsg — entries: [{playerId, name, score, games}], score desc."""
    return encode(MsgType.LEADERBOARD, {"entries": entries})
