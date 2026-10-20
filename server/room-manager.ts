import {
  MESSAGE,
  type RoomSettings,
  type ServerMessage,
} from "../src/protocol/protocol.ts";
import type { ValidPlayerId } from "../src/shared/core/player-slot.ts";
import { MAX_PLAYERS, PLAYER_NAMES } from "../src/shared/ui/player-config.ts";
import { GameRoom } from "./game-room.ts";
import { safeSendRaw } from "./send-utils.ts";

interface RoomEntry {
  room: GameRoom;
  code: string;
  hostSocket: WebSocket;
  connectedSockets: Set<WebSocket>;
  /** socket → playerId. A player's slot choice (color/position, 0-indexed)
   *  determines their playerId for the entire session. Only set for sockets
   *  that have picked a slot; spectators are in connectedSockets but not here. */
  slotAssignments: Map<WebSocket, ValidPlayerId>;
  /** True once the game has started (host sent INIT or wait timer fired).
   *  No new players can join after this point. */
  started: boolean;
  /** Per-seat rejoin token (playerId → token), issued at slot selection and
   *  retained across a disconnect so a returning socket can prove prior
   *  ownership of its seat via `rejoinRoom`. */
  rejoinTokens: Map<ValidPlayerId, string>;
  /** Sockets admitted via `rejoinRoom` that have NOT yet requested their seat
   *  back. They are in `slotAssignments` (for identity + targeted resync
   *  routing) but are still bootstrapping/adopting the resync, so they must
   *  not be picked as a migration host until they ask to reclaim (which only
   *  happens after they have adopted the snapshot). Cleared on reclaim-request
   *  or disconnect. */
  pendingReclaim: Set<WebSocket>;
  /** The host's INIT payload, buffered verbatim so `rejoinRoom` can replay it
   *  to a returning socket (every peer must bootstrap from the identical
   *  INIT). Null until the host sends INIT. */
  storedInitJson: string | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  autoStartTimer: ReturnType<typeof setTimeout> | null;
  createdAt: number;
}

interface SlotSelectionResult {
  playerId: ValidPlayerId;
  /** The slot this socket previously occupied, or null if this is their first
   *  slot selection (new player joining). Used by the caller to broadcast
   *  a previousPlayerId so clients can clean up the vacated slot's UI. */
  previousPlayerId: ValidPlayerId | null;
  /** This seat's rejoin token — sent to the selecting socket only (it persists
   *  it for a later `rejoinRoom`). Stable across reselection of the same slot. */
  rejoinToken: string;
}

const MAX_ROOMS = 50;
/** Webcam signalling envelope cap (an SDP offer with ICE is ~5 KB). */
const MAX_RTC_SIGNAL_SIZE = 16_384;
const RTC_SIGNAL_KINDS: ReadonlySet<unknown> = new Set([
  "offer",
  "answer",
  "ice",
  "cam",
]);
/** Grace period before destroying a room after game over — allows clients to see final screen. */
const ROOM_CLEANUP_DELAY_MS = 60_000;
// 60s: allow clients to fetch final screen state before cleanup
/** Uppercase letters excluding I and O to avoid confusion with 1 and 0. */
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
/** 4 chars from 24-letter alphabet ≈ 330K combinations — sufficient for concurrent rooms. */
const ROOM_CODE_LENGTH = 4;

export class RoomManager {
  private rooms = new Map<string, RoomEntry>();
  private socketToRoom = new Map<WebSocket, RoomEntry>();

  // ---------------------------------------------------------------------------
  // Room lifecycle
  // ---------------------------------------------------------------------------

