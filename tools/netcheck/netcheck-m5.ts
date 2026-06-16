/**
 * M5 wire smoke test: drives real NetClients (the browser transport code,
 * verbatim) against a running Python relay and asserts the M5 lobby/room
 * contract on top of the M4 lockstep basics:
 *
 *   1. join-by-id auto-creates the room;
 *   2. start rule: ONE ready player does NOT start a match (≥2 required);
 *      a second ready player does → MatchStart, same seed, distinct slots;
 *   3. the match relays ticks; then one client disconnects mid-match and
 *      the survivor keeps advancing ≥30 ticks via server-side ghost input
 *      (neutral frames for the dead slot — no permanent stall);
 *   4. documented limitation: a NEW connection cannot join a room that is
 *      mid-match (the relay silently ignores the join — no mid-match resume);
 *   5. rematch: ReadyToggle after the match resets the room to LOBBY
 *      (dropping the disconnected slot), a fresh player joins + readies →
 *      a second MatchStart with a different seed, and the new match relays.
 *
 * Run (server must be listening; Node >= 22 for the global WebSocket):
 *   CHOCCUS_PORT=8767 python server/main.py &
 *   npx esbuild tools/netcheck/netcheck-m5.ts --bundle --platform=node \
 *     --format=esm --outfile=/tmp/choccus-netcheck-m5.mjs
 *   CHOCCUS_PORT=8767 node /tmp/choccus-netcheck-m5.mjs
 */
import { INPUT_DELAY_TICKS } from '../../shared/constants';
import { ActionFlags, Direction } from '../../shared/types';
import { NetClient } from '../../client/src/net/NetClient';
import type { NetClientEvents } from '../../client/src/net/NetClient';

const PORT = Number(process.env['CHOCCUS_PORT'] ?? 8765);
const URL = `ws://localhost:${PORT}`;
const TIMEOUT_MS = 5000;
/** Ticks the survivor must advance after the disconnect (ghost-input proof). */
const GHOST_TICKS = 30;

