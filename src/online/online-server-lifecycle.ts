/**
 * Server lifecycle message handlers — room join, slot selection, phase transitions.
 *
 * NOTE: session.isHost is VOLATILE (can flip during host promotion).
 * All reads go through isHostInContext() from tick-context.ts (enforced by ESLint).
 * The host-check guards on phase-transition cases ensure that only watchers
 * apply host-sent checkpoints — the host computes its own. */

import {
  DEFAULT_PLAYER_COUNT,
  type FullStateMessage,
  type InitMessage,
  MESSAGE,
  type RoomSettings,
  type ServerMessage,
} from "../protocol/protocol.ts";
import { isHostInContext } from "../runtime/tick-context.ts";
import {
  GAME_MODE_MODERN,
  type GameMode,
} from "../shared/core/game-constants.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { GameState } from "../shared/core/types.ts";
import type { OnlineSession } from "./online-session.ts";

export interface HandleServerLifecycleDeps {
  log: (msg: string) => void;

  session: Pick<
    OnlineSession,
    | "isHost"
    | "myPlayerId"
    | "hostMigrationSeq"
    | "roomWaitTimerSec"
    | "roomMaxRounds"
    | "roomCannonMaxHp"
    | "roomGameMode"
    | "roomPlayerCount"
    | "lobbyStartTime"
    | "occupiedSlots"
    | "remotePlayerSlots"
    | "pendingSeatTakeovers"
    | "pendingResyncRequests"
    | "myRejoinToken"
  >;

  /** Lockstep seat-takeover hooks (see online-seat-takeover.ts). Mid-game
   *  PLAYER_LEFT must NOT flip the slot sets at wall-clock receipt — the
   *  flip rides the action schedule so it lands at the same tick on every
   *  peer. */
  takeover: {
    /** True while a live game session ticks (sim ticks + schedule
     *  drains run). Outside one there is no lockstep clock to defer to —
     *  PLAYER_LEFT clears the seat immediately, as it always did. */
    isGameLive: () => boolean;
    /** Host at PLAYER_LEFT receipt: stamp `simTick + SAFETY`, schedule
     *  the flip locally, broadcast SEAT_TAKEOVER. */
    beginAsHost: (playerId: ValidPlayerId) => void;
    /** Watcher at SEAT_TAKEOVER receipt: schedule the host-stamped flip. */
    schedule: (playerId: ValidPlayerId, applyAt: number) => void;
  };

  /** Lockstep seat-RECLAIM hooks — the give-back inverse of `takeover`
   *  (see online-seat-reclaim.ts + online-rejoin.ts). Wired into production by
   *  step 3c-2: a tab-return REJOIN_ROOM leads the rejoiner to send
   *  REQUEST_SEAT_RECLAIM, and the host stamps a SEAT_RECLAIM in response. */
  reclaim: {
    /** Watcher + the returning owner at SEAT_RECLAIM receipt: schedule the
     *  host-stamped flip (the owner additionally swaps AI→human on apply). */
    schedule: (playerId: ValidPlayerId, applyAt: number) => void;
    /** Host at a forwarded REQUEST_SEAT_RECLAIM: validate the seat is
     *  AI-held + owner alive, stamp `simTick + SAFETY`, schedule locally,
     *  broadcast SEAT_RECLAIM. No-op when ineligible. */
    onReclaimRequest: (playerId: ValidPlayerId) => void;
    /** Host at REQUEST_RESYNC: park a deferred ROOM-WIDE resync (a no-op
     *  self-migration) at `requestTick + SAFETY`; see online-resync-defer.ts. */
    onResyncRequest: (forPlayerId: ValidPlayerId) => void;
  };

  /** Rejoiner adoption of the host's first ROOM-WIDE resync broadcast (a no-op
   *  self-migration). Uses the SAME migration `restoreFullState` path
   *  (`applyFullStateToRunningRuntime`) as every other peer — the rejoiner's
   *  seat was already rebuilt as AI by the spectator-boot INIT replay — then
   *  requests the seat give-back. */
  rejoin: {
    isAwaitingResync: () => boolean;
    adoptResync: (msg: FullStateMessage) => Promise<void>;
    /** Roll back an in-flight rejoin the server rejected via ROOM_ERROR
     *  (expired token / room ended / seat still live-held): restore the
     *  stashed seat identity + disarm the resync-adopt routing. No-op
     *  (guarded) when not mid-rejoin. */
    abort: () => void;
  };

  lobby: {
    showWaitingRoom: (code: string, seed: number) => void;
    joined: boolean[];
  };

  ui: {
    setAnnouncement: (msg: string) => void;
    createErrorEl: HTMLElement;
    joinErrorEl: HTMLElement;
  };

