/**
 * Online session state management.
 *
 * Types and lifecycle utilities for the WebSocket session, dedup maps,
 * and connection management. Extracted from online-client.ts to provide
 * typed state and reusable networking plumbing.
 */

import {
  DEFAULT_CANNON_HP,
  DEFAULT_PLAYER_COUNT,
  type GameMessage,
  MESSAGE,
  type ServerMessage,
} from "../protocol/protocol.ts";
import type { ResolvedChoice } from "../shared/core/dialog-state.ts";
import {
  GAME_MODE_MODERN,
  type GameMode,
  LOBBY_TIMER,
} from "../shared/core/game-constants.ts";
import {
  createDedupChannel,
  type DedupChannel,
} from "../shared/core/phantom-types.ts";
import {
  type PlayerId,
  SPECTATOR_SLOT,
  type ValidPlayerId,
} from "../shared/core/player-slot.ts";

export interface OnlineSession {
  socket: WebSocket | null;
  /** This player's slot id. SPECTATOR_SLOT (-1) = watcher/spectator.
   *  Use `isActivePlayer(myPlayerId)` to check, not raw comparisons. */
  myPlayerId: PlayerId;
  /** Whether this client is the current host.
   *  VOLATILE: Can flip from false to true during host promotion (see online-host-promotion.ts).
   *  Never cache across tick boundaries, awaits, or phase transitions.
   *  Host promotion triggers: original host disconnects → server sends HOST_MIGRATION → this flips.
   *
   *  READ via `isHostInContext(session)` from tick-context.ts (enforced by ESLint).
   *  WRITE only in session init/reset/promotion (with eslint-disable). */
  isHost: boolean;
  hostMigrationSeq: number;
  /** All player slots with a connected client (includes self + remote players).
   *  INVARIANT: remotePlayerSlots ⊆ occupiedSlots.
   *  Both sets are maintained atomically by clearLobbySlot/occupyLobbySlot in
   *  online-server-lifecycle.ts — never mutate one without the other. */
  occupiedSlots: Set<ValidPlayerId>;
  /** Non-local player slots — remote humans only. Pure-AI slots are
   *  recomputed locally on every peer (wire-only-uncomputable rule), so they
   *  stay LOCAL on every peer's controller list and aren't added here.
   *  Used for auto-resolve logic and POV.
   *  INVARIANT: remotePlayerSlots ⊆ occupiedSlots. */
  remotePlayerSlots: Set<ValidPlayerId>;
  roomWaitTimerSec: number;
  roomSeed: number;
  roomMaxRounds: number;
  roomCannonMaxHp: number;
  roomGameMode: GameMode;
  roomPlayerCount: number;
  keepaliveTimer: ReturnType<typeof setInterval> | null;
  lobbyStartTime: number;
  /** Wire-arrived dialog choices whose scheduled apply found no open
   *  dialog (arrived before the local sim built it). Drained — and
   *  round-validated — by the dialog subsystems on show()/tryShow();
   *  the `round` stamp (sender's `state.round` at decision time) lets
   *  the drain reject a stale choice from an already-closed dialog. */
  earlyLifeLostChoices: Map<
    ValidPlayerId,
    { choice: ResolvedChoice; round: number }
  >;
  earlyUpgradePickChoices: Map<
    ValidPlayerId,
    { choice: string; round: number }
  >;
  /** Seats whose PLAYER_LEFT arrived mid-game but whose lockstep
   *  seat→AI flip has not applied yet. Value = the stamped `applyAt`
   *  once known (host stamps at receipt; watchers learn it from the
   *  SEAT_TAKEOVER broadcast), or null while unstamped (the host died
   *  before broadcasting — the promoted host re-issues these after its
   *  FULL_STATE, see promote.ts). The slot-set triple (occupiedSlots /
   *  remotePlayerSlots / lobby.joined) stays UNTOUCHED until the flip
   *  applies — wall-clock mutation is exactly the cross-peer race the
   *  lockstep flip exists to close. Entries are consumed by the flip
   *  apply, the adoption reconcile (online-rehydrate.ts), or the
   *  next-game INIT flush (online-server-lifecycle.ts). */
  pendingSeatTakeovers: Map<ValidPlayerId, number | null>;
  /** This seat's rejoin token, captured from the JOINED message. Persists
   *  across a tab-hide (JS memory survives) so the away-disconnect path can
   *  present it in `rejoinRoom` to re-enter a started room. Null until a slot
   *  is selected; cleared on a full session reset. */
  myRejoinToken: string | null;
  /** True between sending `rejoinRoom` and adopting the first resync
   *  FULL_STATE. The rejoiner boots as a SPECTATOR (`myPlayerId` = -1) so the
   *  replayed-INIT bootstrap builds its seat as the same AI mirror every other
   *  peer holds (the AI took it over). It then adopts the host's ROOM-WIDE
   *  resync broadcast through the normal migration path (kept controllers +
   *  paired re-prime) and claims its seat back. Cleared on adoption. */
  awaitingRejoinResync: boolean;
  /** The seat this rejoiner will reclaim once it has adopted the resync.
   *  Stashed before the spectator-boot clears `myPlayerId`; SPECTATOR_SLOT
   *  (-1) when not mid-rejoin. */
  awaitingRejoinSeat: PlayerId;
  /** The room code this peer is in, captured at `showWaitingRoom`. Survives a
   *  tab-hide (JS memory) so the away-disconnect → tab-return path can present
   *  it in `rejoinRoom` (the session has `roomSeed` but the rejoin handshake
   *  needs the CODE). Empty until a room is entered; cleared on a full reset. */
  roomCode: string;
  /** Host-only: rejoiner seats whose resync is DEFERRED to a future sim tick.
   *  Key = the rejoiner's slot; value = the `applyAt`-style fire tick
   *  (`requestTick + SAFETY`). The host serializes + re-broadcasts room-wide
   *  only once its `simTick` reaches the fire tick — by then every human action
   *  in flight before the rejoiner joined is drained into the snapshot, so the
   *  rejoiner can't miss one and fork. Polled per-frame by `pollDeferredResyncs`. */
  pendingResyncRequests: Map<ValidPlayerId, number>;
}

