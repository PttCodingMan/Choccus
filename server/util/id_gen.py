"""Short, shareable room-id generation.

Uses ``secrets`` so ids are unguessable enough for casual rooms, and an
unambiguous alphabet (no 0/O/1/I) so ids survive being read out loud.
"""

import secrets
from collections.abc import Container

ROOM_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
ROOM_ID_LENGTH = 5


def generate_room_id(taken: Container[str] = ()) -> str:
    """Return a fresh room id not present in ``taken``."""
    while True:
        room_id = "".join(
            secrets.choice(ROOM_ID_ALPHABET) for _ in range(ROOM_ID_LENGTH)
        )
        if room_id not in taken:
            return room_id
