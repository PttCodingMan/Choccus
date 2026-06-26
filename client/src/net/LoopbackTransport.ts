/**
 * LoopbackTransport: an in-process Transport that lets the LockstepEngine drive
 * a fully LOCAL match (solo / spectate / offline-room) with no socket. It is the
 * single seam that unifies every match path on one engine.
 *
 * How the echo works (and why it stays deterministic): the engine schedules its
 * local input for tick `t + INPUT_DELAY_TICKS` once per produced tick and calls
 * sendInput(t,…). With a relay, that frame round-trips and comes back inside the
 * authoritative slot-indexed InputBroadcast. Loopback has no other humans (every
 * other slot is a bot filled INSIDE the engine), so we just echo the same frame
 * straight back as an InputBroadcast for tick `t` whose inputs[mySlot] = that
 * input. The echo is SYNCHRONOUS — fired from inside sendInput — so it lands in
 * pendingInputs before the engine ever tries to produce tick `t` (the warmup
 * pre-seeds the first INPUT_DELAY_TICKS ticks, exactly as in the net path). The
 * broadcast ignores every non-local slot (bots compute their own input), so the
 * other entries are irrelevant filler.
 *
 * It never emits hashMismatch / stallNotice / playerDisconnect (a single local
 * client cannot desync, stall, or disconnect from itself), and sendHashReport is
 * a no-op (nothing to compare against).
 */
import { NO_INPUT } from '../sim/InputBuffer';
import { MsgType } from './protocolCodec';
import type { InputBroadcastMsg, SlotInput } from './protocolCodec';
import type { Transport, TransportEvents } from './Transport';

type Listener<K extends keyof TransportEvents> = (
  payload: TransportEvents[K],
) => void;

export class LoopbackTransport implements Transport {
  private readonly mySlot: number;
  private readonly broadcastListeners = new Set<Listener<'inputBroadcast'>>();

  constructor(mySlot: number) {
    this.mySlot = mySlot;
  }

  on<K extends keyof TransportEvents>(
    event: K,
    fn: (payload: TransportEvents[K]) => void,
  ): () => void {
    // Only inputBroadcast is ever produced locally; the other three (mismatch /
    // stall / disconnect) cannot happen against yourself, so their subscriptions
    // are accepted but never fire.
    if (event === 'inputBroadcast') {
      const l = fn as Listener<'inputBroadcast'>;
      this.broadcastListeners.add(l);
      return () => this.broadcastListeners.delete(l);
    }
    return () => {};
  }

  sendInput(t: number, dirs: number, actions: number): void {
    // Echo this tick's local input straight back, mirroring the relay's
    // authoritative InputBroadcast. inputs is dense up to mySlot; only mySlot's
    // entry is read by the engine (other slots are bot-filled there), the rest
    // are neutral filler.
    const inputs: SlotInput[] = [];
    for (let slot = 0; slot <= this.mySlot; slot++) {
      inputs.push(
        slot === this.mySlot
          ? { dirs, actions }
          : { dirs: NO_INPUT.dir, actions: NO_INPUT.action },
      );
    }
    const msg: InputBroadcastMsg = { type: MsgType.INPUT_BROADCAST, t, inputs };
    for (const l of this.broadcastListeners) l(msg);
  }

  sendHashReport(): void {
    // No peer to compare against — nothing to report.
  }
}
