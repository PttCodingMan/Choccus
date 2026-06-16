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