  /** Create a new room with the given host socket.
   *  Initialization order matters — each step depends on the previous:
   *  1. Detach socket from any existing room
   *  2. Create GameRoom + RoomEntry (entry holds all room state)
   *  3. Register entry in lookup maps (rooms, socketToRoom)
   *  4. Register host socket in GameRoom (addSocket + setHost)
   *  5. Start wait timer (auto-starts game after timeout) */
  createRoom(settings: RoomSettings, hostSocket: WebSocket): string | null {
    this.disconnectSocketFromRoom(hostSocket); // Step 1
    if (this.rooms.size >= MAX_ROOMS) return null;

    // Step 2: Create room + entry (shared maps passed to GameRoom)
    const code = this.generateCode();
    const connectedSockets = new Set([hostSocket]);
    const slotAssignments = new Map<WebSocket, ValidPlayerId>();
    // entryRef closes over the RoomEntry for the onGameStart callback;
    // the entry is constructed below since GameRoom is one of its fields.
    const entryRef: { current: RoomEntry | undefined } = { current: undefined };
    const room = new GameRoom(
      slotAssignments,
      connectedSockets,
      (initRaw) => {
        if (!entryRef.current) return;
        // Buffer the INIT verbatim for later rejoin replay, then flip started.
        entryRef.current.storedInitJson = initRaw;
        this.doStartGame(entryRef.current);
      },
      settings,
      settings.seed,
    );
    const entry: RoomEntry = {
      room,
      code,
      hostSocket,
      connectedSockets,
      slotAssignments,
      started: false,
      rejoinTokens: new Map(),
      pendingReclaim: new Set(),
      storedInitJson: null,
      cleanupTimer: null,
      autoStartTimer: null,
      createdAt: Date.now(),
    };
    entryRef.current = entry;
    // Step 3: Register in lookup maps
    this.rooms.set(code, entry);
    this.socketToRoom.set(hostSocket, entry);
    // Step 4: Set host in GameRoom (socket already in connectedSockets)
    room.setHost(hostSocket);

    // Step 5: Start wait timer
    const waitSec = room.settings.waitTimerSec;
    entry.autoStartTimer = setTimeout(() => {
      if (!entry.started) this.doStartGame(entry);
    }, waitSec * 1000);

    return code;
  }

  joinRoom(code: string, socket: WebSocket): RoomEntry | null {
    this.disconnectSocketFromRoom(socket);
    const entry = this.rooms.get(code.toUpperCase());
    if (!entry || entry.started) return null;

    entry.connectedSockets.add(socket);
    this.socketToRoom.set(socket, entry);
    return entry;
  }

  /** Re-admit a previously-seated socket into a STARTED room. The token
   *  (issued at slot selection, retained across the disconnect) proves prior
   *  ownership of a seat — this is the ONLY path into a started room, and only
   *  for a seat whose owner has left (it never steals a live seat). It does
   *  not open a general spectator path (a non-target): no token, no entry.
   *
   *  On success the socket is admitted as a watcher with its slot identity
   *  restored (so its later REQUEST_SEAT_RECLAIM passes the identity check and
   *  the targeted resync can be routed to it), the buffered INIT is replayed
   *  so it boots a clean runtime, and the host is asked for a resync addressed
   *  to only this socket. Returns false (→ caller sends ROOM_ERROR) when the
   *  room / token / seat is not eligible. */
  rejoinRoom(code: string, token: string, socket: WebSocket): boolean {
    this.disconnectSocketFromRoom(socket);
    const entry = this.rooms.get(code.toUpperCase());
    // Need a started room with a buffered INIT and a live host: only a live
    // host can serialize the resync snapshot, so a dead room can't be rejoined.
    if (!entry || !entry.started || !entry.storedInitJson) return false;
    if (entry.hostSocket.readyState !== WebSocket.OPEN) return false;

    // Resolve the seat this token owns.
    let playerId: ValidPlayerId | undefined;
    for (const [pid, issued] of entry.rejoinTokens) {
      if (issued === token) {
        playerId = pid;
        break;
      }
    }
    if (playerId === undefined) return false;

    // Never steal a seat still held by a live socket.
    for (const [otherSocket, pid] of entry.slotAssignments) {
      if (pid === playerId && otherSocket.readyState === WebSocket.OPEN) {
        return false;
      }
    }

    // A rejoin into a room that was emptying cancels its scheduled teardown.
    if (entry.cleanupTimer) {
      clearTimeout(entry.cleanupTimer);
      entry.cleanupTimer = null;
    }

    // Admit as a watcher + restore slot identity. pendingReclaim keeps it off
    // the migration-host shortlist until it has adopted the resync and asks to
    // reclaim (migrateHost skips pendingReclaim sockets).
    entry.connectedSockets.add(socket);
    this.socketToRoom.set(socket, entry);
    entry.slotAssignments.set(socket, playerId);
    entry.pendingReclaim.add(socket);

    // Replay the buffered INIT (clean bootstrap), then ask the host for a
    // resync addressed to only this socket.
    safeSendRaw(socket, entry.storedInitJson);
    safeSendRaw(
      entry.hostSocket,
      JSON.stringify({ type: MESSAGE.REQUEST_RESYNC, forPlayerId: playerId }),
    );
    console.log(`[rooms] Player rejoined room ${entry.code} as P${playerId}`);
    return true;
  }

