/**
 * Online lobby bootstrapping.
 *
 * Owns the lobby DOM elements, initializes the lobby UI, and exports
 * `lobbyReady` — the single public API consumed by entry.ts.
 */

import {
  btnCreateConfirm,
  btnJoinConfirm,
  createError,
  createGameMode,
  createHp,
  createPlayerCount,
  createRounds,
  createSeed,
  createWait,
  createWebcam,
  joinCodeInput,
  joinError,
  pageOnline,
} from "../online-dom.ts";
import { initLobbyUi } from "../online-lobby-ui.ts";
import { defaultClient } from "../online-stores.ts";
import { connect } from "./ws.ts";

const lobbyElements = {
  btnCreateConfirm,
  btnJoinConfirm,
  rounds: createRounds,
  hp: createHp,
  wait: createWait,
  gameMode: createGameMode,
  playerCount: createPlayerCount,
  webcam: createWebcam,
  seed: createSeed,
  joinCodeInput,
  createError,
  joinError,
};
const initDomLobby = () =>
  initLobbyUi({
    elements: lobbyElements,
    connect: () => {
      connect().catch(() => {
        const msg = "Connection failed \u2014 is the server running?";
        lobbyElements.createError.textContent = msg;
        lobbyElements.joinError.textContent = msg;
      });
    },
    send: defaultClient.send,
    getSocket: () => defaultClient.ctx.session.socket,
    setIsHost: (value) => {
      defaultClient.ctx.session.isHost = value; // eslint-disable-line no-restricted-syntax -- lobby host assignment
    },
    isVisible: () => !pageOnline.hidden,
  });
export const lobbyReady = Promise.resolve(initDomLobby()).then((lobby) => {
  pageOnline.setAttribute("data-ready", "1");
  return lobby;
});
