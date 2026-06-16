"""Manual smoke test: two clients join one room, ready up, relay a few ticks.

Run the server first, then this script:

    .venv/bin/python main.py            # terminal 1
    .venv/bin/python scripts/smoke_client.py   # terminal 2

Honors CHOCCUS_HOST / CHOCCUS_PORT (defaults localhost:8765).
"""

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # server/ on path

from websockets.asyncio.client import connect  # noqa: E402

from relay import protocol  # noqa: E402
from relay.protocol import MsgType, decode  # noqa: E402

HOST = os.environ.get("CHOCCUS_HOST", "localhost")
PORT = int(os.environ.get("CHOCCUS_PORT", "8765"))
URL = f"ws://{HOST}:{PORT}"

SMOKE_TICKS = range(2, 5)  # first expected tick = t0 + INPUT_DELAY_TICKS = 2


async def recv_until(ws, type_id, label, timeout=3.0):
    async with asyncio.timeout(timeout):
        while True:
            tid, payload = decode(await ws.recv())
            print(f"  [{label}] <- {MsgType(tid).name} {payload}")
            if tid == type_id:
                return payload


async def main() -> None:
    print(f"connecting two clients to {URL} ...")
    async with connect(URL) as a, connect(URL) as b:
        print("\n== lobby ==")
        await a.send(protocol.join_room("", "alice"))
        state = await recv_until(a, MsgType.ROOM_STATE, "alice")
        room_id = state["roomId"]
        print(f"  alice created room {room_id}")

        await b.send(protocol.join_room(room_id, "bob"))
        await recv_until(b, MsgType.ROOM_STATE, "bob")

        print("\n== ready -> MatchStart ==")
        await a.send(protocol.ready_toggle(True))
        await b.send(protocol.ready_toggle(True))
        start_a = await recv_until(a, MsgType.MATCH_START, "alice")
        start_b = await recv_until(b, MsgType.MATCH_START, "bob")
        same_seed = start_a["seed"] == start_b["seed"]
        print(f"  seeds identical: {same_seed} (seed={start_a['seed']})")
        print(f"  slots: alice={start_a['slot']} bob={start_b['slot']}")

        print("\n== relayed input ticks ==")
        for t in SMOKE_TICKS:
            await a.send(protocol.input_frame(t, dirs=1, actions=0))
            await b.send(protocol.input_frame(t, dirs=8, actions=t % 2))
            for ws, label in ((a, "alice"), (b, "bob")):
                await recv_until(ws, MsgType.TICK_READY, label)

        print("\nsmoke OK")


if __name__ == "__main__":
    asyncio.run(main())