  /** Forward a rejoined peer's REQUEST_SEAT_RECLAIM to the host (the only peer
   *  that decides the reclaim — it validates the seat is AI-held and the owner
   *  alive, then stamps + broadcasts SEAT_RECLAIM). Validates the sender owns
   *  the seat (its slot identity was restored on rejoin) and clears it from
   *  pendingReclaim: by asking to reclaim, it has adopted the resync and is a
   *  full lockstep peer, now eligible to host. Returns false when ineligible. */
  forwardSeatReclaim(socket: WebSocket, playerId: ValidPlayerId): boolean {
    const entry = this.socketToRoom.get(socket);
    if (!entry || !entry.started) return false;
    if (entry.slotAssignments.get(socket) !== playerId) return false;
    if (entry.hostSocket.readyState !== WebSocket.OPEN) return false;
    entry.pendingReclaim.delete(socket);
    safeSendRaw(
      entry.hostSocket,
      JSON.stringify({ type: MESSAGE.REQUEST_SEAT_RECLAIM, playerId }),
    );
    return true;
  }

  /** Relay a webcam signalling payload to the socket seated at `to`, stamped
   *  with the sender's seat. Pure pass-through: only the envelope is checked
   *  (webcams enabled for the room, both ends seated, bounded size, known
   *  `kind`). Returns false when dropped. */
  forwardRtcSignal(socket: WebSocket, to: unknown, data: unknown): boolean {
    const entry = this.socketToRoom.get(socket);
    if (!entry?.room.settings.webcam) return false;
    const from = entry.slotAssignments.get(socket);
    if (from === undefined || from === to) return false;
    if (typeof data !== "object" || data === null) return false;
    const kind = (data as { kind?: unknown }).kind;
    if (!RTC_SIGNAL_KINDS.has(kind)) return false;
    const json = JSON.stringify({ type: MESSAGE.RTC_SIGNAL, from, data });
    if (json.length > MAX_RTC_SIGNAL_SIZE) return false;
    for (const [target, seat] of entry.slotAssignments) {
      if (seat === to) {
        safeSendRaw(target, json);
        return true;
      }
    }
    return false;
  }

  /** Player selects a color/position slot, which becomes their playerId.
   *  playerId = 0-indexed player position used as the player's identity
   *  for the entire session across all game messages.
   *  Updates slotAssignments (shared with GameRoom for identity enforcement).
   *  Returns null if: slot taken by another player, invalid playerId, or game already started. */
  selectSlot(
    socket: WebSocket,
    playerId: ValidPlayerId,
  ): SlotSelectionResult | null {
    const entry = this.socketToRoom.get(socket);
    if (!entry || entry.started) return null;
    if (
      playerId < 0 ||
      playerId >= (entry.room.settings.playerCount ?? MAX_PLAYERS)
    )
      return null;

    // Check if slot is already taken by another socket
    for (const [otherSocket, otherId] of entry.slotAssignments) {
      if (otherId === playerId && otherSocket !== socket) return null;
    }

    const previousPlayerId = entry.slotAssignments.get(socket) ?? null;
    // Release previous slot if this socket had one
    entry.slotAssignments.delete(socket);
    // Assign new slot (shared map — GameRoom sees this immediately)
    entry.slotAssignments.set(socket, playerId);

    // Drop the vacated seat's token (a real slot change, not a same-slot
    // no-op) so it can't be used to rejoin a seat this socket no longer owns.
    if (previousPlayerId !== null && previousPlayerId !== playerId) {
      entry.rejoinTokens.delete(previousPlayerId);
    }
    // One stable token per seat — reused if this socket reselects the same
    // slot so a token already handed out (and persisted client-side) stays
    // valid.
    let rejoinToken = entry.rejoinTokens.get(playerId);
    if (!rejoinToken) {
      rejoinToken = crypto.randomUUID();
      entry.rejoinTokens.set(playerId, rejoinToken);
    }

    return { playerId, previousPlayerId, rejoinToken };
  }

