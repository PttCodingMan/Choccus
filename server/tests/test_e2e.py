"""End-to-end wire tests: real websockets server + two real clients.

Proves the framing, dispatch and lobby->match flow work over actual sockets;
the detailed lockstep behaviour is covered by the unit tests.
"""

import asyncio

import pytest
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

from relay import protocol
from relay.constants import MAX_NAME_LEN, MAX_ROOM_ID_LEN
from relay.protocol import MsgType, decode
from relay.relay_server import RelayServer


async def recv_until(ws, type_id: int, timeout: float = 2.0) -> dict:
    """Receive frames until one of the wanted type arrives; return its payload."""
    async with asyncio.timeout(timeout):
        while True:
            tid, payload = decode(await ws.recv())
            if tid == type_id:
                return payload


async def recv_room_where(ws, predicate, timeout: float = 2.0) -> dict:
    """Drain RoomState frames until one satisfies `predicate` (robust to the
    several broadcasts that pile up across joins / settings changes)."""
    async with asyncio.timeout(timeout):
        while True:
            tid, payload = decode(await ws.recv())
            if tid == MsgType.ROOM_STATE and predicate(payload):
                return payload


async def with_server(test_body):
    relay = RelayServer(db_path=":memory:")
    async with serve(relay.handler, "localhost", 0) as server:
        port = server.sockets[0].getsockname()[1]
        await test_body(f"ws://localhost:{port}")


def test_two_clients_join_ready_matchstart_and_tick_relay():
    async def body(url: str):
        async with connect(url) as a, connect(url) as b:
            # A creates a room (roomId "" = create).
            await a.send(protocol.join_room("", "alice"))
            state_a = await recv_until(a, MsgType.ROOM_STATE)
            room_id = state_a["roomId"]
            assert state_a["youSlot"] == 0
            assert state_a["phase"] == 0
            assert state_a["players"] == [
                {
                    "slot": 0,
                    "name": "alice",
                    "ready": False,
                    "connected": True,
                    "score": 0.0,
                    "team": 0,  # default team = slot
                }
            ]

            # B joins by id; both get the updated roster.
            await b.send(protocol.join_room(room_id, "bob"))
            state_b = await recv_until(b, MsgType.ROOM_STATE)
            assert state_b["youSlot"] == 1
            assert [p["name"] for p in state_b["players"]] == ["alice", "bob"]

            # Both ready up -> MatchStart with identical seed/config/t0,
            # different slots.
            await a.send(protocol.ready_toggle(True))
            await b.send(protocol.ready_toggle(True))
            start_a = await recv_until(a, MsgType.MATCH_START)
            start_b = await recv_until(b, MsgType.MATCH_START)
            assert start_a["seed"] == start_b["seed"]
            assert 0 <= start_a["seed"] < 2**32
            assert start_a["config"] == start_b["config"]
            assert start_a["config"] == {
                "moveSpeed": 5.0,
                "cornerAssist": 0.25,
                "inputBufferMs": 120,
            }
            assert start_a["t0"] == start_b["t0"] == 0
            assert {start_a["slot"], start_b["slot"]} == {0, 1}

            # Relay one full tick (first expected tick = t0 + INPUT_DELAY_TICKS).
            await a.send(protocol.input_frame(2, dirs=1, actions=0))
            await b.send(protocol.input_frame(2, dirs=8, actions=1))
            for ws in (a, b):
                bc = await recv_until(ws, MsgType.INPUT_BROADCAST)
                assert bc == {
                    "t": 2,
                    "inputs": [
                        {"dirs": 1, "actions": 0},
                        {"dirs": 8, "actions": 1},
                    ],
                }
                ready = await recv_until(ws, MsgType.TICK_READY)
                assert ready == {"t": 2}

    asyncio.run(with_server(body))


