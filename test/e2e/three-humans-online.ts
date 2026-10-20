/**
 * E2E network test: THREE real human players, one quits mid-game, and the two
 * survivors must keep playing the SAME game to the end.
 *
 * Models three humans on three browsers, connected through the real Deno server:
 *   - host  → creates a room, seats itself in slot 0
 *   - peer1 → joins, seats itself in slot 1
 *   - peer2 → joins, seats itself in slot 2
 *
 * Partway through the match one peer CLOSES ITS BROWSER (the quit), the same
 * way a real player closing the tab / losing their connection would. WHO quits
 * and WHEN are parameters:
 *   - HOST (slot 0) quits → host migration: the server promotes the lowest-slot
 *     survivor to host, that peer broadcasts a FULL_STATE checkpoint, and every
 *     survivor adopts it (src/online/runtime/promote.ts). Different quit phases
 *     (CANNON_PLACE, BATTLE, WALL_BUILD, UPGRADE_PICK) land in different
 *     promotion-repair branches.
 *   - NON-host (slot 1/2) quits → NO migration: the server parks the seat and
 *     the unchanged host schedules an AI takeover (online-seat-takeover.ts).
 *
 * After the quit the two survivors play on (the quitter's seat becomes AI). The
 * test asserts:
 *   1. host identity is correct — exactly one survivor is host, and it is the
 *      lowest surviving slot (the promoted survivor on a host quit, or the
 *      unchanged slot-0 host on a non-host quit; a broken migration otherwise
 *      only surfaces as a slow game-over timeout);
 *   2. the survivors never diverge — the same N-peer round-boundary monitor as
 *      two-humans-online.ts watches per-slot lives/score every round and stops
 *      at the first disagreement (the quitter is dropped from comparison, not
 *      flagged); and
 *   3. both survivors reach game-over with byte-identical state (rng cursor,
 *      per-slot state, towers, grunts, cannonballs) and agree on the winner.
 *
 * The minimal-human drive, the divergence monitor + per-sim-tick diagnosis, and
 * the parity snapshot all live in the shared harness (./online-humans.ts). Like
 * its two-human sibling it drives REAL keypresses over a REAL WebSocket /
 * server, MUST run non-headless (headless RAF throttling forks the co-hosted
 * sims — see ./online-humans.ts), is slow, and lives outside the pre-commit lane.
 *
 * Run: deno test --no-check -A test/e2e/three-humans-online.ts
 *      (E2E_HEADFUL=1 to watch the three browsers play)
 * Requires: npm run dev (vite on port 5173) AND npm run server (port 8001)
 */

import { assert, assertEquals } from "@std/assert";
import {
  assertCursorActivity,
  buildSnap,
  delay,
  driveMinimalHuman,
  dumpTickDivergence,
  firedSlots,
  installTickRecorder,
  monitorDivergence,
  type PeerHandle,
  readTickLog,
  type RunControl,
  SLOT_KEYS,
} from "./online-humans.ts";
import { createE2EScenario, GAME_EVENT } from "./scenario.ts";

/** When + who quits the match. `phase` is matched against the bridge's `phase`
 *  (the Phase enum string) the first time the quitter is at-or-past `round`. */
interface QuitMoment {
  /** Which peer closes its browser. Slot 0 = the HOST → server migrates (the
   *  lowest-slot survivor is promoted). Slot 1/2 = a NON-host → no migration,
   *  the server just parks the seat and the host schedules an AI takeover. */
  readonly quitterSlot: 0 | 1 | 2;
  readonly round: number;
  /** Matched against the bridge's `phase` (the Phase enum string). Different
   *  phases land in different promotion-repair branches of promote.ts
   *  (battle-intro, round-end fast-forward, cannon-entry prime, upgrade-pick
   *  force-resolve). UPGRADE_PICK requires modern mode + round ≥ 3. */
  readonly phase: "CANNON_PLACE" | "BATTLE" | "WALL_BUILD" | "UPGRADE_PICK";
  /** Battle Length for this scenario (default {@link ROUNDS}). UPGRADE_PICK
   *  needs ≥ 4: the offer is for the NEXT round, so the FINAL round has no
   *  upgrade phase — round 3 only shows UPGRADE_PICK when a round 4 follows. */
  readonly rounds?: number;
}

/** Fixed seed → stable map (parity here is cross-PEER, not cross-RUN). */
const SEED = 42;
/** Three rounds: enough to quit mid-match (round 2) and still run on to
 *  game-over. Valid lobby "Battle Length" value. MUST run non-headless. */
