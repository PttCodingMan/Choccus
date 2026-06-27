"""Chocco relay server entry point.

Pure deterministic-lockstep relay: rooms/lobby, shared match seed, per-tick
input relaying (see server/relay/). The server never runs game logic.

Configuration via environment:
  CHOCCUS_HOST  bind host (default: localhost)
  CHOCCUS_PORT  bind port (default: 8765)
"""

import asyncio
import os

from websockets.asyncio.server import serve

import auth_server
from relay import auth
from relay.relay_server import RelayServer

try:  # optional event-loop speedup; pure stdlib asyncio works fine too
    import uvloop
except ImportError:
    uvloop = None

HOST = os.environ.get("CHOCCUS_HOST", "localhost")
PORT = int(os.environ.get("CHOCCUS_PORT", "8765"))


async def main() -> None:
    relay = RelayServer()
    # OAuth login endpoints on a sibling HTTP port (daemon thread). One-command
    # dev: `python server/main.py` brings up both ws relay and /auth/*.
    auth_server.serve_in_thread()
    configured = [p for p in auth.PROVIDERS if auth.is_configured(p)]
    print(
        f"[choccus] auth server on http://{auth_server.HOST}:{auth_server.PORT}"
        f" — providers: {', '.join(configured) or 'NONE configured'}"
        + ("  [INSECURE dev auth secret]" if auth.using_insecure_secret() else ""),
        flush=True,
    )
    # Relay frames are tiny (inputs/hashes + capped strings); 8 KiB is plenty
    # and far below the 1 MiB default, shrinking the per-frame OOM surface.
    # ping_interval keeps idle lobby sockets alive behind reverse proxies that
    # drop inactive WebSockets (Cloudflare ~100s) — 20 s of server pings (echoed
    # as pongs) counts as activity, so no app-level heartbeat is needed.
    async with serve(
        relay.handler, HOST, PORT, max_size=8 * 1024, ping_interval=20, ping_timeout=20
    ):
        loop = "uvloop" if uvloop is not None else "asyncio"
        print(
            f"[choccus] relay server listening on ws://{HOST}:{PORT} ({loop})",
            flush=True,
        )
        await asyncio.get_running_loop().create_future()  # run forever


if __name__ == "__main__":
    runner = uvloop.run if uvloop is not None else asyncio.run
    try:
        runner(main())
    except KeyboardInterrupt:
        print("[choccus] server stopped")
