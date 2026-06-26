/**
 * Transport: the narrow seam the LockstepEngine needs to drive a match — the
 * ONLY coupling between the engine and how inputs travel.
 *
 * NetClient (the WebSocket relay) satisfies it for online play; LoopbackTransport
 * satisfies it in-process for solo / spectate / offline-room, echoing the local
 * slot's input straight back so the very same engine advances with no socket.
 *
 * It is exactly the six members the engine touches: subscribe to the four
 * inbound match events, send a local input frame, send a hash report. Everything
 * else on NetClient (lobby, ratings, reconnect, …) is out of scope here.
 */
import type {
  HashMismatchMsg,
  InputBroadcastMsg,
  PlayerDisconnectMsg,
  StallNoticeMsg,
} from './protocolCodec';

/** Event name → payload for the engine-facing subset of NetClient events. */
export interface TransportEvents {
  inputBroadcast: InputBroadcastMsg;
  hashMismatch: HashMismatchMsg;
  stallNotice: StallNoticeMsg;
  playerDisconnect: PlayerDisconnectMsg;
}

export interface Transport {
  /** Subscribe to an inbound match event; returns an unsubscribe function. */
  on<K extends keyof TransportEvents>(
    event: K,
    fn: (payload: TransportEvents[K]) => void,
  ): () => void;
  /** Schedule + emit the local player's input for the given sim tick. */
  sendInput(t: number, dirs: number, actions: number): void;
  /** Report the post-tick state hash (desync detection; no-op for loopback). */
  sendHashReport(t: number, hash: number): void;
}