def test_disconnect_mid_match_broadcasts_and_unblocks():
    async def body(url: str):
        async with connect(url) as a:
            async with connect(url) as b:
                await a.send(protocol.join_room("", "alice"))
                state = await recv_until(a, MsgType.ROOM_STATE)
                await b.send(protocol.join_room(state["roomId"], "bob"))
                await a.send(protocol.ready_toggle(True))
                await b.send(protocol.ready_toggle(True))
                await recv_until(a, MsgType.MATCH_START)
                await recv_until(b, MsgType.MATCH_START)
            # b's socket closed mid-match -> PlayerDisconnect{slot:1} to a.
            gone = await recv_until(a, MsgType.PLAYER_DISCONNECT)
            assert gone == {"slot": 1}

            # a alone now drives the lockstep.
            await a.send(protocol.input_frame(2, dirs=2, actions=0))
            bc = await recv_until(a, MsgType.INPUT_BROADCAST)
            assert bc["t"] == 2
            assert bc["inputs"][1] == {"dirs": 0, "actions": 0}  # ghost slot

    asyncio.run(with_server(body))


def test_solo_ready_does_not_start_match():
    # M5 start rule: all-ready only counts with >= 2 players in the room.
    async def body(url: str):
        async with connect(url) as a, connect(url) as b:
            await a.send(protocol.join_room("", "alice"))
            state = await recv_until(a, MsgType.ROOM_STATE)
            await a.send(protocol.ready_toggle(True))
            ready_state = await recv_until(a, MsgType.ROOM_STATE)
            assert ready_state["players"][0]["ready"] is True
            with pytest.raises(TimeoutError):
                await recv_until(a, MsgType.MATCH_START, timeout=0.3)

            # Second player joins and readies -> now it starts.
            await b.send(protocol.join_room(state["roomId"], "bob"))
            await recv_until(b, MsgType.ROOM_STATE)
            await b.send(protocol.ready_toggle(True))
            start_a = await recv_until(a, MsgType.MATCH_START)
            start_b = await recv_until(b, MsgType.MATCH_START)
            assert start_a["seed"] == start_b["seed"]

    asyncio.run(with_server(body))


def test_rematch_ready_toggle_resets_room_and_restarts():
    # After a match, ReadyToggle is the rematch signal: the room drops back
    # to LOBBY (ready flags cleared) and a second MatchStart fires once both
    # players ready up again, with a freshly drawn seed.
    async def body(url: str):
        async with connect(url) as a, connect(url) as b:
            await a.send(protocol.join_room("", "alice"))
            state = await recv_until(a, MsgType.ROOM_STATE)
            await b.send(protocol.join_room(state["roomId"], "bob"))
            await recv_until(b, MsgType.ROOM_STATE)
            await a.send(protocol.ready_toggle(True))
            await b.send(protocol.ready_toggle(True))
            first_a = await recv_until(a, MsgType.MATCH_START)
            await recv_until(b, MsgType.MATCH_START)

            # First rematch request: room resets, requester is the only ready.
            await a.send(protocol.ready_toggle(True))
            reset_state = await recv_until(b, MsgType.ROOM_STATE)
            assert reset_state["phase"] == 0  # back to LOBBY
            ready_by_slot = {p["slot"]: p["ready"] for p in reset_state["players"]}
            assert ready_by_slot == {0: True, 1: False}

            # Second player readies up -> second MatchStart, new seed.
            await b.send(protocol.ready_toggle(True))
            second_a = await recv_until(a, MsgType.MATCH_START)
            second_b = await recv_until(b, MsgType.MATCH_START)
            assert second_a["seed"] == second_b["seed"]
            assert second_a["seed"] != first_a["seed"]  # 2**-32 flake odds
            assert {second_a["slot"], second_b["slot"]} == {0, 1}

            # The new coordinator relays ticks for the new match.
            await a.send(protocol.input_frame(2, dirs=4, actions=0))
            await b.send(protocol.input_frame(2, dirs=8, actions=0))
            bc = await recv_until(a, MsgType.INPUT_BROADCAST)
            assert bc["t"] == 2

    asyncio.run(with_server(body))