const ROUNDS = 3;
/** Non-headless is REQUIRED for parity — see ./online-humans.ts. */
const HEADLESS = false;
/** Wall-clock budget per peer's input loop. Phases run in real time
 *  (fastMode off), so a full match takes seconds-per-phase × phases × rounds.
 *  The longest case (the rounds:5 UPGRADE_PICK migration) runs ~350–400s of
 *  real time; the budget MUST exceed that or the drivers stop feeding input
 *  mid-match and the still-alive human seats sit frozen for the rest of the
 *  game (a harness artifact that reads as "a player can't play round 4/5",
 *  NOT a game bug). 600s leaves headroom; drivers exit early via ctrl.stop at
 *  game-over, so the extra budget only matters when a match overruns. */
const DRIVE_TIMEOUT_MS = 600_000;
/** Quit-watcher poll interval. */
const QUIT_POLL_MS = 150;

// HOST (slot 0) quits — the host-migration cases. Each phase lands in a
// different promotion-repair branch of promote.ts (battle-intro skip,
// round-end fast-forward, cannon-entry prime, upgrade-pick mode restore).
Deno.test("e2e online: host quits mid-BATTLE, two survivors finish in sync (migration)", () =>
  runThreeHumansGame("modern", { quitterSlot: 0, round: 2, phase: "BATTLE" }));

Deno.test("e2e online: host quits mid-WALL_BUILD, two survivors finish in sync (migration)", () =>
  runThreeHumansGame("modern", { quitterSlot: 0, round: 2, phase: "WALL_BUILD" }));

Deno.test("e2e online: host quits mid-CANNON_PLACE, two survivors finish in sync (migration)", () =>
  runThreeHumansGame("modern", { quitterSlot: 0, round: 2, phase: "CANNON_PLACE" }));

// Modern only: UPGRADE_PICK exists from round 3. Exercises promote.ts's
// upgrade-pick mode restore: the phase is self-driving (tickUpgradePickPhase
// re-derives the exit each frame), so a promotion that lands here must keep
// ticking it forward rather than hang the match.
Deno.test("e2e online: host quits mid-UPGRADE_PICK, two survivors finish in sync (migration)", () =>
  runThreeHumansGame("modern", { quitterSlot: 0, round: 3, phase: "UPGRADE_PICK", rounds: 5 }));

// NON-host (slot 2 / Gold) quits — no migration; the seat is parked and the
// host schedules an AI takeover (online-seat-takeover.ts). The two survivors,
// INCLUDING the unchanged host, must finish in sync.
Deno.test("e2e online: non-host (slot 2) quits mid-BATTLE — AI takeover, no migration", () =>
  runThreeHumansGame("modern", { quitterSlot: 2, round: 2, phase: "BATTLE" }));

