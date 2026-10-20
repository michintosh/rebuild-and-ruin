/**
 * Lockstep scheduled-actions queue. Wire-broadcast inputs enqueue on
 * originator + receiver with `applyAt = senderSimTick + SAFETY` and fire in
 * `(applyAt, playerId)` order on every peer. Replaces "apply-now, broadcast,
 * apply-on-receipt" — that pattern let order-sensitive logic
 * (recheckTerritory → grunt RNG) diverge when the receiver applied later.
 */

import type { ValidPlayerId } from "./player-slot.ts";

export interface ScheduledAction<S> {
  /** Logical sim tick at which this action fires. Both originator and
   *  receiver schedule with the same `applyAt` so they fire in lockstep. */
  applyAt: number;
  /** Within-tick ordering tiebreaker. Conventionally the player slot id
   *  whose input produced this action — guarantees a total order across
   *  peers regardless of wire arrival order. */
  playerId: ValidPlayerId;
  /** Mutates state. Called exactly once when the action fires. */
  apply: (state: S) => void;
}

export interface ActionSchedule<S> {
  /** Enqueue an action. Order of enqueue is irrelevant — the drain sort
   *  ensures deterministic apply order. */
  schedule: (action: ScheduledAction<S>) => void;
  /** Apply every queued action whose `applyAt <= simTick`, in
   *  `(applyAt, playerId)` order. */
  drainUpTo: (simTick: number, state: S) => void;
  /** Drop queued actions with `applyAt <= simTick` WITHOUT applying them.
   *  Host-migration adoption: entries at or before the adopted snapshot's
   *  tick are already baked into the snapshot (the promoting host drains
   *  its queue right before serializing), so re-applying them would
   *  double-fire; entries after it are still-valid lockstep actions every
   *  peer — the new host included — drains at the same adopted tick, so a
   *  blanket `reset` would drop them on adopters only. */
  discardUpTo: (simTick: number) => void;
  /** Pending count. Test-only; production code should not branch on this. */
  size: () => number;
  /** Drop all queued actions (e.g. on rematch / returnToLobby). */
  reset: () => void;
}

/** Originator-side lockstep wiring shared by every wrapper that stamps and
 *  broadcasts board actions (the online send-actions bag, the assisted-human
 *  commit port). */
export interface LockstepOriginatorDeps<S> {
  /** Lockstep queue. The originator enqueues with the same applyAt it
   *  broadcasts, so it applies in lockstep with receivers. */
  schedule: (action: ScheduledAction<S>) => void;
  /** Buffer depth in sim ticks. `applyAt = simTick + safetyTicks`. */
  safetyTicks: number;
  /** True while this peer is fast-forward replaying banked lockstep debt
   *  beyond LOCKSTEP_QUARANTINE_DEBT_TICKS (returning from a hidden tab).
   *  Board actions are dropped during the replay: a fresh fire pins its
   *  trajectory and pending-fire keys into the replayed timeline — state
   *  no other peer has — and any stamp this far behind would land in the
   *  other peers' past. The input is treated as if the player were still
   *  away; the quarantine lifts within a few catch-up frames. */
  isQuarantined: () => boolean;
}

/** Lockstep buffer depth in sim ticks. Must exceed the worst-case
 *  cross-peer wire latency. At 60Hz sim this absorbs ~500ms of jitter,
 *  enough for WAN WebSocket paths through a reverse proxy. Also the local
 *  input delay: board actions apply this many ticks after the click.
 *  Hardcoded — every originator stamps with this same constant, so all
 *  peers must run the same value. */
export const DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS = 30;
/** Lockstep debt (owed catch-up ticks) above which a peer must stop
 *  originating board actions (piece / cannon / fire). Half the safety
 *  window: below this, an un-corrected stamp still lands in every other
 *  peer's future; at or above it, the peer is fast-forward replaying a
 *  timeline the room already played, and a fresh fire would mutate
 *  schedule-time state (trajectory pin, pending-fire keys) that no other
 *  peer has — the input is dropped instead, exactly as if the player had
 *  stayed hidden those extra milliseconds. Dialog and selection commits
 *  are NOT quarantined: other peers' phase flow waits on them, so they
 *  ride out with a debt-corrected stamp instead (`lockstepStampTick`,
 *  injected as a `stampTick` closure where layering forbids the direct
 *  call). */
export const LOCKSTEP_QUARANTINE_DEBT_TICKS =
  DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS / 2;

export function createActionSchedule<S>(): ActionSchedule<S> {
  const queue: ScheduledAction<S>[] = [];

  return {
    schedule(action) {
      queue.push(action);
    },
    drainUpTo(simTick, state) {
      if (queue.length === 0) return;
      queue.sort((a, b) =>
        a.applyAt !== b.applyAt
          ? a.applyAt - b.applyAt
          : a.playerId - b.playerId,
      );
      let drained = 0;
      while (drained < queue.length && queue[drained]!.applyAt <= simTick) {
        queue[drained]!.apply(state);
        drained++;
      }
      if (drained > 0) queue.splice(0, drained);
    },
    discardUpTo(simTick) {
      for (let idx = queue.length - 1; idx >= 0; idx--) {
        if (queue[idx]!.applyAt <= simTick) queue.splice(idx, 1);
      }
    },
    size() {
      return queue.length;
    },
    reset() {
      queue.length = 0;
    },
  };
}
