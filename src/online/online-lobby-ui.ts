import qrcode from "qrcode-generator";
import { type ClientMessage, MESSAGE } from "../protocol/protocol.ts";
import { API_ROOMS_PATH } from "../protocol/routes.ts";
import { MAX_PLAYERS } from "../shared/ui/player-config.ts";
import { GOLD, PANEL_BG } from "../shared/ui/theme.ts";
import { computeApiUrl } from "./online-config.ts";
import { roomCodeOverlay } from "./online-dom.ts";

interface LobbyElements {
  btnCreateConfirm: HTMLElement;
  btnJoinConfirm: HTMLElement;
  rounds: HTMLSelectElement;
  hp: HTMLSelectElement;
  wait: HTMLSelectElement;
  gameMode: HTMLSelectElement;
  playerCount: HTMLSelectElement;
  webcam: HTMLSelectElement;
  seed: HTMLInputElement;
  joinCodeInput: HTMLInputElement;
  createError: HTMLElement;
  joinError: HTMLElement;
}

interface InitLobbyUiDeps {
  elements: LobbyElements;
  connect: () => void;
  send: (msg: ClientMessage) => void;
  getSocket: () => WebSocket | null;
  setIsHost: (value: boolean) => void;
  isVisible?: () => boolean;
  doc?: Document;
}

const ROOM_CODE_LENGTH = 4;
const ROOM_POLL_INTERVAL_MS = 3000;
const SECS_PER_MIN = 60;
const SECS_PER_HOUR = 3600;
const CLICK_EVENT = "click";
const SUBMIT_EVENT = "submit";
const QR_DISPLAY_PIXELS = 120;
const QR_QUIET_MODULES = 4;

/** Stored interval so repeated initLobbyUi calls don't leak timers. */
let roomPollTimer: ReturnType<typeof setInterval> | undefined;

export function initLobbyUi({
  elements,
  connect,
  send,
  getSocket,
  setIsHost,
  isVisible = () => true,
  doc = document,
}: InitLobbyUiDeps): { joinRoom: (code: string) => void } {
  // Pending action replaces any previous one so rapid clicks / Create→Join
  // sequences don't stack multiple "open" listeners on the same socket.
  let pendingAction: (() => void) | undefined;

  const scheduleOnOpen = (action: () => void) => {
    pendingAction = action;
    connect();
    const socket = getSocket();
    // Inline readyState check — mirrors isSocketOpen() in online-session.ts.
    if (socket?.readyState === WebSocket.OPEN) {
      pendingAction = undefined;
      action();
    } else {
      socket?.addEventListener(
        "open",
        () => {
          if (!pendingAction) return;
          const a = pendingAction;
          pendingAction = undefined;
          a();
        },
        { once: true },
      );
    }
  };

  const formCreate = elements.btnCreateConfirm.closest("form");
  (formCreate ?? elements.btnCreateConfirm).addEventListener(
    formCreate ? SUBMIT_EVENT : CLICK_EVENT,
    (e) => {
      e.preventDefault();
      elements.createError.textContent = "";
      scheduleOnOpen(() => {
        const roundsVal = Number(elements.rounds.value);
        const roundCount = roundsVal > 0 ? roundsVal : 0;
        const seedStr = elements.seed.value.trim();
        const seedNum = seedStr.length > 0 ? Number(seedStr) : undefined;
        send({
          type: MESSAGE.CREATE_ROOM,
          settings: {
            maxRounds: roundCount,
            cannonMaxHp: Number(elements.hp.value),
            waitTimerSec: Number(elements.wait.value),
            seed: Number.isFinite(seedNum) ? seedNum : undefined,
            gameMode: elements.gameMode.value,
            playerCount: Number(elements.playerCount.value),
            webcam: elements.webcam.value === "on",
          },
        });
        setIsHost(true);
      });
    },
  );

  const doJoin = (code: string) => {
    elements.joinError.textContent = "";
    if (code.length !== ROOM_CODE_LENGTH) {
      elements.joinError.textContent = `Enter a ${ROOM_CODE_LENGTH}-letter room code`;
      return;
    }
    scheduleOnOpen(() => send({ type: MESSAGE.JOIN_ROOM, code }));
  };

  const formJoin = elements.btnJoinConfirm.closest("form");
  (formJoin ?? elements.btnJoinConfirm).addEventListener(
    formJoin ? SUBMIT_EVENT : CLICK_EVENT,
    (e) => {
      e.preventDefault();
      doJoin(elements.joinCodeInput.value.trim().toUpperCase());
    },
  );

  // Room list: fetch and render available rooms, poll every 3s while visible
  const roomListEl = doc.getElementById("room-list");
  if (roomListEl) {
    const joinViaCode = (code: string) => {
      elements.joinCodeInput.value = code;
      doJoin(code.toUpperCase());
    };

    const element = (tag: string, cls: string, text?: string) => {
      const e = doc.createElement(tag);
      e.className = cls;
      if (text) e.textContent = text;
      return e;
    };

    const setMessage = (cls: string, text: string) => {
      roomListEl.innerHTML = "";
      roomListEl.appendChild(element("div", cls, text));
    };

    const renderRoomList = (
      rooms: readonly {
        code: string;
        players: number;
        settings: {
          maxRounds: number;
          cannonMaxHp: number;
          playerCount?: number;
        };
        elapsedSec: number;
      }[],
    ) => {
      if (rooms.length === 0) {
        setMessage("room-list-empty", "No rooms available");
        return;
      }
      const roundsLabel = (rounds: number) =>
        rounds > 0 ? `${rounds} rounds` : "To The Death";
      const ageLabel = (sec: number) =>
        sec < SECS_PER_MIN
          ? "just now"
          : sec < SECS_PER_HOUR
            ? `${Math.floor(sec / SECS_PER_MIN)}m ago`
            : `${Math.floor(sec / SECS_PER_HOUR)}h ago`;
      roomListEl.innerHTML = "";
      for (const r of rooms) {
        const item = element("div", "room-item");
        item.dataset["code"] = r.code;
        item.appendChild(element("span", "room-code", r.code));
        const info = element("span", "room-info");
        info.append(
          `${r.players}/${r.settings.playerCount ?? MAX_PLAYERS} players · ${ageLabel(r.elapsedSec)}`,
          doc.createElement("br"),
          `${roundsLabel(r.settings.maxRounds)} · ${r.settings.cannonMaxHp} HP`,
        );
        item.appendChild(info);
        item.addEventListener(CLICK_EVENT, () => joinViaCode(r.code));
        roomListEl.appendChild(item);
      }
    };

    const fetchRooms = () => {
      fetch(computeApiUrl(API_ROOMS_PATH))
        .then((r) => r.json())
        .then(renderRoomList)
        .catch(() => {
          setMessage("room-list-empty", "Server unavailable");
        });
    };

    // Initial fetch + poll while page is visible
    fetchRooms();
    if (roomPollTimer) clearInterval(roomPollTimer);
    roomPollTimer = setInterval(() => {
      if (isVisible()) fetchRooms();
    }, ROOM_POLL_INTERVAL_MS);

    // Stop polling on page unload to avoid leaked timers
    addEventListener(
      "pagehide",
      () => {
        if (roomPollTimer) {
          clearInterval(roomPollTimer);
          roomPollTimer = undefined;
        }
      },
      { once: true },
    );
  }
  return { joinRoom: doJoin };
}