async function runThreeHumansGame(
  mode: "classic" | "modern",
  quit: QuitMoment,
): Promise<void> {
  const rounds = quit.rounds ?? ROUNDS;
  // --- Seat three humans -------------------------------------------------
  await using host = await createE2EScenario({
    seed: SEED,
    rounds,
    mode,
    online: "host",
    humans: 0, // online path seats slots manually below
    headless: HEADLESS,
    fastMode: false, // real-time phases so human input lands
  });
  await host.input.pressKey(SLOT_KEYS[0]); // claim slot 0

  const code = await host.roomCode();

  // Launch both joining peers CONCURRENTLY. Sequential creation stacked two
  // non-headless browser launches inside the host's wait window — the second
  // peer routinely missed it. Parallel launch ~halves the join latency.
  const joins = await Promise.all([
    createE2EScenario({
      seed: SEED,
      rounds,
      mode,
      online: "join",
      roomCode: code,
      humans: 0,
      headless: HEADLESS,
      fastMode: false,
    }),
    createE2EScenario({
      seed: SEED,
      rounds,
      mode,
      online: "join",
      roomCode: code,
      humans: 0,
      headless: HEADLESS,
      fastMode: false,
    }),
  ]);
  await using peer1 = joins[0]!;
  await using peer2 = joins[1]!;
  await peer1.input.pressKey(SLOT_KEYS[1]); // claim slot 1
  await peer2.input.pressKey(SLOT_KEYS[2]); // claim slot 2

  const peers: readonly PeerHandle[] = [
    { name: "HOST", sc: host },
    { name: "PEER1", sc: peer1 },
    { name: "PEER2", sc: peer2 },
  ];
  const quitter = peers[quit.quitterSlot]!;
  const survivors = peers.filter((peer) => peer !== quitter);

  // Per-sim-tick recorder on every peer (no-ops until state is ready).
  await Promise.all(peers.map(({ sc }) => installTickRecorder(sc)));

  // --- Drive all three + monitor divergence + trigger the quit -----------
  // The quitter's drive is wrapped so the in-flight keypress that races the
  // page-close resolves cleanly instead of rejecting the whole Promise.all.
  const ctrl: RunControl = {
    stop: false,
    divergence: null,
    identities: new Map(),
    cursors: new Map(),
  };
  // Always CONTINUE on a life loss: random abandons would routinely end a
  // 3-human match in round 1, before the quitter reaches its mid-game quit
  // moment. The quit (a closed socket) is the disconnection event under test
  // here; abandon-coverage lives in two-humans-online.ts.
  const drives = peers.map(({ name, sc }) => {
    const loop = driveMinimalHuman(sc, name, DRIVE_TIMEOUT_MS, ctrl, {
      lifeLost: "continue",
    });
    return name === quitter.name ? ignoreClosed(loop) : loop;
  });
  const actions = await Promise.all([
    ...drives,
    monitorDivergence(peers, ctrl),
    quitAtMoment(quitter, quit, ctrl),
  ]);
  console.log(
    `  actions: ${peers.map((peer, idx) => `${peer.name}=${actions[idx]}`).join(", ")}`,
  );

  // --- First divergence wins: fail fast with diagnosis -------------------
  if (ctrl.divergence) {
    const { round, reason, results } = ctrl.divergence;
    console.log(`  DIVERGENCE at round ${round}: ${reason}`);
    if (results) {
      for (const [name, result] of Object.entries(results)) {
        console.log(`    ${name} round ${round}: ${JSON.stringify(result)}`);
      }
    }
    const logs = await Promise.all(
      peers.map(async ({ name, sc }) => ({ name, log: await readTickLog(sc) })),
    );
    dumpTickDivergence(logs);
    throw new Error(
      `survivors diverged at round ${round}: ${reason} — the quit forked the game`,
    );
  }

  // --- The quitter is gone; the survivors carry the match ----------------
  assert(quitter.sc.page.isClosed(), `${quitter.name} should have quit`);

  // Capture everything needed from the LIVE survivors in one parallel batch,
  // then CLOSE their browsers immediately — the game is over and the test ends
  // here. Every assertion below runs on this captured plain data, so nothing
  // reads (or lets the user watch) a lingering game-over screen. Identities come
  // from the monitor's live capture (ctrl.identities), not a post-game read —
  // see RunControl.identities (teardown resets the slot to -1).
  const captured = await Promise.all(
    survivors.map(async (peer) => {
      const identity = ctrl.identities.get(peer.name);
      assert(identity, `${peer.name} identity was never captured live`);
      return {
        name: peer.name,
        identity,
        mode: await peer.sc.mode(),
        snap: await buildSnap(peer.sc),
        ends: await peer.sc.bus.events(GAME_EVENT.GAME_END),
        desyncs: await peer.sc.bus.events(GAME_EVENT.DESYNC_DETECTED),
        fired: await firedSlots(peer.sc),
      };
    }),
  );
  await Promise.all(survivors.map((peer) => peer.sc.page.close().catch(() => {})));

  // 1. Exactly one survivor is host, and it is the lowest-slot survivor. When
  //    the HOST quit, the server promoted the lowest-slot survivor (migration);
  //    when a NON-host quit, the original host (slot 0) survived and stays host
  //    (no migration — just an AI seat-takeover of the quitter's slot). Either
  //    way the host is the lowest surviving slot, computed statically from who
  //    quit (stronger than re-deriving it from the captured identities).
  const survivorSlots = ([0, 1, 2] as const).filter((slot) => slot !== quit.quitterSlot);
  const expectedHostSlot = Math.min(...survivorSlots);
  const hostsAmong = captured.filter((cap) => cap.identity.amHost);
  assertEquals(
    hostsAmong.length,
    1,
    `exactly one survivor should be host (got ${hostsAmong.length})`,
  );
  assertEquals(
    hostsAmong[0]!.identity.myPlayerId,
    expectedHostSlot,
    quit.quitterSlot === 0
      ? "host migration should promote the lowest-slot survivor"
      : "a non-host quit should NOT migrate the host (slot 0 stays host)",
  );

  // 2. Both survivors reached game-over.
  for (const cap of captured) {
    assertEquals(cap.mode, "STOPPED", `${cap.name} reached game-over`);
  }

  // 2b. No survivor self-disconnected on a desync: the heartbeat
  //     (online-heartbeat.ts) compares the host's RNG-cursor fingerprint
  //     against each peer's own cursor at the matching simTick and fires
  //     DESYNC_DETECTED on a fork. Over a full real-browser match this is the
  //     direct silent-divergence guard — a mid-game fork that the end-state
  //     parity checks below might not localize surfaces here as a clear event.
  for (const cap of captured) {
    assertEquals(
      cap.desyncs.length,
      0,
      `${cap.name} fired a desync disconnect: ${JSON.stringify(cap.desyncs)}`,
    );
  }

  // 3. Byte-identical end-of-game state across the survivors.
  for (const cap of captured) console.log(`  ${cap.name} snap:`, JSON.stringify(cap.snap));
  const ref = captured[0]!;
  assert(ref.snap.rng !== null, `${ref.name} rng cursor readable at game-over`);
  for (const cap of captured.slice(1)) {
    assertEquals(cap.snap.rng, ref.snap.rng, `RNG cursor diverged: ${ref.name} vs ${cap.name}`);
    assertEquals(cap.snap.round, ref.snap.round, `round diverged: ${ref.name} vs ${cap.name}`);
    assertEquals(cap.snap.players, ref.snap.players, `per-player state diverged: ${ref.name} vs ${cap.name}`);
    assertEquals(cap.snap.towerAlive, ref.snap.towerAlive, `tower-alive diverged: ${ref.name} vs ${cap.name}`);
    assertEquals(cap.snap.grunts, ref.snap.grunts, `grunts diverged: ${ref.name} vs ${cap.name}`);
    assertEquals(cap.snap.cannonballs, ref.snap.cannonballs, `cannonballs diverged: ${ref.name} vs ${cap.name}`);
  }

  // 4. Every peer emits GAME_END exactly once, at the single finalizeGameOver
  //    chokepoint: the new host via its local game-over dispatch, a watcher via
  //    the wire GAME_OVER (which now reaches the chokepoint too). So BOTH
  //    survivors see exactly one and agree on the winner. This guards the
  //    watcher-GAME_END fix (game-lifecycle.ts:finalizeGameOver) — before it, a
  //    watcher whose local round-end was preempted by the wire GAME_OVER saw 0
  //    on the round-exhaustion game-over path.
  for (const cap of captured) {
    assertEquals(cap.ends.length, 1, `${cap.name} saw exactly one game-end`);
  }
  const refWinner = ref.ends[0]!.winner;
  for (const cap of captured.slice(1)) {
    assertEquals(cap.ends[0]!.winner, refWinner, `winner diverged: ${ref.name} vs ${cap.name}`);
  }

  // 5. Guard: each surviving human actually acted before the end (slot from the
  //    live-captured identity — a post-game read would be the spectator slot).
  for (const cap of captured) {
    const slot = cap.identity.myPlayerId;
    assert(cap.fired.has(slot), `${cap.name} (slot ${slot}) never fired a cannon`);
  }

  // 6. Each survivor MOVED its cursor in every round it was alive (it was
  //    actually playing, not stuck — the round-grained check catches a stall at
  //    a specific round, e.g. an alive player that stops building mid-game), and
  //    did NOT move its cursor while dead (the eliminated-spectator gate held).
  assertCursorActivity(ctrl, survivors.map((peer) => peer.name));
}