def test_oversized_join_fields_are_truncated_not_crashing():
    # Untrusted name/roomId are capped on ingest before broadcast/storage.
    async def body(url: str):
        async with connect(url) as a:
            big_name = "N" * 200
            big_room = "R" * 200
            await a.send(protocol.join_room(big_room, big_name, "P" * 500))
            state = await recv_until(a, MsgType.ROOM_STATE, timeout=0.5)
            assert state["roomId"] == "R" * MAX_ROOM_ID_LEN
            assert state["players"][0]["name"] == "N" * MAX_NAME_LEN

    asyncio.run(with_server(body))


def _team_of(state: dict, slot: int) -> int | None:
    for p in state["players"]:
        if p["slot"] == slot:
            return p.get("team")
    return None


def test_host_map_and_team_reflected_and_match_start_carries_them():
    # Host picks the map + regroups teams by clicking cards (SET_PLAYER_TEAM) →
    # RoomState reflects both on every client; MatchStart carries map + the manual
    # per-slot teams array (single authority).
    async def body(url: str):
        async with connect(url) as a, connect(url) as b:
            await a.send(protocol.join_room("", "alice"))
            state = await recv_until(a, MsgType.ROOM_STATE)
            room_id = state["roomId"]
            assert state["map"] == "classic"  # default
            assert _team_of(state, 0) == 0  # default team = slot
            await b.send(protocol.join_room(room_id, "bob"))
            await recv_until(b, MsgType.ROOM_STATE)

            # Host (slot 0) picks pirate; both clients see it.
            await a.send(protocol.set_room_settings("pirate"))
            for ws in (a, b):
                await recv_room_where(ws, lambda p: p["map"] == "pirate")

            # Host puts bob (slot 1) onto team 0 (a 2-player co-op); reflected.
            await a.send(protocol.set_player_team(1, 0))
            for ws in (a, b):
                await recv_room_where(ws, lambda p: _team_of(p, 1) == 0)

            # Start: MatchStart carries map + full per-slot teams [0, 0].
            await a.send(protocol.ready_toggle(True))
            await b.send(protocol.ready_toggle(True))
            start_a = await recv_until(a, MsgType.MATCH_START)
            start_b = await recv_until(b, MsgType.MATCH_START)
            for s in (start_a, start_b):
                assert s["map"] == "pirate"
                assert s["teams"] == [0, 0]

    asyncio.run(with_server(body))


def test_non_host_team_permissions_over_wire():
    # A non-host may set ONLY its own team; a cross-slot attempt is ignored.
    async def body(url: str):
        async with connect(url) as a, connect(url) as b:
            await a.send(protocol.join_room("", "alice"))
            state = await recv_until(a, MsgType.ROOM_STATE)
            await b.send(protocol.join_room(state["roomId"], "bob"))
            await recv_until(b, MsgType.ROOM_STATE)

            # bob (slot 1, non-host) sets his OWN team → applied on both clients.
            await b.send(protocol.set_player_team(1, 2))
            for ws in (a, b):
                await recv_room_where(ws, lambda p: _team_of(p, 1) == 2)

            # bob tries to set alice's (slot 0) team → ignored (no broadcast).
            await b.send(protocol.set_player_team(0, 2))
            with pytest.raises(TimeoutError):
                await recv_room_where(a, lambda p: _team_of(p, 0) == 2, timeout=0.3)

    asyncio.run(with_server(body))


def test_match_start_carries_2v2_teams_over_wire():
    # Host groups 4 players into 2v2 (slots 0&3 vs 1&2) by clicking cards →
    # MatchStart teams = [0,1,1,0] on every client.
    async def body(url: str):
        async with connect(url) as a, connect(url) as b, connect(url) as c, connect(
            url
        ) as d:
            await a.send(protocol.join_room("", "alice"))
            state = await recv_until(a, MsgType.ROOM_STATE)
            room_id = state["roomId"]
            for ws, name in ((b, "bob"), (c, "carol"), (d, "dave")):
                await ws.send(protocol.join_room(room_id, name))
                await recv_until(ws, MsgType.ROOM_STATE)
            # Host regroups: slots 1,2 → team 1; slot 3 → team 0 (0&3 vs 1&2).
            await a.send(protocol.set_player_team(1, 1))
            await a.send(protocol.set_player_team(2, 1))
            await a.send(protocol.set_player_team(3, 0))
            await recv_room_where(a, lambda p: _team_of(p, 3) == 0)
            for ws in (a, b, c, d):
                await ws.send(protocol.ready_toggle(True))
            for ws in (a, b, c, d):
                start = await recv_until(ws, MsgType.MATCH_START)
                assert start["teams"] == [0, 1, 1, 0]
                assert "map" not in start  # classic = default → omitted

    asyncio.run(with_server(body))


