"""Lobby / Room membership tests (no sockets — fake send callbacks)."""

from relay.constants import MAX_PLAYERS, GamePhase
from relay.lobby import Lobby
from util.id_gen import ROOM_ID_ALPHABET, ROOM_ID_LENGTH, generate_room_id


def noop(_data: bytes) -> None:
    pass


def test_create_then_join_assigns_slots_in_order():
    lobby = Lobby()
    room = lobby.create_room()
    assert lobby.get(room.room_id) is room
    assert room.add_player("alice", noop) == 0
    assert room.add_player("bob", noop) == 1
    assert room.players[0].name == "alice"
    assert room.players[1].name == "bob"


def test_leave_frees_slot_for_next_join():
    lobby = Lobby()
    room = lobby.create_room()
    room.add_player("alice", noop)
    room.add_player("bob", noop)
    room.remove_player(0)  # lobby phase: slot is freed
    assert 0 not in room.players
    assert room.add_player("carol", noop) == 0


def test_room_full_rejects_fifth_player():
    room = Lobby().create_room()
    for i in range(MAX_PLAYERS):
        assert room.add_player(f"p{i}", noop) == i
    assert room.add_player("late", noop) is None


def test_join_rejected_once_playing():
    room = Lobby().create_room()
    room.add_player("alice", noop)
    room.set_ready(0, True)
    room.start_match()
    assert room.phase == GamePhase.PLAYING
    assert room.add_player("late", noop) is None


def test_remove_room():
    lobby = Lobby()
    room = lobby.create_room()
    lobby.remove_room(room.room_id)
    assert lobby.get(room.room_id) is None
    assert lobby.list_rooms() == []


def test_room_id_format_and_uniqueness():
    seen = set()
    for _ in range(500):
        rid = generate_room_id(taken=seen)
        assert len(rid) == ROOM_ID_LENGTH
        assert all(c in ROOM_ID_ALPHABET for c in rid)
        assert rid not in seen
        seen.add(rid)


def test_all_ready_requires_everyone():
    room = Lobby().create_room()
    room.add_player("alice", noop)
    room.add_player("bob", noop)
    assert not room.all_ready()
    room.set_ready(0, True)
    assert not room.all_ready()
    room.set_ready(1, True)
    assert room.all_ready()
    room.set_ready(1, False)
    assert not room.all_ready()


def test_empty_room_has_no_ready():
    room = Lobby().create_room()
    assert not room.all_ready()
    assert room.is_empty()


def test_can_start_requires_at_least_two_players():
    # M5 start rule: a solo player readying up must NOT start a match.
    room = Lobby().create_room()
    room.add_player("alice", noop)
    room.set_ready(0, True)
    assert room.all_ready()
    assert not room.can_start()
    room.add_player("bob", noop)
    assert not room.can_start()  # bob not ready yet
    room.set_ready(1, True)
    assert room.can_start()


def test_reset_to_lobby_enables_rematch():
    room = Lobby().create_room()
    room.add_player("alice", noop)
    room.add_player("bob", noop)
    room.set_ready(0, True)
    room.set_ready(1, True)
    room.start_match()
    assert room.phase == GamePhase.PLAYING
    first_seed = room.seed

    room.reset_to_lobby()
    assert room.phase == GamePhase.LOBBY
    assert room.coordinator is None
    assert room.seed is None
    assert all(not p.ready for p in room.players.values())
    # Survivors keep their slots and a fresh match can start.
    assert [p.name for _, p in sorted(room.players.items())] == ["alice", "bob"]
    room.set_ready(0, True)
    room.set_ready(1, True)
    assert room.can_start()
    room.start_match()
    assert room.phase == GamePhase.PLAYING
    assert room.seed is not None
    assert room.seed != first_seed  # freshly drawn (2**-32 flake odds)