/** Poll the quitter until it is at-or-past the target round in the target phase,
 *  then CLOSE its page (the quit). Returns 1 once it has quit, 0 if the game
 *  ended first or the monitor stopped the run. */
async function quitAtMoment(
  quitter: PeerHandle,
  quit: QuitMoment,
  ctrl: RunControl,
): Promise<number> {
  const { name, sc } = quitter;
  while (!ctrl.stop) {
    await delay(QUIT_POLL_MS);
    if (sc.page.isClosed()) return 0;
    let st: { round: number; phase: string; mode: string };
    try {
      st = await sc.page.evaluate(() => {
        const e2e = (globalThis as unknown as Record<string, unknown>)
          .__e2e as Record<string, unknown> | undefined;
        return {
          round: (e2e?.round as number) ?? 0,
          phase: (e2e?.phase as string) ?? "",
          mode: (e2e?.mode as string) ?? "",
        };
      });
    } catch {
      continue; // page mid-navigation — retry
    }
    if (st.mode === "STOPPED") return 0; // game ended before the quit moment
    if (st.round >= quit.round && st.phase === quit.phase) {
      console.log(`  QUIT: ${name} leaving at round ${st.round} phase ${st.phase}`);
      await sc.page.close().catch(() => {});
      return 1;
    }
  }
  return 0;
}

/** Swallow the "target/page closed" rejection a drive loop throws when its peer
 *  quits mid-keypress; re-throw anything else. Resolves to 0 actions. */
function ignoreClosed(promise: Promise<number>): Promise<number> {
  return promise.catch((err: unknown) => {
    const msg = String((err as { message?: string })?.message ?? err);
    if (msg.includes("closed") || msg.includes("Target")) return 0;
    throw err;
  });
}