  /** Mark room as started: stop wait timer, add spectators. Game init is driven by host client. */
  private doStartGame(entry: RoomEntry): void {
    if (entry.started) return;
    entry.started = true;
    if (entry.autoStartTimer) {
      clearTimeout(entry.autoStartTimer);
      entry.autoStartTimer = null;
    }
    // All sockets are already spectators (added on join/create)
    console.log(
      `[rooms] Room ${entry.code} started with ${entry.slotAssignments.size} human(s)`,
    );
  }

  // ---------------------------------------------------------------------------
  // Message routing
  // ---------------------------------------------------------------------------

  handleMessage(
    socket: WebSocket,
    msg: Record<string, unknown>,
    rawJson: string,
  ): void {
    const entry = this.socketToRoom.get(socket);
    if (!entry) return;
    entry.room.handleMessage(socket, msg, rawJson);
  }

  // ---------------------------------------------------------------------------
  // Disconnection
  // ---------------------------------------------------------------------------

  /** Full disconnect handler — two distinct paths:
   *
   *  **Pre-start** (host leaves before game begins):
   *  → teardownUnstartedRoom() — room deleted immediately, all sockets detached.
   *
   *  **Mid-game** (any socket leaves after game started):
   *  → handlePlayerLeftMidGame() — broadcasts PLAYER_LEFT, migrates host if needed.
   *  → If room is now empty, schedules delayed cleanup.
   *
   *  RoomManager owns all socket/player tracking (connectedSockets, slotAssignments).
   *  GameRoom only owns rate limit state, cleaned up via clearRateLimits(). */
  handleSocketDisconnect(socket: WebSocket): void {
    const entry = this.socketToRoom.get(socket);
    if (!entry) return;

    const playerId = entry.slotAssignments.get(socket);
    const wasHost = socket === entry.hostSocket;

    // RoomManager-level cleanup (always). rejoinTokens is deliberately kept —
    // a socket that drops again must still be able to rejoin its seat.
    entry.connectedSockets.delete(socket);
    entry.slotAssignments.delete(socket);
    entry.pendingReclaim.delete(socket);
    this.socketToRoom.delete(socket);

    // Path 1: Host left before game start — tear down immediately
    if (wasHost && !entry.started) {
      this.teardownUnstartedRoom(entry);
      return;
    }

    // Path 2: Socket left during active game
    if (entry.started) {
      this.handlePlayerLeftMidGame(entry, socket, playerId, wasHost);
    }

    if (entry.connectedSockets.size === 0) {
      this.scheduleCleanup(entry);
    }
  }

  /** Host left before game start — delete the room immediately. */
  private teardownUnstartedRoom(entry: RoomEntry): void {
    if (entry.autoStartTimer) {
      clearTimeout(entry.autoStartTimer);
      entry.autoStartTimer = null;
    }
    for (const s of entry.connectedSockets) {
      this.socketToRoom.delete(s);
    }
    entry.connectedSockets.clear();
    this.rooms.delete(entry.code);
    console.log(`[rooms] Room ${entry.code} deleted (host left before start)`);
  }

  /** Handle a player (or host) disconnecting during an active game.
   *  @param playerId — The disconnected socket's slot, or undefined if the
   *  socket never selected a slot (spectator/watcher). When undefined,
   *  no PLAYER_LEFT is broadcast (spectators are invisible to clients). */
  private handlePlayerLeftMidGame(
    entry: RoomEntry,
    socket: WebSocket,
    playerId: ValidPlayerId | undefined,
    wasHost: boolean,
  ): void {
    entry.room.clearRateLimits(socket);
    if (playerId !== undefined && playerId >= 0) {
      this.broadcastToRoom(entry, { type: MESSAGE.PLAYER_LEFT, playerId });
    }
    if (wasHost) {
      this.migrateHost(entry, playerId);
    }
  }

