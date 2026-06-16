# sim-runner — determinism test harness (M2)

Headless, CI-ready proof that the simulation core (`client/src/sim/`) is
**bit-deterministic**, plus a golden-hash regression net for all future
netcode work. This is the single sim harness (the M1a `tools/sim-smoke`
script was folded into `test/behavior.test.ts` and removed).

## Commands

```bash
npm test                 # from repo root or from tools/sim-runner
                         #   = tsc --noEmit + vitest (determinism, golden,
                         #     behavior, banned-token suites)
npm run replay -- fixtures/long-run.json [--jsonl]
                         # run a replay, print one line per tick: tick,hashHex
npm run gen-fixtures     # re-author fixtures (reproducible bot scripts)
npm run update-golden    # INTENTIONALLY re-pin fixtures/golden.json
```

## Replay format

`fixtures/*.json` (see `src/replay.ts` for the authoritative doc):

```jsonc
{
  "seed": 3011,            // uint32 match seed
  "feelParams": {},        // optional Partial<FeelParams>
  "numPlayers": 2,         // 1..4
  "ticks": 1316,           // number of tick() calls
  "inputs": [ { "tick": 0, "slot": 1, "dir": 4, "action": 0 }, ... ]
}
```

**Sparse input semantics:** `inputs` is an event list. An event sets the
slot's `InputFrame` starting at that tick (0-based — the frame passed to the
`tick()` call that advances `state.tick` from `n` to `n+1`) and **persists
until a later event for the same slot**. Slots without events use `NO_INPUT`.
Events sort by tick; original array order breaks ties (last wins for
duplicate `(tick, slot)`).

## Fixtures

| fixture | what it exercises |
| --- | --- |
| `idle` | 600 ticks, no inputs — map generation PRNG stream only |
| `movement` | both players random-walk corridors — weaving, corner assist, wall clamps |
| `chain` | bombing through soft bricks, item drops, then a 2-bomb **chain detonation** |
| `trap-rescue` | P0 self-traps in a sugar shell; P1 bombs a path across and rescues |
| `long-run` | ~32 s free-for-all: 14 bombs, item pickups, escapes — everything mixed |

Fixtures were authored by `src/gen-fixtures.ts`: a closed-loop bot
(`src/bot.ts`) scripts the scenario against the live sim, the recorder
captures the inputs as a sparse event list, and the scenario is **validated**
(chain actually chained, rescue actually happened, …). The committed JSON is
plain open-loop input data — the bot never runs at test time. Generation is
reproducible: fixed ascending seed scans + the sim's own Mulberry32 for all
random choices.

## Test suites

1. **Same-process replay identity** — every fixture run twice, hash logs must
   be element-wise identical.
2. **Cross-instance identity** — two *independently constructed* `SimState`s
   (separate feel params, separate input frame objects) advanced interleaved;
   hashes must match at **every** tick. Catches shared-mutable-state bugs
   that test 1 can miss.
3. **Golden-hash regression** — live hash logs must match the committed
   `fixtures/golden.json` (full per-tick logs, space-joined hex). On mismatch
   the failure message classifies the break: identity-still-holds → logic
   change (run `npm run update-golden` if intentional); identity-also-fails →
   nondeterminism bug (never update goldens for that).
4. **Behavior spot-asserts** — fuse fires exactly `FUSE_TICKS` after placement,
   soft bricks destroyed, sparks ≤ `SPARK_TICKS`, trap lasts exactly
   `TRAPPED_TICKS` then eliminates, teammate touch rescues, plus fixture-level
   semantic checks (chain/trap-rescue).
5. **Banned-token guard** — sim sources must not contain `Date.now`,
   `Math.random`, `performance.now`, `Math.sin/cos/sqrt` (backstop for the
   ESLint rules; scans raw text, comments included).

## What this proves — and what it doesn't

**Covered:** replay-identity, cross-instance identity and golden pinning under
Node (V8), including PRNG streams, chain/trap/rescue/item paths and the
frozen `OVER` state. Because the sim is integer-only (int32 millitiles,
Mulberry32 uint32 PRNG, FNV-1a uint32 hashing, no stored floats — the only
floats are transient `< rate` comparisons against exact-dyadic constants),
identical results across JS engines are by-construction expected.

**Not covered:** actual cross-engine runs (real Chrome vs Firefox vs Node) —
deferred; the fixed-point design is the mitigation, and M4's lockstep
`HashReport`/`HashMismatch` compares live client hashes over the wire every
30 ticks anyway, which is the true end-to-end check. To add a browser-side
check later: load `runReplay` + a fixture in a Vite page, post the hash log,
and diff it against `golden.json` (no sim changes needed — `client/src/sim`
is already browser/Node agnostic).

Note: `long-run` ends with both players alive (phase `PLAYING`). Frozen
`OVER`-state hashing is exercised by the crafted-state behavior tests
(`test/behavior.test.ts`, `test/pvp.test.ts`).