def test_replay_upload_is_stored(tmp_path, monkeypatch):
    # A REPLAY_UPLOAD over the wire is validated + written to the replay dir.
    import relay.replays as replays_mod

    monkeypatch.setattr(replays_mod, "DEFAULT_REPLAY_DIR", str(tmp_path))

    async def body(url: str):
        async with connect(url) as a:
            await a.send(protocol.join_room("", "alice"))
            await recv_until(a, MsgType.ROOM_STATE)
            inputs = [
                {"t": 0, "slots": [{"dirs": 1, "actions": 0}, {"dirs": 0, "actions": 0}]},
                {"t": 1, "slots": [{"dirs": 0, "actions": 1}, {"dirs": 8, "actions": 0}]},
            ]
            await a.send(
                protocol.replay_upload(
                    seed=777,
                    map_="classic",
                    teams=[0, 1],
                    num_players=2,
                    t0=0,
                    config={"moveSpeed": 5.0, "cornerAssist": 0.25, "inputBufferMs": 120},
                    inputs=inputs,
                    result="loss",
                    winner_team=1,
                )
            )
            # The relay sends no reply for an upload; poll the dir for the write.
            async with asyncio.timeout(2.0):
                while not list(tmp_path.iterdir()):
                    await asyncio.sleep(0.02)

    asyncio.run(with_server(body))
    written = list(tmp_path.iterdir())
    assert len(written) == 1
    import json

    doc = json.loads(written[0].read_text())
    assert doc["seed"] == 777
    assert doc["schema"] == "choccus-replay-upload-v1"


def test_oversized_replay_upload_does_not_crash_room(tmp_path, monkeypatch):
    # A bogus over-cap upload is dropped; the room stays alive (a follow-up
    # message still works).
    import relay.replays as replays_mod
    from relay.constants import MAX_REPLAY_TICKS

    monkeypatch.setattr(replays_mod, "DEFAULT_REPLAY_DIR", str(tmp_path))

    async def body(url: str):
        async with connect(url) as a, connect(url) as b:
            await a.send(protocol.join_room("", "alice"))
            state = await recv_until(a, MsgType.ROOM_STATE)
            huge = [
                {"t": t, "slots": [{"dirs": 0, "actions": 0}, {"dirs": 0, "actions": 0}]}
                for t in range(MAX_REPLAY_TICKS + 2)
            ]
            await a.send(
                protocol.replay_upload(
                    seed=1,
                    map_="classic",
                    teams=[0, 1],
                    num_players=2,
                    t0=0,
                    config={"moveSpeed": 5.0, "cornerAssist": 0.25, "inputBufferMs": 120},
                    inputs=huge,
                    result="loss",
                    winner_team=0,
                )
            )
            # Room still responds: a second client can join and get a roster.
            await b.send(protocol.join_room(state["roomId"], "bob"))
            rs = await recv_until(b, MsgType.ROOM_STATE)
            assert [p["name"] for p in rs["players"]] == ["alice", "bob"]

    asyncio.run(with_server(body))
    assert list(tmp_path.iterdir()) == []  # nothing stored

def test_join_named_room_auto_creates_it():
    # Joining a room id that does not exist creates it under that id, so two
    # clients can meet at e.g. ?room=test with no prior coordination.
    async def body(url: str):
        async with connect(url) as a:
            await a.send(protocol.join_room("ZZZZZ", "alice"))
            state = await recv_until(a, MsgType.ROOM_STATE, timeout=0.5)
            assert state["roomId"] == "ZZZZZ"
            assert state["youSlot"] == 0
            assert [p["name"] for p in state["players"]] == ["alice"]

    asyncio.run(with_server(body))
