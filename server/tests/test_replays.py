"""Replay-upload storage: validation, size caps, and the on-disk schema."""

import json

from relay.constants import MAX_REPLAY_TICKS
from relay.replays import REPLAY_SCHEMA, store_replay


def _frame(t: int, num_players: int = 2):
    return {
        "t": t,
        "slots": [{"dirs": 0, "actions": 0} for _ in range(num_players)],
    }


def _valid_payload(num_ticks: int = 3, num_players: int = 2) -> dict:
    return {
        "seed": 12345,
        "map": "classic",
        "teams": [0, 1] if num_players == 2 else list(range(num_players)),
        "numPlayers": num_players,
        "t0": 0,
        "config": {"moveSpeed": 5.0, "cornerAssist": 0.25, "inputBufferMs": 120},
        "inputs": [_frame(t, num_players) for t in range(num_ticks)],
        "result": "loss",
        "winnerTeam": 1,
    }


def test_stores_valid_replay_with_schema_tag(tmp_path):
    path = store_replay(_valid_payload(), replay_dir=str(tmp_path))
    assert path is not None
    with open(path, encoding="utf-8") as fh:
        doc = json.load(fh)
    assert doc["schema"] == REPLAY_SCHEMA
    assert doc["seed"] == 12345
    assert doc["map"] == "classic"
    assert doc["teams"] == [0, 1]
    assert doc["numPlayers"] == 2
    assert doc["t0"] == 0
    assert len(doc["inputs"]) == 3
    assert doc["result"] == "loss"
    assert doc["winnerTeam"] == 1
    assert "uploadedAt" in doc  # server wall-clock provenance


def test_filename_carries_seed(tmp_path):
    path = store_replay(_valid_payload(), replay_dir=str(tmp_path))
    assert path is not None
    assert path.endswith(".json")
    assert "seed12345" in path


def test_rejects_oversized_tick_count(tmp_path):
    # An upload claiming more ticks than a match could ever run is bogus.
    payload = _valid_payload(num_ticks=1)
    payload["inputs"] = [_frame(t) for t in range(MAX_REPLAY_TICKS + 1)]
    assert store_replay(payload, replay_dir=str(tmp_path)) is None
    assert list(tmp_path.iterdir()) == []  # nothing written


def test_rejects_oversized_slot_array(tmp_path):
    payload = _valid_payload()
    # A frame wider than numPlayers (and the MAX_PLAYERS cap) is malformed.
    payload["inputs"][0]["slots"] = [{"dirs": 0, "actions": 0} for _ in range(9)]
    assert store_replay(payload, replay_dir=str(tmp_path)) is None


def test_rejects_too_many_players(tmp_path):
    payload = _valid_payload(num_players=2)
    payload["numPlayers"] = 99
    assert store_replay(payload, replay_dir=str(tmp_path)) is None


def test_rejects_malformed_without_raising(tmp_path):
    # Each of these is structurally wrong; none may raise.
    assert store_replay({}, replay_dir=str(tmp_path)) is None
    assert store_replay({"seed": "nope"}, replay_dir=str(tmp_path)) is None
    bad_teams = _valid_payload()
    bad_teams["teams"] = [0]  # length != numPlayers
    assert store_replay(bad_teams, replay_dir=str(tmp_path)) is None
    bad_t0 = _valid_payload()
    bad_t0["t0"] = 5  # runner starts at tick 0; nonzero t0 is rejected
    assert store_replay(bad_t0, replay_dir=str(tmp_path)) is None
    bad_config = _valid_payload()
    bad_config["config"] = {"moveSpeed": 5.0}  # missing keys
    assert store_replay(bad_config, replay_dir=str(tmp_path)) is None
    assert list(tmp_path.iterdir()) == []  # nothing written for any of them


def test_seed_out_of_uint32_range_rejected(tmp_path):
    payload = _valid_payload()
    payload["seed"] = 2**32  # one past the uint32 ceiling
    assert store_replay(payload, replay_dir=str(tmp_path)) is None


def test_missing_map_defaults_to_classic(tmp_path):
    payload = _valid_payload()
    del payload["map"]
    path = store_replay(payload, replay_dir=str(tmp_path))
    assert path is not None
    with open(path, encoding="utf-8") as fh:
        assert json.load(fh)["map"] == "classic"


def test_bot_loss_tag_stored(tmp_path):
    payload = _valid_payload()
    payload["botLoss"] = [{"slot": 1, "difficulty": "hard"}]
    path = store_replay(payload, replay_dir=str(tmp_path))
    assert path is not None
    with open(path, encoding="utf-8") as fh:
        assert json.load(fh)["botLoss"] == [{"slot": 1, "difficulty": "hard"}]


def test_bot_loss_absent_when_omitted(tmp_path):
    path = store_replay(_valid_payload(), replay_dir=str(tmp_path))
    assert path is not None
    with open(path, encoding="utf-8") as fh:
        assert "botLoss" not in json.load(fh)


def test_bot_loss_malformed_entries_dropped_not_rejected(tmp_path):
    # A bogus botLoss entry doesn't sink the whole (otherwise valid) replay.
    payload = _valid_payload()
    payload["botLoss"] = [
        {"slot": 1, "difficulty": "hard"},
        {"slot": 99, "difficulty": "hard"},  # out of range
        {"slot": 0, "difficulty": ""},  # empty
        {"slot": 0},  # missing difficulty
        "nope",  # not even a dict
    ]
    path = store_replay(payload, replay_dir=str(tmp_path))
    assert path is not None
    with open(path, encoding="utf-8") as fh:
        assert json.load(fh)["botLoss"] == [{"slot": 1, "difficulty": "hard"}]
