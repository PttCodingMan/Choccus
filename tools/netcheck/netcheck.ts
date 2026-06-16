/**
 * Wire smoke test: drives TWO real NetClients (the browser transport code,
 * verbatim) against a running Python relay and asserts the M4a contract:
 *
 *   1. both clients join the same room and see each other in RoomState;
 *   2. after both ready up, both receive MatchStart with the SAME seed and
 *      DIFFERENT slots;
 *   3. InputFrame → InputBroadcast round-trips: each client's distinct input
 *      for tick t0+INPUT_DELAY_TICKS comes back slot-indexed, followed by
 *      TickReady.
 *
 * Run (server must be listening; Node >= 22 for the global WebSocket):
 *   CHOCCUS_PORT=8766 python server/main.py &
 *   npx esbuild tools/netcheck/netcheck.ts --bundle --platform=node \
 *     --format=esm --outfile=/tmp/choccus-netcheck.mjs
 *   CHOCCUS_PORT=8766 node /tmp/choccus-netcheck.mjs
 */
import { INPUT_DELAY_TICKS } from '../../shared/constants';
import { ActionFlags, Direction } from '../../shared/types';
import { NetClient } from '../../client/src/net/NetClient';
import type { NetClientEvents } from '../../client/src/net/NetClient';

const PORT = Number(process.env['CHOCCUS_PORT'] ?? 8765);
const URL = `ws://localhost:${PORT}`;
const TIMEOUT_MS = 5000;

function once<K extends keyof NetClientEvents>(
  client: NetClient,
  event: K,
  pred?: (payload: NetClientEvents[K]) => boolean,
): Promise<NetClientEvents[K]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timeout waiting for '${event}'`));
    }, TIMEOUT_MS);
    const off = client.on(event, (payload) => {
      if (pred !== undefined && !pred(payload)) return;
      clearTimeout(timer);
      off();
      resolve(payload);
    });
  });
}

function assert(cond: boolean, what: string): void {
  if (!cond) {
    throw new Error(`ASSERT FAILED: ${what}`);
  }
  console.log(`  ok: ${what}`);
}

async function main(): Promise<void> {
  console.log(`netcheck → ${URL}`);
  const a = new NetClient();
  const b = new NetClient();

  // 1. A creates a room; B joins it by id.
  await a.connect(URL);
  const aJoined = once(a, 'roomState');
  a.joinRoom('', 'p1');
  const roomA = await aJoined;
  console.log(`  room created: ${roomA.roomId}, A is slot ${roomA.youSlot}`);

  await b.connect(URL);
  const bJoined = once(b, 'roomState');
  const aSeesB = once(a, 'roomState', (m) => m.players.length === 2);
  b.joinRoom(roomA.roomId, 'p2');
  const roomB = await bJoined;
  await aSeesB;
  assert(roomB.roomId === roomA.roomId, 'both clients in the same room');
  assert(roomB.players.length === 2, 'B sees a roster of 2');

  // 2. Ready up → MatchStart with same seed, different slots.
  const startA = once(a, 'matchStart');
  const startB = once(b, 'matchStart');
  a.toggleReady(true);
  b.toggleReady(true);
  const [msA, msB] = await Promise.all([startA, startB]);
  console.log(
    `  MatchStart A: seed=${msA.seed} slot=${msA.slot} t0=${msA.t0} config=${JSON.stringify(msA.config)}`,
  );
  console.log(`  MatchStart B: seed=${msB.seed} slot=${msB.slot} t0=${msB.t0}`);
  assert(msA.seed === msB.seed, `same seed (${msA.seed})`);
  assert(msA.slot !== msB.slot, `different slots (${msA.slot} vs ${msB.slot})`);
  assert(msA.config.moveSpeed === 5.0, 'config.moveSpeed round-trips as 5.0');

  // 3. InputFrame → InputBroadcast round-trip for the first lockstep tick.
  const t = msA.t0 + INPUT_DELAY_TICKS;
  const inA = { dirs: Direction.LEFT, actions: ActionFlags.BOMB };
  const inB = { dirs: Direction.RIGHT, actions: ActionFlags.NONE };
  const bcastA = once(a, 'inputBroadcast', (m) => m.t === t);
  const bcastB = once(b, 'inputBroadcast', (m) => m.t === t);
  const tickB = once(b, 'tickReady', (m) => m.t === t);
  a.sendInput(t, inA.dirs, inA.actions);
  b.sendInput(t, inB.dirs, inB.actions);
  const [bA, bB] = await Promise.all([bcastA, bcastB]);
  await tickB;
  console.log(`  InputBroadcast t=${t}: ${JSON.stringify(bA.inputs)}`);
  assert(JSON.stringify(bA.inputs) === JSON.stringify(bB.inputs), 'both clients got identical broadcasts');
  assert(
    bA.inputs[msA.slot]?.dirs === inA.dirs && bA.inputs[msA.slot]?.actions === inA.actions,
    `slot ${msA.slot} carries A's input`,
  );
  assert(
    bA.inputs[msB.slot]?.dirs === inB.dirs && bA.inputs[msB.slot]?.actions === inB.actions,
    `slot ${msB.slot} carries B's input`,
  );
  assert((await tickB).t === t, `TickReady t=${t} received`);

  a.close();
  b.close();
  console.log('netcheck PASSED');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(String(err));
    process.exit(1);
  },
);
