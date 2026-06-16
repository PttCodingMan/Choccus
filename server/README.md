# Choccus relay server

Pure relay for deterministic lockstep — the simulation runs client-side. The
server coordinates rooms, generates the shared match seed, and relays per-tick
inputs. Wire protocol: `[1-byte type id][MessagePack payload]`, mirrored by
hand from `shared/protocol.ts` (the source of truth) in `relay/protocol.py`.

## Setup

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

## Run

```sh
.venv/bin/python main.py
```

Listens on `ws://localhost:8765` by default; configure with `CHOCCUS_HOST` /
`CHOCCUS_PORT` env vars.

## Tests

```sh
.venv/bin/python -m pytest tests -q
```

## Smoke test (manual)

With the server running in another terminal:

```sh
.venv/bin/python scripts/smoke_client.py
```

Connects two clients, joins them into one room, readies up, and prints the
MatchStart payloads (identical seed, distinct slots) plus a few relayed
input ticks.
