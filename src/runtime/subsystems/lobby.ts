import { generateMap } from "../../game/index.ts";
import {
  LOBBY_SKIP_LOCKOUT,
  LOBBY_SKIP_STEP,
} from "../../shared/core/game-constants.ts";
import type { GameMap } from "../../shared/core/geometry-types.ts";
import { CANVAS_H, CANVAS_W, TILE_SIZE } from "../../shared/core/grid.ts";
import type { KeyBindings } from "../../shared/core/input-action.ts";
import type { ValidPlayerId } from "../../shared/core/player-slot.ts";
import {
  CURSOR_DEFAULT,
  CURSOR_POINTER,
  IS_TOUCH_DEVICE,
} from "../../shared/platform/platform.ts";
import { Rng } from "../../shared/platform/rng.ts";
import type { RenderOverlay } from "../../shared/ui/overlay-types.ts";
import { computeGameSeed, MAX_PLAYERS } from "../../shared/ui/player-config.ts";
import { Mode } from "../../shared/ui/ui-mode.ts";
import { type RuntimeState, setMode } from "../state.ts";
import type {
  ComputeLobbyLayoutFn,
  CreateLobbyOverlayFn,
  LobbyClickHitTestFn,
  LobbyHit,
  UIContext,
} from "../ui-contracts.ts";

/** Public lobby handle exposed on `GameRuntime`. Drives the pre-game
 *  lobby (player joining, seed entry, mode selection). */
export interface RuntimeLobby {
  /** Runtime-internal lobby reset: clear joined/active/timer/map, clear
   *  quit + options state, mark the frame dirty, flip mode to LOBBY.
   *  Hosts call this from their `RuntimeConfig.showLobby` callback and
   *  add their own platform extras (browser: title music start).
   *  Headless tests bind `showLobby` straight to this. */
  show: () => void;
  /** Mark a slot joined and request a re-render of the lobby. */
  markJoined: (pid: ValidPlayerId) => void;
}

interface LobbySystemDeps {
  runtimeState: RuntimeState;
  uiCtx: UIContext;
  requestRender: () => void;
  warmMapCache: (map: GameMap) => void;
  log: (msg: string) => void;
  showOptions: () => void;
  isOnline: boolean;
  onTickLobbyExpired: () => void | Promise<void>;
  onLobbySlotJoined: (pid: ValidPlayerId) => void;

  // Render-domain functions (injected from composition root)
  createLobbyOverlay: CreateLobbyOverlayFn;
  computeLobbyLayout: ComputeLobbyLayoutFn;
  lobbyClickHitTest: LobbyClickHitTestFn;
}

interface LobbySystem {
  /** Build the lobby's `{map, overlay}` pair for the unified render entry
   *  in `render.ts`. Lazy seed/map generation lives here so the
   *  first frame after `show()` always has a preview to draw. */
  buildOverlay: () => { map: GameMap; overlay: RenderOverlay | undefined };
  tickLobby: (dt: number) => void;
  lobbyKeyJoin: (key: string) => boolean;
  lobbyClick: (canvasX: number, canvasY: number) => boolean;
  cursorAt: (canvasX: number, canvasY: number) => string;
  /** Runtime-internal lobby reset: clear joined/active/timer/map, clear
   *  quit + options state, mark frame dirty, flip mode to LOBBY. The host's
   *  `RuntimeConfig.showLobby` callback wraps this with platform extras
   *  (browser: title music). */
  show: () => void;
  /** Mark a slot joined and request a re-render of the lobby preview. */
  markJoined: (pid: ValidPlayerId) => void;
  /** Recompute `lobby.seed` from settings and regenerate the map preview
   *  when either the seed changed or no preview exists yet. Called from
   *  the options screen on close (settings may have changed) and from
   *  `buildOverlay` on first lobby entry (map slot still null). */
  refreshSeed: () => void;
}

