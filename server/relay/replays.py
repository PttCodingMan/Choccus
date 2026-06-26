"""Replay-upload storage: persist a loser's self-contained match replay.

A client uploads a finished match (seed + map + teams + dense per-tick inputs +
frozen config) at OVER (see shared/protocol.ts ReplayUploadMsg). The relay never
simulates, so it just validates the shape, bounds the size, and writes it to disk
for offline analysis — the sim-runner converts it into a fixture so
``npm run replay -- replays/<file>.json`` re-runs the match bit-for-bit (see
tools/sim-runner/src/replay.ts ``replayFromUpload``).

DEFENSIVE: the payload is UNTRUSTED. Every field is validated and bounded
(MAX_REPLAY_TICKS / MAX_REPLAY_SLOTS / MAX_PLAYERS) before any disk write, and a
malformed payload is dropped (returns None) without raising — a bad upload must
never take down the room. The written document carries a ``schema`` tag the
sim-runner detects, plus the server wall-clock timestamp (the relay is not the
sim, so wall-clock is fine here).
"""

import json
import os
import re
from datetime import datetime, timezone
from typing import Any

from .constants import (
    MAX_PLAYERS,
    MAX_REPLAY_SLOTS,
    MAX_REPLAY_TICKS,
)

#: Schema tag written into every stored doc; the sim-runner loader keys on it.
REPLAY_SCHEMA = "choccus-replay-upload-v1"

#: Directory uploads land in (runtime data — git-ignored, never committed).
DEFAULT_REPLAY_DIR = os.environ.get(
    "CHOCCUS_REPLAY_DIR",
    os.path.join(os.path.dirname(os.path.dirname(__file__)), "replays"),
)

#: Accepted result strings (relative to the uploader).
_RESULTS = ("win", "loss", "draw")


def _as_int(value: Any) -> int | None:
    """Coerce a msgpack number to int, or None if it isn't a finite integer."""
    if isinstance(value, bool):  # bool is an int subclass — reject explicitly
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None


def _validate_upload(payload: dict[str, Any]) -> dict[str, Any] | None:
    """Return a sanitised, bounded replay doc, or None if the payload is bogus.

    Mirrors the relay's other untrusted-input bounding: caps tick/slot counts so
    one upload can't OOM the relay or fill the disk, and rejects (rather than
    repairs) anything structurally wrong."""
    seed = _as_int(payload.get("seed"))
    if seed is None or not (0 <= seed <= 0xFFFFFFFF):
        return None

    num_players = _as_int(payload.get("numPlayers"))
    if num_players is None or not (1 <= num_players <= MAX_PLAYERS):
        return None

    teams = payload.get("teams")
    if not isinstance(teams, list) or len(teams) != num_players:
        return None
    teams_clean: list[int] = []
    for t in teams:
        ti = _as_int(t)
        if ti is None or ti < 0 or ti >= MAX_PLAYERS:
            return None
        teams_clean.append(ti)

    t0 = _as_int(payload.get("t0"))
    if t0 is None or t0 != 0:  # net matches start at tick 0; the runner has no offset
        return None

    config = payload.get("config")
    if not isinstance(config, dict):
        return None
    config_clean: dict[str, float] = {}
    for key in ("moveSpeed", "cornerAssist", "inputBufferMs"):
        v = config.get(key)
        if not isinstance(v, (int, float)) or isinstance(v, bool):
            return None
        config_clean[key] = float(v)

    inputs = payload.get("inputs")
    if not isinstance(inputs, list) or len(inputs) > MAX_REPLAY_TICKS:
        return None
    inputs_clean: list[dict[str, Any]] = []
    for frame in inputs:
        if not isinstance(frame, dict):
            return None
        ft = _as_int(frame.get("t"))
        if ft is None or ft < 0:
            return None
        slots = frame.get("slots")
        if (
            not isinstance(slots, list)
            or len(slots) != num_players
            or len(slots) > MAX_REPLAY_SLOTS
        ):
            return None
        slots_clean: list[dict[str, int]] = []
        for s in slots:
            if not isinstance(s, dict):
                return None
            dirs = _as_int(s.get("dirs"))
            actions = _as_int(s.get("actions"))
            if dirs is None or actions is None:
                return None
            slots_clean.append({"dirs": dirs, "actions": actions})
        inputs_clean.append({"t": ft, "slots": slots_clean})

    result = payload.get("result")
    result_clean = result if result in _RESULTS else None

    winner = payload.get("winnerTeam")
    winner_clean = _as_int(winner) if winner is not None else None

    map_ = payload.get("map")
    map_clean = map_ if isinstance(map_, str) and map_ else "classic"

    return {
        "schema": REPLAY_SCHEMA,
        "seed": seed,
        "map": map_clean,
        "teams": teams_clean,
        "numPlayers": num_players,
        "t0": t0,
        "config": config_clean,
        "inputs": inputs_clean,
        "result": result_clean,
        "winnerTeam": winner_clean,
    }


def _safe_name(parts: str) -> str:
    """Filesystem-safe filename fragment (no traversal / odd chars)."""
    return re.sub(r"[^0-9A-Za-z._-]", "", parts)


def store_replay(
    payload: dict[str, Any], replay_dir: str | None = None
) -> str | None:
    """Validate + persist an uploaded replay. Returns the file path, or None if
    the payload was rejected (over-cap / malformed). Never raises on bad input.

    `replay_dir` defaults to the module-level DEFAULT_REPLAY_DIR resolved at call
    time (so tests can monkeypatch it)."""
    if replay_dir is None:
        replay_dir = DEFAULT_REPLAY_DIR
    doc = _validate_upload(payload)
    if doc is None:
        return None
    # Filename = server wall-clock timestamp + seed (the relay is not the sim, so
    # wall-clock is fine here); both sanitised against path traversal.
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S_%f")
    doc["uploadedAt"] = datetime.now(timezone.utc).isoformat()
    name = f"{_safe_name(stamp)}_seed{doc['seed']}.json"
    try:
        os.makedirs(replay_dir, exist_ok=True)
        path = os.path.join(replay_dir, name)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(doc, fh)
        return path
    except OSError:
        # Disk full / permissions — log via caller; never crash the room.
        return None
