# Cocoa Clash (Choccus)

A chocolate-themed real-time online multiplayer game in the style of Bomberman.
Place chocolate bombs, detonate them in a cross-shaped melt pattern, trap
opponents in sugar-shell casings, and rescue teammates before time runs out.

## Prerequisites

| Tool | Version |
|------|---------|
| Node.js | 18 + (tested on 25) |
| npm | 8 + (tested on 11) |
| Python | 3.11 + |

## Install

```sh
# 1. JavaScript dependencies (client + tools)
npm install

# 2. Python dependencies
python3 -m venv server/.venv
server/.venv/bin/pip install -r server/requirements.txt
```

---

## Dev mode (Vite + relay, hot-reload)

Open **two** terminals:

```sh
# Terminal 1 — WebSocket relay (default port 8765)
server/.venv/bin/python server/main.py

# Terminal 2 — Vite dev server (port 5173)
npm run dev
```

Open two browser tabs at `http://localhost:5173/?mode=net` and play.

### Quick zero-click autoready (automated / CI)

```
http://localhost:5173/?mode=net&room=test&autoready=1
```

Open two tabs with that URL; they join the same room and start automatically.

Use `&port=<n>` to connect to a relay on a different port:

```
http://localhost:5173/?mode=net&room=test&autoready=1&port=9000
```

---

## Production / deploy mode

### 1. Build the client

```sh
npm run build
# → client/dist/  (static files ready to serve)
```

### 2. Start the production server

```sh
bash scripts/serve.sh
# or via npm:
npm run serve
```

This starts two services:

| Service | Default port | Configurable via |
|---------|-------------|-----------------|
| HTTP (static client) | **8080** | `CHOCCUS_STATIC_PORT` env or `--static-port` |
| WebSocket relay | **8765** | `CHOCCUS_PORT` env or `--port` |

Open `http://<server-ip>:8080/` in two browser tabs, click **Quick Match** (or
enter the same room name in both tabs), and the online match starts.

### How the WS URL is resolved (client)

The client resolves the relay URL automatically — no hardcoded `localhost`:

| URL parameter | Effect |
|---|---|
| `?ws=wss://example.com:8765` | explicit full URL override |
| `?port=9000` | `ws[s]://<same hostname>:9000` |
| _(none)_ | `ws[s]://<same hostname>:8765` (default) |

Uses `wss://` automatically when the page is served over HTTPS.

### Changing the ports

```sh
CHOCCUS_PORT=9000 CHOCCUS_STATIC_PORT=9001 bash scripts/serve.sh
```

Players connect to `http://<host>:9001/?port=9000` (or just the static
URL — the default port is 8765 in the resolver, so a non-default relay port
needs either `CHOCCUS_PORT` matching the client's default, or a `?port=` param
in the URL / invite link).

### Forcing a client rebuild before serving

```sh
bash scripts/serve.sh --rebuild
# or:
npm run serve:rebuild
```

### Split host/port setup (relay on a different host or behind a proxy)

Pass the full WS URL explicitly:

```
http://<static-host>:8080/?ws=wss://relay.example.com:8765
```

The invite link generated in-game preserves the `?ws=` parameter so friends
can click it directly.

### Reverse proxy (nginx / caddy)

If you put a TLS-terminating reverse proxy in front, configure it to:
- Serve `client/dist/` at `/` over HTTPS
- Proxy WebSocket connections at `/ws` (or a separate subdomain/port) to `ws://localhost:8765`

Then open the site over `https://` — the client automatically upgrades to `wss://`.

---

## Running tests

```sh
# Determinism / simulation tests (40 tests, golden hashes)
npm test

# Python relay server tests (46 tests)
server/.venv/bin/python -m pytest server/tests -q
```

---

## Architecture overview

```
client/src/
  net/
    wsUrl.ts          — WS URL resolver (same-origin, ?ws=, ?port=)
    netMode.ts        — lobby / match orchestrator
    NetClient.ts      — WebSocket transport (typed events)
    NetLobby.ts       — lobby state machine
    LockstepEngine.ts — per-tick input sync
  sim/                — deterministic simulation (DO NOT TOUCH)

server/
  main.py             — dev relay entry point  (ws only, default 8765)
  serve.py            — production entry point (HTTP static + ws relay)
  relay/              — RelayServer, TickCoordinator, Lobby, Room
  tests/              — pytest suite (46 tests)

scripts/
  serve.sh            — build + serve convenience script
```
