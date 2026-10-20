import {
  type InitMessage,
  MESSAGE,
  type ServerMessage,
} from "../../protocol/protocol.ts";
import { createVisibilityListener } from "../../runtime/browser/dom.ts";
import {
  createBrowserRuntimeBindings,
  createGameRuntime,
} from "../../runtime/composition.ts";
import type { GameRuntime } from "../../runtime/handle.ts";
import {
  isSessionLive,
  lockstepDebtTicks,
  setMode,
} from "../../runtime/state.ts";
import {
  isHostInContext,
  tickPersistentAnnouncement,
} from "../../runtime/tick-context.ts";
import type { NetworkApi } from "../../runtime/types.ts";
import {
  DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS,
  LOCKSTEP_QUARANTINE_DEBT_TICKS,
} from "../../shared/core/action-schedule.ts";
import { isHuman } from "../../shared/core/controller-guards.ts";
import {
  DIFFICULTY_NORMAL,
  DIFFICULTY_PARAMS,
  SELECT_TIMER,
} from "../../shared/core/game-constants.ts";
import { emitGameEvent, GAME_EVENT } from "../../shared/core/game-event-bus.ts";
import { tryBattleView } from "../../shared/core/phase-views.ts";
import {
  isActivePlayer,
  type ValidPlayerId,
} from "../../shared/core/player-slot.ts";
import type { UpgradeId } from "../../shared/core/upgrade-defs.ts";
import { PLAYER_NAMES } from "../../shared/ui/player-config.ts";
import { createAwayWatchdog } from "../online-away-watchdog.ts";
import { canvas, worldCanvas } from "../online-dom.ts";
import { createHeartbeatMonitor } from "../online-heartbeat.ts";
import { createLagDetector } from "../online-lag-detector.ts";
import { extendWithRemoteCrosshairs } from "../online-remote-crosshairs.ts";
import { pollDeferredResyncs } from "../online-resync-defer.ts";
import { GAME_EXIT_EVENT } from "../online-router.ts";
import { createOnlineSendActions } from "../online-send-actions.ts";
import { createGameOverPayload } from "../online-serialize.ts";
import { defaultClient, RESET_SCOPE_NEW_GAME } from "../online-stores.ts";
import { handleServerMessage, initDeps } from "./deps.ts";
import { initPromote } from "./promote.ts";
import { createOnlineRuntimeSessionHelpers } from "./session.ts";
import {
  disconnectAway,
  disconnectDesync,
  disconnectTooMuchLag,
  initWs,
  rejoinAfterAway,
} from "./ws.ts";

// ── Client shorthand ───────────────────────────────────────────────
// Destructured from defaultClient singleton for brevity. All five names
// reference the same client instance — used throughout this module.
const { ctx, send, devLog, devLogThrottled, maybeSendAimUpdate } =
  defaultClient;
// ── DOM singletons (from centralized boundary) ─────────────────────
const { renderer, timing, keyboardEventSource } = createBrowserRuntimeBindings(
  canvas,
  worldCanvas,
);
// ── Incoming message bus ────────────────────────────────────────────
// Subscribers register via `network.onMessage(handler)`. The WebSocket
// handler delivers via `deliverIncomingMessage`. The seam is what lets
// loopback tests substitute their own delivery without touching the
// dispatcher (handleServerMessage).
const incomingMessageSubscribers = new Set<
  (msg: ServerMessage) => void | Promise<void>