function once<K extends keyof NetClientEvents>(
  client: NetClient,
  event: K,
  pred?: (payload: NetClientEvents[K]) => boolean,
  timeoutMs: number = TIMEOUT_MS,
): Promise<NetClientEvents[K]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timeout waiting for '${event}'`));
    }, timeoutMs);
    const off = client.on(event, (payload) => {
      if (pred !== undefined && !pred(payload)) return;
      clearTimeout(timer);
      off();
      resolve(payload);
    });
  });
}

/** Assert that `event` does NOT fire within `ms` (e.g. no premature start). */
function expectNo<K extends keyof NetClientEvents>(
  client: NetClient,
  event: K,
  ms: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const off = client.on(event, () => {
      clearTimeout(timer);
      off();
      reject(new Error(`unexpected '${event}' within ${ms} ms`));
    });
    const timer = setTimeout(() => {
      off();
      resolve();
    }, ms);
  });
}

function assert(cond: boolean, what: string): void {
  if (!cond) {
    throw new Error(`ASSERT FAILED: ${what}`);
  }
  console.log(`  ok: ${what}`);
}

async function main(): Promise<void> {
  console.log(`netcheck-m5 → ${URL}`);
  const roomId = `M5${Date.now().toString(36).toUpperCase()}`;
  const a = new NetClient();
  const b = new NetClient();

  // 1. Join-by-id auto-creates the room.
  await a.connect(URL);
  const joinedA = once(a, 'roomState');
  a.joinRoom(roomId, 'alice');
  const stateA = await joinedA;
  assert(stateA.roomId === roomId, `join-by-id auto-created room ${roomId}`);
  assert(stateA.youSlot === 0, 'A got slot 0');

  // 2. Start rule: one ready player must NOT start a match.
  a.toggleReady(true);
  await expectNo(a, 'matchStart', 600);
  console.log('  ok: solo ready did NOT start a match (>=2 rule)');

  await b.connect(URL);
  const aSees2 = once(a, 'roomState', (m) => m.players.length === 2);
  b.joinRoom(roomId, 'bob');
  await aSees2;
  const startPA = once(a, 'matchStart');
  const startPB = once(b, 'matchStart');
  b.toggleReady(true);
  const [start1A, start1B] = await Promise.all([startPA, startPB]);
  assert(start1A.seed === start1B.seed, `match 1 started, same seed (${start1A.seed})`);
  assert(start1A.slot !== start1B.slot, `distinct slots (${start1A.slot} vs ${start1B.slot})`);
  const slotB = start1B.slot;

  // 3a. Relay a stretch of normal lockstep ticks.
  const t0 = start1A.t0 + INPUT_DELAY_TICKS;
  const PRE_TICKS = 10;
  for (let t = t0; t < t0 + PRE_TICKS; t++) {
    const tickP = once(a, 'tickReady', (m) => m.t === t);
    a.sendInput(t, Direction.LEFT, ActionFlags.NONE);
    b.sendInput(t, Direction.RIGHT, ActionFlags.NONE);
    await tickP;
  }
  console.log(`  ok: relayed ${PRE_TICKS} lockstep ticks with both clients`);

  // 3b. B drops mid-match; A must keep advancing on ghost input.
  const goneP = once(a, 'playerDisconnect');
  b.close();
  const gone = await goneP;
  assert(gone.slot === slotB, `A saw PlayerDisconnect for slot ${slotB}`);

  const ghostStart = t0 + PRE_TICKS;
  for (let t = ghostStart; t < ghostStart + GHOST_TICKS; t++) {
    const bcP = once(a, 'inputBroadcast', (m) => m.t === t);
    a.sendInput(t, Direction.UP, ActionFlags.NONE);
    const bc = await bcP;
    const ghost = bc.inputs[slotB];
    if (ghost === undefined || ghost.dirs !== 0 || ghost.actions !== 0) {
      throw new Error(`tick ${t}: slot ${slotB} not ghost-neutral: ${JSON.stringify(ghost)}`);
    }
  }
  assert(true, `survivor advanced ${GHOST_TICKS} ticks after the disconnect (ghost input, no stall)`);

  // 4. Documented limitation: no joining a room that is mid-match.
  const late = new NetClient();
  await late.connect(URL);
  const lateJoin = expectNo(late, 'roomState', 500);
  late.joinRoom(roomId, 'latecomer');
  await lateJoin;
  late.close();
  console.log('  ok: join into a mid-match room is ignored (no mid-match resume)');

  // 5. Rematch: ReadyToggle while PLAYING resets the room to LOBBY.
  const resetP = once(a, 'roomState');
  a.toggleReady(true);
  const reset = await resetP;
  assert(reset.phase === 0, 'room reset to LOBBY phase on rematch request');
  assert(
    reset.players.length === 1 && reset.players[0]?.slot === start1A.slot,
    'disconnected slot was dropped from the roster',
  );
  assert(reset.players[0]?.ready === true, 'rematch requester is ready');

  const c = new NetClient();
  await c.connect(URL);
  const cJoined = once(c, 'roomState');
  c.joinRoom(roomId, 'carol');
  const stateC = await cJoined;
  assert(stateC.players.length === 2, 'C joined the reset room');
  const start2PA = once(a, 'matchStart');
  const start2PC = once(c, 'matchStart');
  c.toggleReady(true);
  const [start2A, start2C] = await Promise.all([start2PA, start2PC]);
  assert(start2A.seed === start2C.seed, `match 2 started, same seed (${start2A.seed})`);
  assert(start2A.seed !== start1A.seed, 'match 2 uses a different seed than match 1');
  assert(start2A.slot === start1A.slot, 'survivor kept their slot across the rematch');

  // The new coordinator relays the new match's first tick.
  const t2 = start2A.t0 + INPUT_DELAY_TICKS;
  const bc2P = once(a, 'inputBroadcast', (m) => m.t === t2);
  a.sendInput(t2, Direction.DOWN, ActionFlags.BOMB);
  c.sendInput(t2, Direction.NONE, ActionFlags.NONE);
  const bc2 = await bc2P;
  assert(
    bc2.inputs[start2A.slot]?.dirs === Direction.DOWN,
    'match 2 relays inputs through a fresh coordinator',
  );

  a.close();
  c.close();
  console.log('netcheck-m5 PASSED');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(String(err));
    process.exit(1);
  },
);
