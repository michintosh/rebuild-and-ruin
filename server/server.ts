import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import {
  MESSAGE,
  type RoomSettings,
  type ServerMessage,
} from "../src/protocol/protocol.ts";
import {
  API_ROOMS_PATH,
  HEALTH_PATH,
  WS_PLAY_PATH,
} from "../src/protocol/routes.ts";
import type { ValidPlayerId } from "../src/shared/core/player-slot.ts";
import { PLAYER_NAMES } from "../src/shared/ui/player-config.ts";
import { RoomManager } from "./room-manager.ts";

const rooms = new RoomManager();
/** Reject messages larger than 64 KB (full_state worst case is ~30 KB). */
const MAX_MESSAGE_SIZE = 65_536;
const DEFAULT_PORT = 8001;
const PORT = parseInt(process.env.PORT ?? String(DEFAULT_PORT));

const CORS_HEADERS = { "Access-Control-Allow-Origin": "*" };

const httpServer = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      ...CORS_HEADERS,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    res.end();
    return;
  }

  if (url.pathname === API_ROOMS_PATH) {
    res.writeHead(200, {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
    });
    res.end(JSON.stringify(rooms.listRooms()));
    return;
  }

  if (url.pathname === WS_PLAY_PATH) {
    res.writeHead(426);
    res.end("Expected WebSocket upgrade");
    return;
  }

  if (url.pathname === HEALTH_PATH) {
    res.writeHead(200);
    res.end("ok");
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

const wss = new WebSocketServer({
  server: httpServer,
  path: WS_PLAY_PATH,
  maxPayload: MAX_MESSAGE_SIZE,
});

wss.on("connection", (ws) => {
  // `ws` sockets expose the same surface the rooms use (readyState, send,
  // onmessage/onclose/onerror); the room code is typed against the DOM type.
  const socket = ws as unknown as WebSocket;

  socket.onmessage = (event) => {
    try {
      if (typeof event.data !== "string") return;
      if (event.data.length > MAX_MESSAGE_SIZE) return;
      const msg = JSON.parse(event.data);
      if (typeof msg.type !== "string") return;
      handleMessage(socket, msg, event.data);
    } catch {
      // Ignore malformed messages
    }
  };

  socket.onclose = () => {
    rooms.handleSocketDisconnect(socket);
  };

  socket.onerror = (e) => {
    console.error("[server] WebSocket error:", e);
  };
});

httpServer.listen(PORT, () => {
  console.log(`[server] Listening on http://localhost:${PORT}`);
});

/** Route incoming WebSocket messages.
 *  Two-tier dispatch: this switch handles lobby/room-management messages
 *  (CREATE_ROOM, JOIN_ROOM, SELECT_SLOT, PING) that require server-side
 *  responses. All other messages fall through to RoomManager→GameRoom which
 *  validates and relays using set-based gates (HOST_ONLY, PHASE_GATES,
 *  RATE_LIMITED_TYPES).
 *
 *  Two-tier dispatch: lobby/room-management messages use this simple switch;
 *  in-game messages use game-room.ts's multi-stage validation pipeline.
 *  New game-state messages go in game-room.ts, not here. */
function handleMessage(
  socket: WebSocket,
  msg: Record<string, unknown>,
  rawJson: string,
): void {
  switch (msg.type) {
    case MESSAGE.CREATE_ROOM: {
      const code = rooms.createRoom(msg.settings as RoomSettings, socket);
      if (!code) {
        send(socket, {
          type: MESSAGE.ROOM_ERROR,
          message: "Server full, try again later",
        });
        return;
      }
      const entry = rooms.getEntry(socket)!;
      // No slot assigned yet — player clicks a panel to pick their color
      send(socket, {
        type: MESSAGE.ROOM_CREATED,
        code,
        settings: entry.room.settings,
        seed: entry.room.seed,
      });
      console.log(`[server] Room ${code} created`);
      break;
    }

    case MESSAGE.JOIN_ROOM: {
      if (typeof msg.code !== "string") break;
      const entry = rooms.joinRoom(msg.code, socket);
      if (!entry) {
        send(socket, {
          type: MESSAGE.ROOM_ERROR,
          message: "Room not found or already started",
        });
        return;
      }
      // No slot assigned yet — player clicks a panel to pick their color
      send(socket, {
        type: MESSAGE.ROOM_JOINED,
        code: entry.code,
        players: rooms.getSlottedPlayers(entry),
        settings: entry.room.settings,
        hostId: rooms.getHostId(entry),
        seed: entry.room.seed,
        elapsedSec: rooms.getElapsedSec(entry),
      });
      console.log(`[server] Player joined room ${entry.code}`);
      break;
    }

    case MESSAGE.SELECT_SLOT: {
      const selection = rooms.selectSlot(socket, msg.playerId as ValidPlayerId);
      if (!selection) break;
      const entry = rooms.getEntry(socket);
      if (!entry) break;
      const previousPlayerId =
        selection.previousPlayerId !== null &&
        selection.previousPlayerId !== selection.playerId
          ? selection.previousPlayerId
          : undefined;
      send(socket, {
        type: MESSAGE.JOINED,
        playerId: selection.playerId,
        previousPlayerId,
        rejoinToken: selection.rejoinToken,
      });
      // Notify all in room about the updated slot assignments
      rooms.broadcastToRoom(entry, {
        type: MESSAGE.PLAYER_JOINED,
        playerId: selection.playerId,
        name: PLAYER_NAMES[selection.playerId] ?? `P${selection.playerId + 1}`,
        previousPlayerId,
      });
      break;
    }

    case MESSAGE.REJOIN_ROOM: {
      if (typeof msg.code !== "string" || typeof msg.token !== "string") break;
      const ok = rooms.rejoinRoom(msg.code, msg.token, socket);
      if (!ok) {
        send(socket, {
          type: MESSAGE.ROOM_ERROR,
          message: "Unable to rejoin (room ended or seat unavailable)",
        });
      }
      break;
    }

    case MESSAGE.REQUEST_SEAT_RECLAIM: {
      // Routed here (not the GameRoom relay) so RoomManager can validate seat
      // ownership and clear pendingReclaim before forwarding to the host.
      // Best-effort: the host re-validates (seat AI-held + owner alive) before
      // it stamps SEAT_RECLAIM, so a denied request just produces no reply.
      rooms.forwardSeatReclaim(socket, msg.playerId as ValidPlayerId);
      break;
    }

    case MESSAGE.PING:
      break;

    default:
      // In-game messages: route to the player's room
      rooms.handleMessage(socket, msg, rawJson);
      break;
  }
}

/** Send a server-originated message (serializes to JSON).
 *  For relaying client messages, use safeSendRaw() to avoid re-serialization. */
function send(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}