>();
const network: NetworkApi = {
  send,
  onMessage: (handler) => {
    incomingMessageSubscribers.add(handler);
    return () => {
      incomingMessageSubscribers.delete(handler);
    };
  },
  // eslint-disable-next-line no-restricted-syntax -- bridge to runtime layer
  amHost: () => ctx.session.isHost,
  myPlayerId: () => ctx.session.myPlayerId,
  remotePlayerSlots: () => ctx.session.remotePlayerSlots,
};
const sessionHelpers = createOnlineRuntimeSessionHelpers({
  getRuntime: () => runtime,
  session: ctx.session,
  timing,
  resetNetworkingForNewGame: () => {
    defaultClient.resetNetworking(RESET_SCOPE_NEW_GAME);
  },
  destroyClient: () => {
    defaultClient.destroy();
  },
  log: devLog,
  container: renderer.container,
});
// ── Send-on-success action wrappers ────────────────────────────────
// `send` and `getState` are bound once here so individual call sites
// (input dispatch, AI tick) don't have to plumb them through. The
// `runtime` reference is captured by closure — `runtime` itself is
// declared a few lines below; only the closures invoked after
// initialization actually deref it.
const sendActions = createOnlineSendActions({
  send,
  getState: () => runtime.runtimeState.state,
  schedule: (action) => runtime.runtimeState.actionSchedule.schedule(action),
  safetyTicks: DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS,
  isQuarantined: () =>
    lockstepDebtTicks(runtime.runtimeState) >= LOCKSTEP_QUARANTINE_DEBT_TICKS,
});
// ── Desync-detection heartbeat ─────────────────────────────────────
// The host samples its shared-RNG cursor each tick and broadcasts it every
// HEARTBEAT_INTERVAL_TICKS; non-host peers compare it against their own cursor
// at the matching simTick and self-disconnect on a fork. `getState` captures
// `runtime` by closure (declared just below, like `sendActions`) — `recordTick`
// only runs after init. See online-heartbeat.ts for the why.
const heartbeat = createHeartbeatMonitor({
  getState: () => runtime.runtimeState.state,
  amHost: network.amHost,
  send,
  onDesync: (simTick, localRngState, hostRngState) => {
    devLog(
      `DESYNC @simTick=${simTick}: local rng=${localRngState} host rng=${hostRngState} — leaving`,
    );
    // Observational: surfaces the fork to bus observers (E2E parity guards,
    // telemetry) before the self-disconnect. The disconnect runs regardless.
    const state = runtime.runtimeState.state;
    if (state) {
      emitGameEvent(state.bus, GAME_EVENT.DESYNC_DETECTED, {
        simTick,
        localRngState,
        hostRngState,
      });
    }
    disconnectDesync();
  },
});
// ── Runtime creation ────────────────────────────────────────────────
const runtime: GameRuntime = createGameRuntime({
  renderer,
  timing,
  keyboardEventSource,
  network,
  log: devLog,
  logThrottled: devLogThrottled,
  // -1 grace: server fires setTimeout(waitSec * 1000) exactly at waitSec.
  // Subtracting 1 ensures the client shows 0 one second early, so the UI
  // never displays "1" while the server is already starting the game.
  getLobbyRemaining: () =>
    Math.max(
      0,
      ctx.session.roomWaitTimerSec -
        1 -
        (performance.now() - ctx.session.lobbyStartTime) / 1000,
    ),
  getUrlRoundsOverride: () => {
    const param = new URL(location.href).searchParams.get("rounds");
    return param ? Number(param) : 0;
  },
  showLobby: sessionHelpers.showLobby,
  onLobbySlotJoined: (pid: ValidPlayerId) => {
    send({ type: MESSAGE.SELECT_SLOT, playerId: pid });
  },
  onCloseOptions: () => {
    if (runtime.runtimeState.optionsUI.context.kind === "lobby") {
      ctx.session.lobbyStartTime = performance.now();
    }
  },
  onTickLobbyExpired: async () => {
    if (!isHostInContext(ctx.session)) return;
    const diffParams =
      DIFFICULTY_PARAMS[runtime.runtimeState.settings.difficulty] ??
      DIFFICULTY_PARAMS[DIFFICULTY_NORMAL]!;
    const initMsg: InitMessage = {
      type: MESSAGE.INIT,
      seed: ctx.session.roomSeed,
      playerCount: ctx.session.roomPlayerCount,
      settings: {
        maxRounds: ctx.session.roomMaxRounds,
        cannonMaxHp: ctx.session.roomCannonMaxHp,
        buildTimer: diffParams.buildTimer,
        cannonPlaceTimer: diffParams.cannonPlaceTimer,
        firstRoundCannons: diffParams.firstRoundCannons,
        gameMode: ctx.session.roomGameMode,
        difficulty: runtime.runtimeState.settings.difficulty,
      },
    };
    send(initMsg);
    await sessionHelpers.initFromServer(initMsg);
    send({ type: MESSAGE.SELECT_START, timer: SELECT_TIMER });
  },

  onlinePhaseTicks: {
    // ── Host: phase-transition checkpoint broadcasts ──────────────────
    // Direct imports — these are pure (state) → message factories with
    // no captured state, so they need no closure dance.
    broadcastCannonStart: () => send({ type: MESSAGE.CANNON_START }),
    broadcastBattleStart: () => send({ type: MESSAGE.BATTLE_START }),
    broadcastBuildStart: () => send({ type: MESSAGE.BUILD_START }),
    broadcastBuildEnd: () => send({ type: MESSAGE.BUILD_END }),

    // ── Per-controller crosshair fan-out ──────────────────────────────
    // Self-gates by ownership: only the local human's crosshair hits the
    // wire. AI crosshairs are deterministic from strategy.rng + state, so
    // every peer derives them locally — broadcasting would be redundant.
    broadcastLocalCrosshair: (ctrl, crosshair) => {
      if (!isHuman(ctrl) || ctrl.playerId !== ctx.session.myPlayerId) return;
      maybeSendAimUpdate(crosshair.x, crosshair.y, ctrl.playerId);
    },

    // ── Per-frame phantom dedup ───────────────────────────────────────
    // Self-gates by ownership before consulting the dedup channel.
    shouldSendCannonPhantom: (playerId, key) => {
      if (playerId !== ctx.session.myPlayerId) return false;
      return ctx.dedup.cannonPhantom.shouldSend(playerId, key);
    },
    shouldSendPiecePhantom: (playerId, key) => {
      if (playerId !== ctx.session.myPlayerId) return false;
      return ctx.dedup.piecePhantom.shouldSend(playerId, key);
    },

    // ── Cross-machine merging ─────────────────────────────────────────
    extendCrosshairs: (crosshairs, dt) => {
      // The one non-asserting projection in the codebase. `syncCrosshairs`
      // has two battle-phase callers plus a render-path refresh gated on
      // `frameMeta.inBattle`, which is snapshotted at tick start and so
      // stays true through a frame in which battle ended. Remote crosshairs
      // are a battle-only visual, so that window returns the local list
      // untouched rather than asserting.
      const battle = tryBattleView(runtime.runtimeState.state);
      if (!battle) return [...crosshairs];
      return extendWithRemoteCrosshairs(crosshairs, dt, {
        state: battle,
        presence: ctx.presence,
        remotePlayerSlots: ctx.session.remotePlayerSlots,
        logThrottled: devLogThrottled,
      });
    },
    tickMigrationAnnouncement: (dt) =>
      tickPersistentAnnouncement(
        ctx.presence.migrationBanner,
        runtime.runtimeState.frame,
        dt,
      ),
  },
  onlineActions: {
    maybeSendAimUpdate,
    tryPlaceCannon: sendActions.tryPlaceCannon,
    tryPlacePiece: sendActions.tryPlacePiece,
    fire: sendActions.fire,
  },
  onlineEarlyChoices: {
    drainLifeLost: (apply) => {
      const queue = ctx.session.earlyLifeLostChoices;
      if (queue.size === 0) return;
      for (const [pid, queued] of queue) {
        const applied = apply(pid, queued.choice, queued.round);
        devLog(
          `drain life_lost queued P${pid}=${queued.choice} r${queued.round} -> ${applied ? "applied" : "stale"}`,
        );
      }
      queue.clear();
    },
    // Originator-side writer: the local scheduled apply drained with no
    // dialog open (adoption superseded it) — same queue the wire path
    // writes, so the show()-time drain treats own choices like remote ones.
    queueLifeLost: (pid, choice, round) =>
      ctx.session.earlyLifeLostChoices.set(pid, { choice, round }),
    drainUpgradePick: (apply) => {
      const queue = ctx.session.earlyUpgradePickChoices;
      if (queue.size === 0) return;
      for (const [pid, queued] of queue) {
        const applied = apply(pid, queued.choice as UpgradeId, queued.round);
        devLog(
          `drain upgrade_pick queued P${pid}=${queued.choice} r${queued.round} -> ${applied ? "applied" : "stale"}`,
        );
      }
      queue.clear();
    },
    queueUpgradePick: (pid, choice, round) =>
      ctx.session.earlyUpgradePickChoices.set(pid, { choice, round }),
  },
  onEndGame: (winner, gameState) => {
    const payloads = createGameOverPayload(winner, gameState, PLAYER_NAMES);
    devLog(
      `endGame winner=${payloads.winnerName} round=${gameState.round} maxRounds=${gameState.maxRounds}`,
    );
    if (isHostInContext(ctx.session)) send(payloads.serverPayload);
  },
  // Host-only per-frame poll: fire any deferred room-wide resync whose fire
  // tick (requestTick + SAFETY) has arrived (online-resync-defer.ts).
  onlineHostAfterFrame: () =>
    pollDeferredResyncs({ runtime, session: ctx.session, send }),
  // Per-sim-tick desync fingerprint: record this peer's cursor and (host only)
  // broadcast it. Fires on every peer, every live tick (online-heartbeat.ts).
  onSimTickAdvanced: heartbeat.recordTick,
});