def test_reset_to_lobby_drops_disconnected_players():
    room = Lobby().create_room()
    room.add_player("alice", noop)
    room.add_player("bob", noop)
    room.set_ready(0, True)
    room.set_ready(1, True)
    room.start_match()
    room.remove_player(1)  # in-game: marked disconnected, slot kept
    assert 1 in room.players and not room.players[1].connected

    room.reset_to_lobby()
    assert 1 not in room.players  # disconnected slot freed for new joins
    assert room.add_player("carol", noop) == 1


def test_reset_to_lobby_is_noop_in_lobby_phase():
    room = Lobby().create_room()
    room.add_player("alice", noop)
    room.set_ready(0, True)
    room.reset_to_lobby()
    assert room.players[0].ready  # untouched: room was already in LOBBY


def _capture_match_start():
    """A (send_cb, sent_list) pair capturing MatchStart payloads sent to a player."""
    from relay.protocol import MsgType, decode

    sent: list[dict] = []

    def capture(data: bytes) -> None:
        tid, payload = decode(data)
        if tid == MsgType.MATCH_START:
            sent.append(payload)

    return capture, sent


# -- host map pick + MANUAL per-slot teams ------------------------------------


def test_room_defaults_to_classic_and_ffa_teams():
    room = Lobby().create_room()
    assert room.map == "classic"
    # Default teams = slot index (FFA) for each added player.
    room.add_player("alice", noop)
    room.add_player("bob", noop)
    assert room.teams == {0: 0, 1: 1}


def test_host_slot_is_lowest_human():
    room = Lobby().create_room()
    assert room.host_slot is None  # empty room
    room.add_player("alice", noop)  # slot 0
    room.add_player("bob", noop)  # slot 1
    assert room.host_slot == 0
    room.remove_player(0)  # alice leaves (lobby: slot freed)
    assert room.host_slot == 1  # bob is now host


def test_host_can_change_map():
    room = Lobby().create_room()
    room.add_player("alice", noop)  # host = slot 0
    assert room.set_map(0, "pirate") is True
    assert room.map == "pirate"
    assert room.set_map(0, "pirate") is False  # no-op → False
    assert room.set_map(0, "atlantis") is False  # unknown map ignored
    assert room.map == "pirate"


def test_non_host_cannot_change_map():
    room = Lobby().create_room()
    room.add_player("alice", noop)  # host = slot 0
    room.add_player("bob", noop)  # slot 1, not host
    assert room.set_map(1, "pirate") is False
    assert room.map == "classic"


def test_map_locked_once_playing():
    room = Lobby().create_room()
    room.add_player("alice", noop)
    room.set_ready(0, True)
    room.start_match()
    assert room.set_map(0, "pirate") is False
    assert room.map == "classic"


def test_host_can_set_any_slot_team():
    room = Lobby().create_room()
    room.add_player("alice", noop)  # host = slot 0
    room.add_player("bob", noop)  # slot 1 (default team 1)
    room.add_bot(2, "normal")  # bot slot 2 (default team 2)
    # Host groups everyone: slots 1 & 2 onto team 0 (with alice's slot 0).
    assert room.set_player_team(0, 1, 0) is True  # move bob onto team 0
    assert room.set_player_team(0, 2, 0) is True  # move the bot onto team 0
    assert room.teams == {0: 0, 1: 0, 2: 0}
    # No-op change returns False.
    assert room.set_player_team(0, 1, 0) is False


def test_non_host_may_set_only_own_team():
    room = Lobby().create_room()
    room.add_player("alice", noop)  # host = slot 0
    room.add_player("bob", noop)  # slot 1, not host
    # bob can set his own team…
    assert room.set_player_team(1, 1, 2) is True
    assert room.teams[1] == 2
    # …but NOT alice's (cross-slot from a non-host is ignored).
    assert room.set_player_team(1, 0, 2) is False
    assert room.teams[0] == 0


def test_set_player_team_bounds_and_unknown_slot():
    room = Lobby().create_room()
    room.add_player("alice", noop)
    assert room.set_player_team(0, 0, -1) is False  # out of range
    assert room.set_player_team(0, 0, MAX_PLAYERS) is False  # out of range
    assert room.set_player_team(0, 3, 1) is False  # empty/unknown slot
    assert room.teams == {0: 0}