  game: {
    getState: () => GameState | undefined;
    /** True once this peer finalized the match locally (Mode.STOPPED,
     *  game-over screen). Specifically STOPPED — NOT `!isGameplayMode`:
     *  the OPTIONS/CONTROLS overlays pause ticking too, but a peer
     *  sitting in a menu mid-game must still adopt a migration
     *  FULL_STATE. */
    isStopped: () => boolean;
    initFromServer: (msg: InitMessage) => Promise<void>;
  };

  transitions: {
    /** GAME_OVER carries the host's authoritative scores; other peers
     *  paint the terminal frame from the wire payload. Other phase-marker
     *  messages (CANNON_START / BATTLE_START / BUILD_START / BUILD_END)
     *  are ignored: every peer runs the same phase ticks locally and
     *  dispatches the matching transition from its own tick. */
    onGameOver: (msg: ServerMessage) => void;
  };

  migration: {
    playerNames: readonly string[];
    /** Synchronous by design: no async window between HOST_LEFT receipt
     *  and the FULL_STATE broadcast (controllers are kept, not rebuilt). */
    promoteToHost: () => void;
    restoreFullState: (msg: FullStateMessage) => void;
  };
}

export async function handleServerLifecycleMessage(
  msg: ServerMessage,
  deps: HandleServerLifecycleDeps,
): Promise<boolean> {
  /** Atomically update all three slot-tracking structures (clear).
   *  Invariant: occupiedSlots, remotePlayerSlots, and lobby.joined must always
   *  be mutated together to avoid phantom entries or orphaned lobby data. */
  const clearLobbySlot = (playerId: ValidPlayerId) => {
    deps.lobby.joined[playerId] = false;
    deps.session.occupiedSlots.delete(playerId);
    deps.session.remotePlayerSlots.delete(playerId);
  };

  /** Atomically update all three slot-tracking structures (occupy).
   *  Invariant: occupiedSlots, remotePlayerSlots, and lobby.joined must always
   *  be mutated together to avoid phantom entries or orphaned lobby data. */
  const occupyLobbySlot = (playerId: ValidPlayerId) => {
    deps.lobby.joined[playerId] = true;
    deps.session.occupiedSlots.add(playerId);
    if (playerId !== deps.session.myPlayerId) {
      deps.session.remotePlayerSlots.add(playerId);
    } else {
      deps.session.remotePlayerSlots.delete(playerId);
    }
  };

  switch (msg.type) {
    case MESSAGE.ROOM_CREATED:
      applyRoomSettings(deps.session, msg.settings);
      deps.lobby.showWaitingRoom(msg.code, msg.seed);
      return true;

    case MESSAGE.ROOM_JOINED:
      applyRoomSettings(deps.session, msg.settings);
      deps.lobby.showWaitingRoom(msg.code, msg.seed);
      deps.session.lobbyStartTime = performance.now() - msg.elapsedSec * 1000;
      for (const player of msg.players) {
        occupyLobbySlot(player.playerId);
      }
      return true;

    case MESSAGE.JOINED:
      if (
        msg.previousPlayerId !== undefined &&
        msg.previousPlayerId !== msg.playerId
      ) {
        clearLobbySlot(msg.previousPlayerId);
      } else {
        const currentPlayerId = deps.session.myPlayerId;
        if (currentPlayerId >= 0 && currentPlayerId !== msg.playerId) {
          clearLobbySlot(currentPlayerId as ValidPlayerId);
        }
      }
      deps.session.myPlayerId = msg.playerId;
      // Persist this seat's rejoin token (survives a tab-hide) for a later
      // away-disconnect → rejoinRoom. Absent on older servers → keep any
      // prior token rather than nulling it.
      if (msg.rejoinToken !== undefined) {
        deps.session.myRejoinToken = msg.rejoinToken;
      }
      occupyLobbySlot(msg.playerId);
      return true;

    case MESSAGE.PLAYER_JOINED:
      if (
        msg.previousPlayerId !== undefined &&
        msg.previousPlayerId !== msg.playerId
      ) {
        clearLobbySlot(msg.previousPlayerId);
      }
      occupyLobbySlot(msg.playerId);
      return true;

    case MESSAGE.PLAYER_LEFT: {
      const name =
        deps.migration.playerNames[msg.playerId] ??
        `Player ${msg.playerId + 1}`;
      // Drop any host-side resync parked for this slot: a rejoiner that left
      // again must not trigger a needless room-wide rebroadcast. No-op on
      // non-host peers (their map is empty).
      deps.session.pendingResyncRequests.delete(msg.playerId);
      if (
        deps.takeover.isGameLive() &&
        deps.session.remotePlayerSlots.has(msg.playerId)
      ) {
        // Mid-game: park the seat; the slot-set triple flips inside the
        // lockstep seat-takeover apply, never at wall-clock receipt —
        // see online-seat-takeover.ts. The has() guard keeps a late
        // duplicate from clobbering an already-stamped tick. The
        // departing HOST's seat parks here too: no live host will stamp
        // it now, so the promoted host re-issues it right after its
        // FULL_STATE broadcast (promote.ts) — until then the seat counts
        // as remote on every peer alike.
        if (!deps.session.pendingSeatTakeovers.has(msg.playerId)) {
          deps.session.pendingSeatTakeovers.set(msg.playerId, null);
        }
        if (isHostInContext(deps.session)) {
          deps.takeover.beginAsHost(msg.playerId);
        }
      } else {
        // Lobby / post-game / duplicate — no lockstep clock to race.
        clearLobbySlot(msg.playerId);
        deps.session.pendingSeatTakeovers.delete(msg.playerId);
      }
      deps.ui.setAnnouncement(`${name} disconnected`);
      deps.log(`player_left: ${name} (pid=${msg.playerId})`);
      return true;
    }

    case MESSAGE.SEAT_TAKEOVER: {
      // Host-originated; the relay never echoes to the sender, but the
      // guard keeps a stray self-copy from double-stamping.
      if (isHostInContext(deps.session)) return true;
      if (!deps.takeover.isGameLive()) {
        clearLobbySlot(msg.playerId);
        deps.session.pendingSeatTakeovers.delete(msg.playerId);
        return true;
      }
      deps.takeover.schedule(msg.playerId, msg.applyAt);
      deps.log(
        `seat_takeover scheduled: P${msg.playerId} applyAt=${msg.applyAt}`,
      );
      return true;
    }

    case MESSAGE.SEAT_RECLAIM: {
      // Host-originated broadcast; the relay never echoes to the sender, but
      // the guard keeps a stray self-copy from double-scheduling on the host.
      if (isHostInContext(deps.session)) return true;
      if (!deps.takeover.isGameLive()) return true;
      deps.reclaim.schedule(msg.playerId, msg.applyAt);
      deps.log(
        `seat_reclaim scheduled: P${msg.playerId} applyAt=${msg.applyAt}`,
      );
      return true;
    }

    case MESSAGE.REQUEST_SEAT_RECLAIM:
      // Server→host only: a rejoined peer asks for its seat back. The host is
      // the sole decider (validates seat AI-held + owner alive, then stamps +
      // broadcasts SEAT_RECLAIM). Non-host receipt is a no-op.
      if (isHostInContext(deps.session)) {
        deps.reclaim.onReclaimRequest(msg.playerId);
      }
      return true;

    case MESSAGE.REQUEST_RESYNC:
      // Server→host only: a freshly-rejoined peer needs the current state. The
      // host answers with a deferred ROOM-WIDE rebroadcast (a no-op
      // self-migration; see online-resync-defer.ts), not a targeted snapshot.
      if (isHostInContext(deps.session)) {
        deps.reclaim.onResyncRequest(msg.forPlayerId);
      }
      return true;

    case MESSAGE.ROOM_ERROR:
      deps.ui.createErrorEl.textContent = msg.message;
      deps.ui.joinErrorEl.textContent = msg.message;
      // A ROOM_ERROR mid-rejoin means the server rejected the rejoin (expired
      // token / room ended / seat still live-held): roll it back so the seat
      // identity is restored and a later FULL_STATE isn't misrouted through
      // the resync-adopt path. Guarded no-op for a plain lobby join error.
      deps.rejoin.abort();
      return true;

    case MESSAGE.INIT:
      // Seats parked for a lockstep takeover that never fired (the match
      // ended inside the SAFETY window, where peers' STOPPED instants
      // differ) must not leak into this match's occupiedSlots —
      // bootstrap identity draws are a cross-peer contract derived from
      // it. Flush them as plain leaves before booting.
      for (const playerId of deps.session.pendingSeatTakeovers.keys()) {
        clearLobbySlot(playerId);
      }
      deps.session.pendingSeatTakeovers.clear();
      await deps.game.initFromServer(msg);
      return true;

    case MESSAGE.SELECT_START:
    case MESSAGE.CANNON_START:
    case MESSAGE.BATTLE_START:
    case MESSAGE.BUILD_START:
    case MESSAGE.BUILD_END:
      // Phase-marker messages — clone-everywhere model means every peer
      // dispatches the matching transition locally from its own tick.
      // Acknowledge receipt (`return true`) so the wire stays free of
      // unhandled-message warnings.
      //
      // SELECT_START specifically must NOT re-enter tower selection here:
      // every peer that receives it (seated client or spectator) already
      // entered the round-1 initial cycle locally from `initFromServer`'s
      // `bootstrapGame` → `enterSelection` (the host enters the same way and
      // never sees its own SELECT_START). Re-entering on receipt ran the AI's
      // `selectTower` a SECOND time on joiners, double-drawing the shared
      // `state.rng` (one extra AI castle selection) and desyncing every
      // joiner's mirror sim from tick 0. The host still SENDS SELECT_START so
      // the server can track the phase (server/game-room.ts) for spectator
      // boots; it is purely a phase marker on the wire, like the four below.
      //
      // Deliberately NO dialog cleanup here. A marker landing while this
      // peer's life-lost / upgrade-pick dialog is open just means our sim
      // lags the host's — the dialog is a live lockstep construct, not a
      // stale one, and our own ticks resolve it through the same path the
      // host took (scheduled lockstep choice, or the owner-routed
      // max-timer force with the DIALOG_FORCE_GRACE non-owner backstop —
      // see dialogs/dialog-tick.ts). Both windows are self-driving phases
      // (ROUND_END's life-lost beat, UPGRADE_PICK) whose tick rebuilds and
      // drives the dialog from state each frame. Wire-clearing it would
      // discard the in-progress choices/picks this peer has already
      // recorded — which the payload-less marker can't restore — and the
      // self-driving rebuild would restart them, desyncing the resolution
      // (and thus the phase exit) tick across peers.
      return true;

    case MESSAGE.GAME_OVER:
      if (!isHostInContext(deps.session)) deps.transitions.onGameOver(msg);
      return true;

    case MESSAGE.HOST_LEFT: {
      deps.log(
        `host_left: new host is P${msg.newHostPlayerId} (previous: P${msg.disconnectedPlayerId})`,
      );
      deps.session.hostMigrationSeq++;
      if (msg.newHostPlayerId === deps.session.myPlayerId) {
        deps.migration.promoteToHost();
        deps.ui.setAnnouncement("You are now the host");
      } else {
        const name =
          (msg.newHostPlayerId !== null
            ? deps.migration.playerNames[msg.newHostPlayerId]
            : undefined) ?? "a watcher";
        deps.ui.setAnnouncement(`Host migrated to ${name}`);
      }
      return true;
    }

    case MESSAGE.FULL_STATE:
      if (deps.rejoin.isAwaitingResync()) {
        // First resync after a rejoin: this is the host's ROOM-WIDE rebroadcast
        // (a no-op self-migration). Adopt it through the migration path, keeping
        // the spectator-boot AI controllers, and request the give-back. Taken
        // here — consuming `awaitingRejoinResync` — so the rejoiner's first
        // resync isn't filtered by the migration-seq dedup gate below while its
        // own seq bookkeeping is still catching up.
        await deps.rejoin.adoptResync(msg);
        return true;
      }
      if (!isHostInContext(deps.session) && deps.game.getState()) {
        // Finished peers stay finished. A game-over-straddling migration
        // (old host dies during the final ROUND_END window) can have a
        // slower promoted host broadcast a mid-ROUND_END FULL_STATE after
        // this peer already finalized game-over locally. Adopting it would
        // flip this peer back into a gameplay mode, replay the round-end
        // exit, and re-emit GAME_END. The promoted host reaches the same
        // outcome deterministically and its authoritative wire GAME_OVER
        // still repaints this peer's terminal frame (handleGameOverTransition
        // has no such guard). Mirrors the sender-side finished-peer guard
        // in promote.ts.
        if (deps.game.isStopped()) {
          deps.log("ignored full_state after local game-over");
          return true;
        }
        const incomingSeq = msg.migrationSeq ?? 0;
        if (incomingSeq < deps.session.hostMigrationSeq) {
          deps.log(
            `ignored stale full_state in lifecycle (seq=${incomingSeq})`,
          );
          return true;
        }
        if (incomingSeq > deps.session.hostMigrationSeq) {
          deps.session.hostMigrationSeq = incomingSeq;
        }
        deps.migration.restoreFullState(msg);
        deps.log("applied full_state from new host");
      }
      return true;

    default:
      return false;
  }
}

/** Copy room settings from a ROOM_CREATED / ROOM_JOINED payload onto the
 *  session. Both messages carry the same `RoomSettings` shape and arrive at
 *  the same point in the lobby flow, so this guarantees they stay in sync. */
function applyRoomSettings(
  session: HandleServerLifecycleDeps["session"],
  settings: RoomSettings,
): void {
  session.roomWaitTimerSec = settings.waitTimerSec;
  session.roomMaxRounds = settings.maxRounds;
  session.roomCannonMaxHp = settings.cannonMaxHp;
  session.roomGameMode =
    (settings.gameMode as GameMode | undefined) ?? GAME_MODE_MODERN;
  session.roomPlayerCount = settings.playerCount ?? DEFAULT_PLAYER_COUNT;
}