/** Pre-warm both audio sub-systems (music WASM + SFX AudioContext) inside a
 *  user-gesture handler. Mirrors main.ts's activateMusic() for the online
 *  flow — called from entry.ts on btn-online / btn-create-confirm /
 *  btn-join-confirm clicks so online games start with a running context.
 *  No-op if the player hasn't dropped their Rampart files into IDB. */
export async function activateAudio(): Promise<void> {
  await Promise.all([runtime.music.activate(), runtime.sfx.activate()]);
}

// ── Initialize dependent modules and register handlers ─────────────
/** Wire runtime into ws/promote/deps modules and register input + exit
 *  handlers. Called once from online-client.ts after module evaluation.
 *
 *  ORDERING INVARIANT — the three init calls must execute in this order:
 *    1. initWs   — sets up WebSocket lifecycle (reconnect, mode reset)
 *    2. initPromote — sets up host promotion (requires runtime)
 *    3. initDeps — sets up server message dispatch (requires all of the above)
 *  Calling out of order will cause "called before init()" runtime errors. */
export function initOnlineRuntime(): void {
  // Step 1: WebSocket lifecycle
  initWs(
    {
      getMode: () => runtime.runtimeState.mode,
      setMode: (mode) => {
        setMode(runtime.runtimeState, mode);
      },
      setAnnouncement: (text) => {
        runtime.runtimeState.frame.announcement = text;
      },
      render: () => runtime.render(),
      // WebSocket fans out incoming messages through the same bus that
      // backs network.onMessage. The dispatcher (handleServerMessage) is
      // registered as a subscriber in step 4 below.
      deliverIncoming: deliverIncomingMessage,
    },
    defaultClient,
  );

  // Step 2: Host promotion
  initPromote(runtime, defaultClient);

  // Step 3: Server message dispatch. The lag detector counts stale wire
  // stamps (the cross-peer fork condition surfaced by warnIfStaleWireStamp);
  // a sustained burst means this peer's link is past the lockstep SAFETY
  // window and the board is forking, so it self-disconnects with a clear
  // message instead of playing on a silently-forked board. Wall-clock-driven
  // and outside the sim — like the away watchdog below.
  const lagDetector = createLagDetector({ onTooMuchLag: disconnectTooMuchLag });
  initDeps({
    runtime,
    initFromServer: sessionHelpers.initFromServer,
    // Adopting a full-state checkpoint (migration / rejoin) sets a fresh
    // simTick + rng cursor; flush the heartbeat history so no comparison spans
    // the discontinuity (a stale pre-adoption entry for the adopted tick would
    // otherwise read as a false desync).
    restoreFullState: (msg) => {
      heartbeat.reset();
      sessionHelpers.restoreFullState(msg);
    },
    showWaitingRoom: sessionHelpers.showWaitingRoom,
    client: defaultClient,
    onStaleStamp: () => lagDetector.recordStaleStamp(timing.now()),
  });

  // Step 4: Subscribe the dispatcher to NetworkApi.onMessage. The WS layer
  // calls deliverIncomingMessage on every received message; this is what
  // routes those calls into handleServerMessage. A loopback test would
  // register the same dispatcher against a different NetworkApi instance.
  network.onMessage(handleServerMessage);

  // Desync detection rides the same incoming-message bus as a second,
  // self-contained subscriber: it acts only on heartbeat messages and ignores
  // everything else, so it needs no hook into handleServerMessage / deps.ts.
  network.onMessage(heartbeat.onMessage);

  document.addEventListener(GAME_EXIT_EVENT, () => {
    runtime.shutdown();
    defaultClient.destroy();
    runtime.runtimeState.lobby.roomSeedDisplay = null;
  });

  // Step 5: away watchdog — a seated peer hidden past AWAY_DISCONNECT_MS
  // abandons its seat cleanly (socket close → server PLAYER_LEFT →
  // lockstep AI takeover for the room) instead of holding every opponent
  // hostage on its idle castle and per-seat phase gates. Short hides are
  // already safe via the lockstep-debt replay (runtime/main-loop.ts);
  // watchers are exempt (nobody waits on them, and their replay is
  // bounded by match length).
  const awayWatchdog = createAwayWatchdog({
    timing,
    isSeatedLiveMatch: () =>
      isSessionLive(runtime.runtimeState) &&
      isActivePlayer(ctx.session.myPlayerId),
    leave: disconnectAway,
    rejoin: rejoinAfterAway,
  });
  createVisibilityListener({
    onChange: (hidden) => awayWatchdog.onVisibilityChange(hidden),
  });
}

async function deliverIncomingMessage(msg: ServerMessage): Promise<void> {
  for (const handler of incomingMessageSubscribers) {
    await handler(msg);
  }
}
