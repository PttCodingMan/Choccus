"""Hand-aligned Python mirror of the few shared constants the relay needs.

shared/constants.ts and shared/types.ts are the single source of truth;
update this file whenever the netcode-relevant values there change.
The server never simulates, so only lobby/lockstep constants live here.
"""

from enum import IntEnum

# --- Lockstep netcode (shared/constants.ts) --------------------------------

#: Local input at tick T is scheduled for sim tick T + INPUT_DELAY_TICKS.
#: The relay therefore expects the first InputFrame for tick t0 + this value;
#: ticks t0 .. t0 + INPUT_DELAY_TICKS - 1 use implicit neutral input client-side.
INPUT_DELAY_TICKS = 2

#: Missing-input stall tolerance before the server broadcasts StallNotice.
STALL_TIMEOUT_MS = 200

#: Clients report their state hash every N ticks for desync detection.
HASH_REPORT_INTERVAL = 30

#: Max ticks a client may legitimately run ahead of the relay's next_tick.
#: Clients only ever send for currentTick + INPUT_DELAY_TICKS, so this is a
#: tight bound comfortably above any real lead — it caps how far forward the
#: coordinator buffers inputs/hashes so a flooding client can't grow those
#: dicts without bound (remote OOM). Out-of-window ticks are silently dropped.
MAX_TICK_LEAD = INPUT_DELAY_TICKS + HASH_REPORT_INTERVAL * 2

#: Recent InputBroadcasts buffered per match for reconnect catch-up (M5).
INPUT_HISTORY_SIZE = 64

# --- Rooms ------------------------------------------------------------------

#: One slot per spawn corner of the 15x13 map.
MAX_PLAYERS = 4

# --- Match cap (shared/constants.ts MATCH_MAX_TICKS) ------------------------

#: Hard upper bound on a match's tick count (180 s * 60 Hz = 10800). An uploaded
#: replay claiming more ticks than this cannot be a real match. Mirror of
#: shared/constants.ts MATCH_MAX_TICKS; update together.
MATCH_MAX_TICKS = 10800

# --- Replay upload caps (untrusted client data) ----------------------------
# An uploaded replay is attacker-controlled. It is bounded here so one bad
# upload can never OOM the relay or fill the disk (mirrors the lockstep tick/
# input bounding TickCoordinator already does). Over-cap or malformed uploads
# are dropped silently, exactly like other invalid client input.

#: Max ticks an uploaded replay may contain (slack above MATCH_MAX_TICKS for the
#: INPUT_DELAY warmup frames; anything beyond is bogus).
MAX_REPLAY_TICKS = MATCH_MAX_TICKS + 64
#: Max slots per replay tick frame (= MAX_PLAYERS; a wider frame is malformed).
MAX_REPLAY_SLOTS = MAX_PLAYERS
#: Max length of a host's map/format setting string before allow-list validation.
MAX_ROOM_SETTING_LEN = 32

# --- Untrusted input caps ---------------------------------------------------
# Client-supplied strings are re-broadcast to peers and written to SQLite, so
# they are truncated on ingest to keep one client from bloating frames/storage
# (the default 1 MiB ws frame is the only other limit). Truncation is silent.

#: Max display-name length (chars).
MAX_NAME_LEN = 32
#: Max room id length (chars).
MAX_ROOM_ID_LEN = 24
#: Max rating-ladder player id length (chars).
MAX_PLAYER_ID_LEN = 64
#: Max length of the playerId field before HMAC verification. A signed session
#: token (see relay/auth.py) is far longer than a bare id, so the field is
#: pre-capped to this token-sized bound; only the verified/short fallback id is
#: then capped to MAX_PLAYER_ID_LEN. Bounds HMAC work per join (anti-flood).
MAX_AUTH_TOKEN_LEN = 1024

# --- Feel parameters (shared/constants.ts defaults) -------------------------

#: Authoritative FeelParams sent with MatchStart so every client simulates
#: with identical values. Field names match shared/protocol.ts `FeelParams`.
DEFAULT_FEEL_PARAMS = {
    "moveSpeed": 5.0,      # tiles/s (3-8)
    "cornerAssist": 0.25,  # tiles (0-0.5)
    "inputBufferMs": 120,  # ms (0-250)
}


class GamePhase(IntEnum):
    """Mirror of shared/types.ts GamePhase."""

    LOBBY = 0
    PLAYING = 1
    OVER = 2
