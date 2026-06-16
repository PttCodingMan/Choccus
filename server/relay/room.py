"""Room: one match's membership and lifecycle (LOBBY -> PLAYING -> OVER).

Tracks players by slot (0..MAX_PLAYERS-1), their ready state, and — once all
present players are ready — starts the match: generates the shared PRNG seed
(``secrets.randbits(32)``: cryptographic source, only used to *seed* the
clients' deterministic Mulberry32, never as the sim RNG itself), freezes the
authoritative FeelParams, sends each player MatchStart with their own slot,
and hands tick relaying to a TickCoordinator.

Players are plain records holding a sync ``send(data: bytes)`` callback, so
the room is unit-testable without sockets.
"""

import secrets
from collections.abc import Callable
from dataclasses import dataclass, field

from .constants import DEFAULT_FEEL_PARAMS, MAX_PLAYERS, GamePhase
from .protocol import match_start, player_disconnect, room_state
from .tick_coordinator import TickCoordinator

#: First sim tick — clients start stepping from here (MatchStart.t0).
MATCH_T0 = 0

#: M5 start rule: an online match needs at least this many players (solo play
#: is the hotseat mode's job). Enforced via ``can_start()`` at the dispatch
#: layer; ``start_match()`` itself stays permissive for unit tests.
MIN_PLAYERS_TO_START = 2


@dataclass
class Player:
    name: str
    send: Callable[[bytes], None]
    ready: bool = False
    connected: bool = True


@dataclass
class Room:
    room_id: str
    phase: GamePhase = GamePhase.LOBBY
    players: dict[int, Player] = field(default_factory=dict)
    coordinator: TickCoordinator | None = None
    seed: int | None = None

    # -- membership -----------------------------------------------------------

    def add_player(self, name: str, send: Callable[[bytes], None]) -> int | None:
        """Assign the lowest free slot; None if the room is full or in-game."""
        if self.phase != GamePhase.LOBBY or len(self.players) >= MAX_PLAYERS:
            return None
        slot = next(s for s in range(MAX_PLAYERS) if s not in self.players)
        self.players[slot] = Player(name=name, send=send)
        return slot

    def remove_player(self, slot: int) -> None:
        """Leave (lobby: frees the slot) or disconnect (in-game: slot is kept,
        marked disconnected, excluded from lockstep, PlayerDisconnect sent)."""
        if slot not in self.players:
            return
        if self.phase == GamePhase.LOBBY:
            del self.players[slot]
        else:
            self.players[slot].connected = False
            if self.coordinator is not None:
                self.coordinator.mark_disconnected(slot)
            self.broadcast(player_disconnect(slot))

    def set_ready(self, slot: int, ready: bool) -> None:
        if self.phase == GamePhase.LOBBY and slot in self.players:
            self.players[slot].ready = ready

    def all_ready(self) -> bool:
        return bool(self.players) and all(p.ready for p in self.players.values())

    def can_start(self) -> bool:
        """M5 start rule: >= MIN_PLAYERS_TO_START players AND everyone ready."""
        return len(self.players) >= MIN_PLAYERS_TO_START and self.all_ready()

    def is_empty(self) -> bool:
        return not any(p.connected for p in self.players.values())

    # -- match lifecycle --------------------------------------------------------

    def start_match(self) -> None:
        """LOBBY -> PLAYING: pick the shared seed, send per-player MatchStart."""
        if self.phase != GamePhase.LOBBY or not self.players:
            return
        self.phase = GamePhase.PLAYING
        self.seed = secrets.randbits(32)
        self.coordinator = TickCoordinator(
            slots=self.players.keys(), broadcast=self.broadcast
        )
        config = dict(DEFAULT_FEEL_PARAMS)  # frozen for the whole match
        for slot, player in self.players.items():
            player.send(match_start(self.seed, slot, config, MATCH_T0))

    def reset_to_lobby(self) -> None:
        """PLAYING -> LOBBY (rematch). The relay never simulates, so it cannot
        observe the sim reaching OVER itself — the first ReadyToggle after
        MatchStart is the clients' "match is over, ready for a rematch"
        signal (see RelayServer._ready). Drops slots that disconnected
        mid-match, clears every ready flag and the per-match state; surviving
        players keep their slots."""
        if self.phase == GamePhase.LOBBY:
            return
        self.phase = GamePhase.LOBBY
        self.players = {s: p for s, p in self.players.items() if p.connected}
        for player in self.players.values():
            player.ready = False
        if self.coordinator is not None:
            self.coordinator.close()
            self.coordinator = None
        self.seed = None

    # -- messaging ------------------------------------------------------------------

    def broadcast(self, data: bytes) -> None:
        for player in self.players.values():
            if player.connected:
                player.send(data)

    def broadcast_room_state(self) -> None:
        """RoomState is per-receiver (youSlot differs), so send individually."""
        roster = [
            {"slot": slot, "name": p.name, "ready": p.ready, "connected": p.connected}
            for slot, p in sorted(self.players.items())
        ]
        for slot, player in self.players.items():
            if player.connected:
                player.send(
                    room_state(self.room_id, int(self.phase), slot, roster)
                )

    # -- lifecycle --------------------------------------------------------------------

    def close(self) -> None:
        if self.coordinator is not None:
            self.coordinator.close()