export function createLobbySystem(deps: LobbySystemDeps): LobbySystem {
  const { runtimeState, uiCtx } = deps;

  // Built fresh on each lobby keypress (the only caller) rather than cached:
  // the controls screen rebinds keys in place (and saves) mid-session, so a
  // cached map would leave the lobby joining on the OLD confirm key until a
  // reload. Rebuilding a handful of entries per keypress is negligible.
  function getConfirmKeys(): Map<string, number> {
    return buildLobbyConfirmKeys(uiCtx.settings.keyBindings);
  }

  /** Refresh lobby seed + map preview when the seed changed *or* no map
   *  preview exists yet. The second condition covers first-entry bootstrap
   *  when `computeGameSeed()` happens to match the initial `lobby.seed = 0`
   *  (user picked seed "0" via localStorage) — without the null check, the
   *  seed-equality branch skips map generation and `lobby.map` stays null
   *  through the first lobby render, crashing `drawMap`. */
  function refreshSeed(): void {
    const newSeed = computeGameSeed(runtimeState.settings);
    if (
      newSeed !== runtimeState.lobby.seed ||
      runtimeState.lobby.map === null
    ) {
      runtimeState.lobby.seed = newSeed;
      deps.log(`[lobby] seed: ${newSeed}`);
      const map = generateMap(new Rng(newSeed));
      runtimeState.lobby.map = map;
      deps.warmMapCache(map);
    }
  }

  function buildOverlay(): {
    map: GameMap;
    overlay: RenderOverlay | undefined;
  } {
    if (!runtimeState.lobby.map) refreshSeed();
    return deps.createLobbyOverlay(uiCtx);
  }

  function tickLobby(dt: number): void {
    runtimeState.lobby.timerAccum = (runtimeState.lobby.timerAccum ?? 0) + dt;
    if (!runtimeState.lobby.active) return;
    const allJoined = runtimeState.lobby.joined.every(Boolean);
    if (uiCtx.getLobbyRemaining() <= 0 || allJoined) {
      runtimeState.lobby.active = false;
      void deps.onTickLobbyExpired();
    }
  }

  async function onLobbyJoin(pid: ValidPlayerId): Promise<void> {
    deps.onLobbySlotJoined(pid);
    deps.requestRender();
    // On touch devices in local mode, start immediately after joining
    if (IS_TOUCH_DEVICE && !deps.isOnline) {
      runtimeState.lobby.active = false;
      await deps.onTickLobbyExpired();
    }
  }

  function lobbyKeyJoin(key: string): boolean {
    if (!runtimeState.lobby.active) return false;
    const pid = getConfirmKeys().get(key);
    if (pid === undefined) return false;
    if (runtimeState.lobby.joined[pid]) {
      lobbySkipStep();
      return true;
    }
    void onLobbyJoin(pid as ValidPlayerId);
    return true;
  }

  // Coordinate space: canvasX/canvasY are CSS pixels passed directly to lobbyClickHitTest.
  // Lobby hit-tests handle TILE_SIZE scaling internally — do NOT divide by SCALE here.

  function lobbyHitAt(canvasX: number, canvasY: number): LobbyHit | null {
    return deps.lobbyClickHitTest({
      canvasX,
      canvasY,
      canvasW: CANVAS_W,
      canvasH: CANVAS_H,
      tileSize: TILE_SIZE,
      slotCount: runtimeState.lobby.joined.length,
      computeLayout: deps.computeLobbyLayout,
    });
  }

  function lobbyClick(canvasX: number, canvasY: number): boolean {
    if (!runtimeState.lobby.active) return false;
    const hit = lobbyHitAt(canvasX, canvasY);
    if (!hit) return false;
    if (hit.type === "gear") {
      void deps.showOptions();
      return true;
    }
    // Mouse/trackpad can only join one slot (keyboard can join additional slots).
    // If already joined or slot taken, treat click as a "hurry up" timer skip.
    if (
      runtimeState.inputTracking.mouseJoinedSlot !== null ||
      runtimeState.lobby.joined[hit.slotId]
    ) {
      lobbySkipStep();
      return true;
    }
    runtimeState.inputTracking.mouseJoinedSlot = hit.slotId;
    void onLobbyJoin(hit.slotId);
    return true;
  }

  function cursorAt(canvasX: number, canvasY: number): string {
    if (!runtimeState.lobby.active) return CURSOR_DEFAULT;
    const hit = lobbyHitAt(canvasX, canvasY);
    return hit ? CURSOR_POINTER : CURSOR_DEFAULT;
  }

  /** Speed up lobby timer by one step if allowed. */
  function lobbySkipStep(): void {
    if (uiCtx.getLobbyRemaining() <= LOBBY_SKIP_LOCKOUT) return;
    runtimeState.lobby.timerAccum =
      (runtimeState.lobby.timerAccum ?? 0) + LOBBY_SKIP_STEP;
  }

  function show(): void {
    runtimeState.lobby.joined = new Array(MAX_PLAYERS).fill(false);
    runtimeState.lobby.active = true;
    runtimeState.lobby.timerAccum = 0;
    runtimeState.lobby.map = null; // force fresh seed + map preview
    runtimeState.quit = { pending: false };
    runtimeState.optionsUI.context = { kind: "lobby" };
    // Quitting to the lobby while paused (P-key, or the ESC countdown started
    // mid-pause) would otherwise leave `pausedBy` set until the next
    // `startGame` → `resetTransientState`. LOBBY is not a gameplay mode so the
    // demo loop never freezes today, but the residue is a trap for any future
    // lobby-side `isPaused` read — normalize it alongside the other flags.
    runtimeState.pausedBy = "none";
    deps.requestRender();
    setMode(runtimeState, Mode.LOBBY);
  }

  function markJoined(pid: ValidPlayerId): void {
    runtimeState.lobby.joined[pid] = true;
    deps.requestRender();
  }

  return {
    buildOverlay,
    tickLobby,
    lobbyKeyJoin,
    lobbyClick,
    cursorAt,
    show,
    markJoined,
    refreshSeed,
  };
}

/** Build a map from confirm key → player slot index for lobby joining. */
function buildLobbyConfirmKeys(
  keyBindings: readonly KeyBindings[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (let idx = 0; idx < keyBindings.length; idx++) {
    const keyBinding = keyBindings[idx]!;
    map.set(keyBinding.confirm, idx);
    map.set(keyBinding.confirm.toUpperCase(), idx);
  }
  return map;
}