  /** Promote the lowest-slot player to host; falls back to any open socket. */
  private migrateHost(
    entry: RoomEntry,
    disconnectedPlayerId: ValidPlayerId | undefined,
  ): void {
    let newHostSocket: WebSocket | undefined;
    let newHostPlayerId: ValidPlayerId | undefined;

    // Prefer lowest-playerId player. A pendingReclaim socket (rejoined but
    // still bootstrapping/adopting its resync) is skipped — it can't yet
    // serialize an authoritative snapshot.
    for (const [sock, sid] of entry.slotAssignments) {
      if (entry.pendingReclaim.has(sock)) continue;
      if (
        sock.readyState === WebSocket.OPEN &&
        (newHostPlayerId === undefined || sid < newHostPlayerId)
      ) {
        newHostSocket = sock;
        newHostPlayerId = sid;
      }
    }
    // Fallback: any connected socket (watcher becomes relay host, all players
    // AI) — likewise skip a still-bootstrapping rejoiner.
    if (!newHostSocket) {
      for (const sock of entry.connectedSockets) {
        if (entry.pendingReclaim.has(sock)) continue;
        if (sock.readyState === WebSocket.OPEN) {
          newHostSocket = sock;
          break;
        }
      }
    }

    if (newHostSocket) {
      entry.hostSocket = newHostSocket;
      entry.room.setHost(newHostSocket);
      this.broadcastToRoom(entry, {
        type: MESSAGE.HOST_LEFT,
        newHostPlayerId: newHostPlayerId ?? null,
        disconnectedPlayerId: disconnectedPlayerId ?? null,
      });
      console.log(
        `[rooms] Room ${entry.code}: host migrated to P${newHostPlayerId}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Lobby queries
  // ---------------------------------------------------------------------------

  getEntry(socket: WebSocket): RoomEntry | undefined {
    return this.socketToRoom.get(socket);
  }

  /** Get list of players who have selected a slot. */
  getSlottedPlayers(
    entry: RoomEntry,
  ): { playerId: ValidPlayerId; name: string }[] {
    const result: { playerId: ValidPlayerId; name: string }[] = [];
    for (const [, pid] of entry.slotAssignments) {
      if (pid >= 0) {
        result.push({
          playerId: pid,
          name: PLAYER_NAMES[pid] ?? `P${pid + 1}`,
        });
      }
    }
    return result;
  }

  /** Get the slot occupied by the host, or null if host hasn't selected a slot. */
  getHostId(entry: RoomEntry): ValidPlayerId | null {
    return entry.slotAssignments.get(entry.hostSocket) ?? null;
  }

  /** Seconds elapsed since room creation. */
  getElapsedSec(entry: RoomEntry): number {
    return (Date.now() - entry.createdAt) / 1000;
  }

  /** List rooms available to join (not started, not empty). */
  listRooms(): {
    code: string;
    players: number;
    settings: RoomSettings;
    elapsedSec: number;
  }[] {
    const result: {
      code: string;
      players: number;
      settings: RoomSettings;
      elapsedSec: number;
    }[] = [];
    for (const entry of this.rooms.values()) {
      if (entry.started) continue;
      result.push({
        code: entry.code,
        players: entry.slotAssignments.size,
        settings: entry.room.settings,
        elapsedSec: Math.round(this.getElapsedSec(entry)),
      });
    }
    return result;
  }

  /** Get the list of occupied slot IDs. */
  getOccupiedSlots(entry: RoomEntry): number[] {
    return [...entry.slotAssignments.values()];
  }

  // ---------------------------------------------------------------------------
  // Broadcasting
  // ---------------------------------------------------------------------------

  broadcastToRoom(entry: RoomEntry, msg: ServerMessage): void {
    const json = JSON.stringify(msg);
    for (const sock of entry.connectedSockets) {
      safeSendRaw(sock, json);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private generateCode(): string {
    let code: string;
    do {
      code = "";
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
        code +=
          ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
      }
    } while (this.rooms.has(code));
    return code;
  }

  private disconnectSocketFromRoom(socket: WebSocket): void {
    if (this.socketToRoom.has(socket)) {
      this.handleSocketDisconnect(socket);
    }
  }

  private scheduleCleanup(entry: RoomEntry): void {
    if (entry.cleanupTimer) return;
    entry.cleanupTimer = setTimeout(() => {
      this.rooms.delete(entry.code);
      console.log(`[rooms] Room ${entry.code} cleaned up`);
    }, ROOM_CLEANUP_DELAY_MS);
  }
}
