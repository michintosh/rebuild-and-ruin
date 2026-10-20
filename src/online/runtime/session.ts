/**
 * Online runtime session helpers — four entry points for room/game
 * lifecycle transitions over runtime/session/timing/container deps.
 * `showLobby` / `showWaitingRoom` are user-driven UI navigation;
 * `initFromServer` / `restoreFullState` are WebSocket-driven (game start
 * and snapshot recovery after disconnect/migration).
 */

import { generateMap } from "../../game/index.ts";
import type { FullStateMessage, InitMessage } from "../../protocol/protocol.ts";
import { ROUTE_ONLINE } from "../../protocol/routes.ts";
import { bootstrapGame } from "../../runtime/bootstrap.ts";
import type { GameRuntime } from "../../runtime/handle.ts";
import { setMode, setRuntimeGameState } from "../../runtime/state.ts";
import type { TimingApi } from "../../runtime/timing-api.ts";
import type { GameMode } from "../../shared/core/game-constants.ts";
import type { ValidPlayerId } from "../../shared/core/player-slot.ts";
import { Rng } from "../../shared/platform/rng.ts";
import { MAX_PLAYERS } from "../../shared/ui/player-config.ts";
import { Mode } from "../../shared/ui/ui-mode.ts";
import { pageOnline } from "../online-dom.ts";
import {
  buildRoomCodeOverlay,
  hideRoomCodeOverlay,
} from "../online-lobby-ui.ts";
import { applyFullStateToRunningRuntime } from "../online-rehydrate.ts";
import { GAME_CONTAINER_ACTIVE, navigateTo } from "../online-router.ts";
import type { OnlineSession } from "../online-session.ts";

interface OnlineRuntimeSessionDeps {
  getRuntime: () => GameRuntime;
  session: OnlineSession;
  /** Injected timing primitives — replaces bare `performance.now()` access.
   *  Same `TimingApi` instance the runtime receives via `RuntimeConfig.timing`. */
  timing: TimingApi;
  resetNetworkingForNewGame: () => void;
  destroyClient: () => void;
  log: (msg: string) => void;
  container: HTMLElement;
}

