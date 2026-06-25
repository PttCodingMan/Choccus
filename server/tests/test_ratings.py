"""RatingStore tests (in-memory SQLite, no relay)."""

from relay.lobby import Lobby
from relay.protocol import MsgType, decode
from relay.ratings import DEFAULT_MU, DEFAULT_SIGMA, RatingStore, synthetic_bot_id
from relay.relay_server import RelayServer


def noop(_data: bytes) -> None:
    pass


def parts(*ids_teams):
    return [{"player_id": i, "name": i, "team": t} for i, t in ids_teams]


def test_default_rating_for_unseen_player():
    s = RatingStore()
    assert s.get("nobody") == (DEFAULT_MU, DEFAULT_SIGMA)


def test_winner_gains_loser_loses_and_persists():
    s = RatingStore()
    out = s.apply_match(parts(("a", 0), ("b", 1)), winner_team=0)
    assert out["a"] > 0 > out["b"]  # ordinals diverge from 0
    # μ persisted: a went up, b down.
    assert s.get("a")[0] > DEFAULT_MU
    assert s.get("b")[0] < DEFAULT_MU


def test_draw_keeps_mu_but_shrinks_sigma():
    s = RatingStore()
    s.apply_match(parts(("a", 0), ("b", 1)), winner_team=None)
    mu, sigma = s.get("a")
    assert abs(mu - DEFAULT_MU) < 1e-6
    assert sigma < DEFAULT_SIGMA


def test_bot_is_rated_like_a_player():
    s = RatingStore()
    bot = synthetic_bot_id("hard")
    s.apply_match(parts(("human", 0), (bot, 1)), winner_team=1)  # bot wins
    assert s.get(bot)[0] > DEFAULT_MU
    assert s.get("human")[0] < DEFAULT_MU


def test_fewer_than_two_teams_is_noop():
    s = RatingStore()
    assert s.apply_match(parts(("a", 0), ("b", 0)), winner_team=0) == {}
    assert s.get("a") == (DEFAULT_MU, DEFAULT_SIGMA)


def test_games_accumulate_across_matches():
    s = RatingStore()
    s.apply_match(parts(("a", 0), ("b", 1)), winner_team=0)
    s.apply_match(parts(("a", 0), ("b", 1)), winner_team=0)
    games = s._db.execute("SELECT games FROM ratings WHERE player_id='a'").fetchone()[0]
    assert games == 2


def test_top_orders_by_score_excludes_unplayed_and_respects_limit():
    s = RatingStore()
    # a beats b twice (a climbs, b drops); c never plays (default rating).
    s.apply_match(parts(("a", 0), ("b", 1)), winner_team=0)
    s.apply_match(parts(("a", 0), ("b", 1)), winner_team=0)
    s.get("c")  # a pure read must NOT create a row
    rows = s.top(10)
    ids = [r["playerId"] for r in rows]
    assert ids == ["a", "b"]  # c excluded (no games), a before b (higher score)
    assert rows[0]["score"] > rows[1]["score"]
    assert rows[0]["games"] == 2
    # limit caps the row count.
    assert len(s.top(1)) == 1


def test_top_includes_bots():
    s = RatingStore()
    bot = synthetic_bot_id("hard")
    s.apply_match(parts(("human", 0), (bot, 1)), winner_team=1)  # bot wins
    ids = [r["playerId"] for r in s.top(10)]
    assert bot in ids
    assert s.top(10)[0]["playerId"] == bot  # the winner tops the board


def test_relay_get_leaderboard_dispatch():
    """GET_LEADERBOARD routes to a LEADERBOARD reply with the top rows."""
    server = RelayServer(db_path=":memory:")
    server.store.apply_match(parts(("a", 0), ("b", 1)), winner_team=0)
    sent: list[bytes] = []
    conn = type(
        "C", (), {"room": None, "slot": None, "send": lambda self, d: sent.append(d)}
    )()
    server._dispatch(conn, MsgType.GET_LEADERBOARD, {"limit": 5})
    assert len(sent) == 1
    type_id, payload = decode(sent[0])
    assert type_id == MsgType.LEADERBOARD
    assert payload["entries"][0]["playerId"] == "a"


def _started_two_human_room(store):
    room = Lobby(store=store).create_room()
    room.add_player("alice", noop, "pid-a")
    room.add_player("bob", noop, "pid-b")
    room.set_ready(0, True)
    room.set_ready(1, True)
    room.start_match()
    return room


def test_room_apply_result_rates_on_full_consensus_once():
    store = RatingStore()
    room = _started_two_human_room(store)
    # Only one human reported -> buffered, not yet rated.
    assert room.apply_result(0, winner_team=0) is False
    assert store.get("pid-a") == (DEFAULT_MU, DEFAULT_SIGMA)
    # Second human agrees -> rated exactly once.
    assert room.apply_result(1, winner_team=0) is True  # alice (slot 0) wins
    assert room.apply_result(0, winner_team=0) is False  # locked after rating
    assert store.get("pid-a")[0] > DEFAULT_MU > store.get("pid-b")[0]


def test_room_apply_result_disagreement_is_not_rated_and_locks_out():
    store = RatingStore()
    room = _started_two_human_room(store)
    assert room.apply_result(0, winner_team=0) is False  # alice claims herself
    assert room.apply_result(1, winner_team=1) is False  # bob claims himself
    # Disputed: nothing applied, and a later "honest" re-report can't game it.
    assert store.get("pid-a") == (DEFAULT_MU, DEFAULT_SIGMA)
    assert store.get("pid-b") == (DEFAULT_MU, DEFAULT_SIGMA)
    assert room.apply_result(0, winner_team=0) is False


def test_room_apply_result_lone_connected_human_single_report_counts():
    store = RatingStore()
    room = _started_two_human_room(store)
    room.remove_player(1)  # bob disconnects mid-match (slot kept, not connected)
    # Only one human is connected -> its single report is accepted (degenerate).
    assert room.apply_result(0, winner_team=0) is True
    assert store.get("pid-a")[0] > DEFAULT_MU


def test_room_apply_result_ignores_bot_and_unknown_slots():
    store = RatingStore()
    room = _started_two_human_room(store)
    assert room.apply_result(9, winner_team=0) is False  # no such slot
    # Real humans still drive consensus afterwards.
    assert room.apply_result(0, winner_team=0) is False
    assert room.apply_result(1, winner_team=0) is True