def test_team_locked_once_playing():
    room = Lobby().create_room()
    room.add_player("alice", noop)
    room.add_player("bob", noop)
    room.set_ready(0, True)
    room.set_ready(1, True)
    room.start_match()
    assert room.set_player_team(0, 1, 0) is False  # in-game change ignored


def test_remove_player_and_bot_prune_team_entries():
    room = Lobby().create_room()
    room.add_player("alice", noop)
    room.add_bot(1, "normal")
    assert room.teams == {0: 0, 1: 1}
    room.remove_bot(1)
    assert room.teams == {0: 0}
    room.remove_player(0)  # lobby: slot freed + team pruned
    assert room.teams == {}


def test_match_start_carries_manual_teams():
    # Manual teams (host groups 0&3 vs 1&2) → MatchStart.teams = [0,1,1,0],
    # full-length and identical on every client.
    capture, sent = _capture_match_start()
    room = Lobby().create_room()
    for _ in range(4):
        room.add_player("p", capture)
    room.set_map(0, "pirate")
    room.set_player_team(0, 1, 1)
    room.set_player_team(0, 2, 1)
    # slots 0 and 3 already default to teams 0 and 3 → regroup slot 3 onto team 0.
    room.set_player_team(0, 3, 0)
    for i in range(4):
        room.set_ready(i, True)
    room.start_match()
    assert len(sent) == 4
    for payload in sent:
        assert payload["map"] == "pirate"
        assert payload["teams"] == [0, 1, 1, 0]


def test_match_start_ffa_classic_omits_map_and_teams():
    # Untouched default room → MatchStart stays byte-identical to before (no
    # map/teams keys, since teams == default [0,1,…] and map == classic).
    capture, sent = _capture_match_start()
    room = Lobby().create_room()
    room.add_player("alice", capture)
    room.add_player("bob", capture)
    room.set_ready(0, True)
    room.set_ready(1, True)
    room.start_match()
    assert len(sent) == 2
    for payload in sent:
        assert "map" not in payload
        assert "teams" not in payload


# -- per-room ping-measured input delay (RelayServer._start_match picks this;
#    start_match() itself just has to thread whatever it's given through) ----


def test_start_match_default_delay_matches_shared_constant():
    from relay.constants import INPUT_DELAY_TICKS

    capture, sent = _capture_match_start()
    room = Lobby().create_room()
    room.add_player("alice", capture)
    room.add_player("bob", capture)
    room.set_ready(0, True)
    room.set_ready(1, True)
    room.start_match()  # no arg → the shared floor, same as before this feature
    assert sent[0]["inputDelayTicks"] == INPUT_DELAY_TICKS


def test_start_match_custom_delay_reaches_match_start_and_coordinator():
    capture, sent = _capture_match_start()
    room = Lobby().create_room()
    room.add_player("alice", capture)
    room.add_player("bob", capture)
    room.set_ready(0, True)
    room.set_ready(1, True)
    room.start_match(input_delay_ticks=7)
    assert sent[0]["inputDelayTicks"] == 7
    assert sent[1]["inputDelayTicks"] == 7
    assert room.coordinator.next_tick == 7  # TickCoordinator.first_tick


def test_match_start_teams_span_all_slots():
    # A 2v2 of 4 players → full-length per-slot array even when only some slots
    # were regrouped (here only slot 1 moved; the rest keep their defaults).
    capture, sent = _capture_match_start()
    room = Lobby().create_room()
    for _ in range(4):
        room.add_player("p", capture)
    room.set_player_team(0, 1, 0)  # slot 1 joins team 0
    room.set_ready(0, True)
    room.set_ready(1, True)
    room.set_ready(2, True)
    room.set_ready(3, True)
    room.start_match()
    assert len(sent) == 4
    for payload in sent:
        assert payload["teams"] == [0, 0, 2, 3]  # full-length, slot 1 → team 0