/** Network deduplication maps — tracks the last-sent value per player for each
 *  message type. If the new value matches, the send is skipped to reduce bandwidth.
 *  Cleared on session reset and host promotion.
 *
 *  Each channel is an opaque DedupChannel (see phantom-types.ts) — the raw Map is
 *  hidden so callers must use `channel.shouldSend(id, key)` to check + update atomically. */
export interface DedupMaps {
  aimTarget: DedupChannel;
  piecePhantom: DedupChannel;
  cannonPhantom: DedupChannel;
}

interface ConnectHandlers {
  onMessage: (msg: ServerMessage) => void | Promise<void>;
  onClose: () => void;
  onError: () => void;
}

const KEEPALIVE_MS = 30_000;

export function createSession(): OnlineSession {
  return {
    socket: null,
    myPlayerId: SPECTATOR_SLOT,
    isHost: false,
    hostMigrationSeq: 0,
    occupiedSlots: new Set(),
    remotePlayerSlots: new Set(),
    roomWaitTimerSec: LOBBY_TIMER,
    roomSeed: 0,
    roomMaxRounds: 0,
    roomCannonMaxHp: DEFAULT_CANNON_HP,
    roomGameMode: GAME_MODE_MODERN,
    roomPlayerCount: DEFAULT_PLAYER_COUNT,
    keepaliveTimer: null,
    lobbyStartTime: 0,
    earlyLifeLostChoices: new Map(),
    earlyUpgradePickChoices: new Map(),
    pendingSeatTakeovers: new Map(),
    myRejoinToken: null,
    awaitingRejoinResync: false,
    awaitingRejoinSeat: SPECTATOR_SLOT,
    roomCode: "",
    pendingResyncRequests: new Map(),
  };
}

export function createDedupMaps(): DedupMaps {
  return {
    aimTarget: createDedupChannel(),
    piecePhantom: createDedupChannel(),
    cannonPhantom: createDedupChannel(),
  };
}

export function resetDedupMaps(dedup: DedupMaps): void {
  dedup.aimTarget.clear();
  dedup.piecePhantom.clear();
  dedup.cannonPhantom.clear();
}