export function createOnlineRuntimeSessionHelpers(
  deps: OnlineRuntimeSessionDeps,
) {
  function showLobby(): void {
    const runtime = deps.getRuntime();
    runtime.shutdown();
    deps.container.classList.remove(GAME_CONTAINER_ACTIVE);
    hideRoomCodeOverlay();
    navigateTo(ROUTE_ONLINE);
    deps.destroyClient();
    runtime.runtimeState.lobby.roomSeedDisplay = null;
  }

  function showWaitingRoom(code: string, seed: number): void {
    const runtime = deps.getRuntime();
    const lobby = runtime.runtimeState.lobby;
    deps.session.roomSeed = seed;
    // Retained for the away-disconnect → tab-return rejoin handshake
    // (rejoinRoom needs the CODE; survives a tab-hide in JS memory).
    deps.session.roomCode = code;
    lobby.roomSeedDisplay = seed;
    const joinUrl = `${location.origin}${location.pathname}?server=${location.host}&join=${code}`;
    buildRoomCodeOverlay(code, joinUrl);
    pageOnline.hidden = true;
    deps.container.classList.add(GAME_CONTAINER_ACTIVE);
    lobby.seed = seed;
    deps.log(`[online] seed: ${seed}`);
    lobby.map = generateMap(new Rng(seed));
    lobby.joined = new Array(deps.session.roomPlayerCount).fill(false);
    lobby.active = true;
    deps.session.lobbyStartTime = deps.timing.now();
    setMode(runtime.runtimeState, Mode.LOBBY);
    runtime.warmMapCache(lobby.map);
  }

  async function initFromServer(msg: InitMessage): Promise<void> {
    const runtime = deps.getRuntime();
    hideRoomCodeOverlay();
    runtime.runtimeState.lobby.active = false;
    const settings = runtime.runtimeState.settings;
    const playerCount = Math.min(Math.max(1, msg.playerCount), MAX_PLAYERS);
    // Seated-human set — IDENTICAL on every peer, spectators included:
    // every client derived `occupiedSlots` from the same ordered lobby
    // stream (ROOM_JOINED snapshot + JOINED/PLAYER_LEFT broadcasts).
    // bootstrapGame draws AI identity from the shared `state.rng` once
    // per non-human slot in slot order, so this array is a cross-peer
    // RNG contract. It must NOT be "slots this peer drives" — that made
    // each peer skip a different slot's draws, desyncing straddle
    // seatings (humans at 0+2), 3-human takeover identities, and every
    // spectator's mirror sim from tick 0.
    const humanSlots = Array.from({ length: playerCount }, (_, index) =>
      deps.session.occupiedSlots.has(index as ValidPlayerId),
    );
    const keyBindings = Array.from({ length: playerCount }, (_, index) =>
      index === deps.session.myPlayerId ? settings.keyBindings[0] : undefined,
    );
    // Captured before the awaits inside bootstrapGame: an online leave /
    // route-level shutdown mid-init tears the session down (bumping
    // bootGeneration via teardownSession), and the bootstrap tail must
    // not boot a game behind whatever UI replaced it.
    const generation = runtime.runtimeState.bootGeneration;
    await bootstrapGame({
      isCancelled: () => runtime.runtimeState.bootGeneration !== generation,
      seed: msg.seed,
      maxPlayers: playerCount,
      maxRounds: msg.settings.maxRounds,
      cannonMaxHp: msg.settings.cannonMaxHp,
      buildTimer: msg.settings.buildTimer,
      cannonPlaceTimer: msg.settings.cannonPlaceTimer,
      firstRoundCannons: msg.settings.firstRoundCannons,
      gameMode: msg.settings.gameMode as GameMode,
      humanSlots,
      keyBindings,
      // The HOST's difficulty, not this peer's local setting — personality
      // rolls consume a difficulty-dependent number of shared-stream draws
      // (see InitMessage.settings.difficulty).
      difficulty: msg.settings.difficulty,
      log: deps.log,
      clearFrameData: () => runtime.clearFrameData(),
      setState: (state) => {
        setRuntimeGameState(runtime.runtimeState, state, deps.timing.now());
      },
      setControllers: (controllers) => {
        runtime.runtimeState.controllers = [...controllers];
      },
      resetUIState: () => {
        runtime.lifecycle.resetUIState();
        deps.resetNetworkingForNewGame();
      },
      enterSelection: () => runtime.selection.enter(),
      onStateReady: () => {
        // Bind sound/haptics observers to the fresh `state.bus` — without
        // this, online matches play with the entire SFX event map, fanfare,
        // and haptics silently dead. Watcher visuals + stats need no
        // subscription: they're populated from `result.impactEvents` inside
        // `tickBattlePhase` (same code path as host).
        runtime.bindStateObservers();
      },
      // Camera-backed human aim resolver (screen px → occluded world). Only
      // the local human slot uses it; remote/AI slots resolve their own aim.
      humanAimResolver: (_state, x, y) => runtime.camera.pickHitWorld(x, y),
      // Keyboard counterpart: occlude the raw world crosshair at fire time so
      // keyboard aim hits the wall it visually sits on.
      humanWorldOccluder: (wx, wy) => runtime.camera.occludeWorld(wx, wy),
    });
  }

  function restoreFullState(msg: FullStateMessage): void {
    // Live session, not frameMeta's frame-start snapshot — the old
    // host's PLAYER_LEFT lands in the same inter-frame window as this
    // message. Its seat is parked in pendingSeatTakeovers (never flipped
    // at wall-clock receipt); the apply reconciles already-snapshotted
    // takeovers and the promoted host re-stamps the rest (promote.ts).
    applyFullStateToRunningRuntime(deps.getRuntime(), msg, deps.session);
  }

  return {
    initFromServer,
    restoreFullState,
    showLobby,
    showWaitingRoom,
  };
}