export function hideRoomCodeOverlay(): void {
  roomCodeOverlay.style.display = "none";
}

/** Populate the room-code overlay with a styled code badge and QR image. */
export function buildRoomCodeOverlay(code: string, joinUrl: string): void {
  roomCodeOverlay.style.display = "block";
  roomCodeOverlay.innerHTML = "";
  const wrapper = document.createElement("div");
  Object.assign(wrapper.style, {
    position: "fixed",
    top: "12px",
    left: "50%",
    transform: "translateX(-50%)",
    background: PANEL_BG(0.9),
    padding: "12px 24px",
    borderRadius: "6px",
    border: `2px solid ${GOLD}`,
    color: GOLD,
    fontSize: "24px",
    letterSpacing: "6px",
    fontWeight: "bold",
    zIndex: "10",
    textAlign: "center",
  });
  wrapper.textContent = code;
  const qrCanvas = renderQrCanvas(joinUrl, document);
  if (qrCanvas) wrapper.appendChild(qrCanvas);
  roomCodeOverlay.appendChild(wrapper);
}

function renderQrCanvas(text: string, doc: Document): HTMLCanvasElement | null {
  const qr = buildQr(text);
  if (!qr) return null;
  const moduleCount = qr.getModuleCount();
  const totalModules = moduleCount + QR_QUIET_MODULES * 2;
  const scale = Math.max(1, Math.floor(QR_DISPLAY_PIXELS / totalModules));
  const pixelSize = totalModules * scale;
  const canvas = doc.createElement("canvas");
  canvas.width = pixelSize;
  canvas.height = pixelSize;
  Object.assign(canvas.style, {
    display: "block",
    margin: "8px auto 0",
    width: `${QR_DISPLAY_PIXELS}px`,
    height: `${QR_DISPLAY_PIXELS}px`,
    imageRendering: "pixelated",
    borderRadius: "4px",
  });
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, pixelSize, pixelSize);
  ctx.fillStyle = "#000";
  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      if (!qr.isDark(row, col)) continue;
      ctx.fillRect(
        (col + QR_QUIET_MODULES) * scale,
        (row + QR_QUIET_MODULES) * scale,
        scale,
        scale,
      );
    }
  }
  return canvas;
}

function buildQr(text: string) {
  try {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    return qr;
  } catch {
    return null;
  }
}