export function resetSessionState(session: OnlineSession): void {
  session.socket?.close();
  session.socket = null;
  session.isHost = false; // eslint-disable-line no-restricted-syntax -- session reset
  session.hostMigrationSeq = 0;
  session.myPlayerId = SPECTATOR_SLOT;
  session.occupiedSlots.clear();
  session.remotePlayerSlots.clear();
  session.earlyLifeLostChoices.clear();
  session.earlyUpgradePickChoices.clear();
  session.pendingSeatTakeovers.clear();
  session.myRejoinToken = null;
  session.awaitingRejoinResync = false;
  session.awaitingRejoinSeat = SPECTATOR_SLOT;
  session.roomCode = "";
  session.pendingResyncRequests.clear();
}

/** Roll back an in-flight rejoin (online-away-watchdog.ts `rejoin`) that did
 *  not complete its resync adoption: restore the stashed seat identity and
 *  disarm the resync-adopt routing so a later unrelated FULL_STATE isn't
 *  misrouted through `adoptResync`. Returns true when it actually rolled a
 *  pending rejoin back, false (a no-op) when none was in flight — so callers
 *  can skip their disconnect UI for a plain, non-rejoin error. */
export function rollbackRejoinSession(session: OnlineSession): boolean {
  if (!session.awaitingRejoinResync) return false;
  session.myPlayerId = session.awaitingRejoinSeat;
  session.awaitingRejoinSeat = SPECTATOR_SLOT;
  session.awaitingRejoinResync = false;
  return true;
}

export function sendAimUpdate(
  session: OnlineSession,
  dedup: DedupMaps,
  x: number,
  y: number,
  playerId?: ValidPlayerId,
): void {
  const pid = playerId ?? (session.myPlayerId as ValidPlayerId);
  if (!dedup.aimTarget.shouldSend(pid, formatAimDedupKey(x, y))) return;
  sendMessage(session, {
    type: MESSAGE.AIM_UPDATE,
    playerId: pid,
    x,
    y,
  });
}

export function sendMessage(session: OnlineSession, msg: GameMessage): void {
  if (isSocketOpen(session)) {
    session.socket!.send(JSON.stringify(msg));
  }
}

/**
 * Open a WebSocket connection, wire keepalive, and delegate events
 * to the provided handlers.
 */
export function connectWebSocket(
  session: OnlineSession,
  wsUrl: string,
  handlers: ConnectHandlers,
): void {
  if (!isSocketDisconnected(session)) return;
  session.socket = new WebSocket(wsUrl);
  session.socket.onmessage = (e) => {
    try {
      void handlers.onMessage(JSON.parse(e.data as string) as ServerMessage);
    } catch (err) {
      console.warn("[ws] malformed message:", err);
    }
  };
  session.socket.onopen = () => {
    if (session.keepaliveTimer) clearInterval(session.keepaliveTimer);
    session.keepaliveTimer = setInterval(() => {
      if (isSocketOpen(session)) {
        session.socket!.send(JSON.stringify({ type: MESSAGE.PING }));
      }
    }, KEEPALIVE_MS);
  };
  session.socket.onclose = () => {
    if (session.keepaliveTimer) {
      clearInterval(session.keepaliveTimer);
      session.keepaliveTimer = null;
    }
    handlers.onClose();
  };
  session.socket.onerror = () => {
    handlers.onError();
  };
}

/** Build a dedup-channel key for aim/crosshair sends. Pixel-rounded so
 *  sub-pixel jitter doesn't bust the dedup. `sendAimUpdate` is the single
 *  AIM_UPDATE sender — reached from the input path and from the per-frame
 *  `broadcastLocalCrosshair` hook (local human only; AI crosshairs never
 *  hit the wire) — so one `dedup.aimTarget` channel covers both. */
function formatAimDedupKey(x: number, y: number): string {
  return `${Math.round(x)},${Math.round(y)}`;
}

/** True when the socket is fully connected and can transmit.
 *  Use for send guards. Contrast with `isSocketDisconnected()`. */
function isSocketOpen(session: OnlineSession): boolean {
  return session.socket?.readyState === WebSocket.OPEN;
}

/** True when the socket is closed/closing and a reconnect attempt is appropriate.
 *  readyState > OPEN means CLOSING(2) or CLOSED(3).
 *  Contrast with `isSocketOpen()` which checks === OPEN only. */
function isSocketDisconnected(session: OnlineSession): boolean {
  return !session.socket || session.socket.readyState > WebSocket.OPEN;
}
