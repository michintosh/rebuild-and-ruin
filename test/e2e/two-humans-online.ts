/**
 * E2E network test: two real human players run a game to the end and must
 * observe the SAME game.
 *
 * Models two humans on two browsers, connected through the real Deno server:
 *   - host  → creates a room, seats itself in slot 0
 *   - client→ joins the room, seats itself in slot 1
 *   - slot 2 is left empty → the lobby fills it with an AI on start
 *
 * Each human plays minimally (see `driveMinimalHuman` in ./online-humans.ts):
 * seat, build poorly, but in battle AIM at the nearest enemy structure and
 * fire, and on a life loss pick CONTINUE or ABANDON at random. They build
 * badly, so the slot-2 AI beats them and the match runs to game-over.
 *
 * Divergence detection + diagnosis, the minimal-human drive, the per-sim-tick
 * recorder and the parity snapshot all live in the shared harness
 * (./online-humans.ts). This file only seats the two peers, runs them, and
 * asserts the end-of-game parity. See three-humans-online.ts for the
 * host-migration sibling.
 *
 * This is the only path that drives REAL human keypresses over a REAL
 * WebSocket / server (the headless parity tests stub the transport and drive an
 * AI brain on the human seat). It is slow and lives outside the pre-commit lane.
 *
 * Run: deno test --no-check -A test/e2e/two-humans-online.ts
 *      (E2E_HEADFUL=1 to watch the two browsers play)
 * Requires: npm run dev (vite on port 5173) AND npm run server (port 8001)
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildSnap,
  driveMinimalHuman,
  dumpTickDivergence,
  firedSlots,
  installTickRecorder,
  monitorDivergence,
  readTickLog,
  type RunControl,
  SLOT_KEYS,
} from "./online-humans.ts";
import { createE2EScenario, GAME_EVENT } from "./scenario.ts";

/** Fixed seed → stable map. The run is NOT bit-reproducible (real keypress
 *  timing is non-deterministic); parity here is cross-PEER, not cross-RUN. */
const SEED = 42;
/** Valid lobby "Battle Length" values are 1/3/5/8/12/Infinity. Three rounds is
 *  enough to cross multiple round boundaries (where parity is asserted) without
 *  the full-length runtime. MUST run non-headless — see ./online-humans.ts. */
const ROUNDS = 3;
/** Non-headless is REQUIRED for parity (headless RAF throttling forks the two
 *  co-hosted sims — see ./online-humans.ts). Not env-overridable: a headless
 *  run would fail with a false divergence, which is a footgun. */
const HEADLESS = false;
/** Wall-clock budget for each peer's minimal-input loop. fastMode is OFF so
 *  phases run at real duration and the human loop has time to inject input. */
const DRIVE_TIMEOUT_MS = 240_000;

// Modern by default — it's the superset: classic's flow PLUS the
// MODIFIER_REVEAL (waited through) and UPGRADE_PICK (driven in
// driveMinimalHuman) phases, whose modifier/upgrade RNG is mirror-simmed on
// every peer, so parity must hold there too.
Deno.test("e2e online: two humans play a full modern game and see the same game", () =>
  runTwoHumansGame("modern"));

async function runTwoHumansGame(mode: "classic" | "modern"): Promise<void> {
  // --- Seat two humans + leave slot 2 for the AI -------------------------
  await using host = await createE2EScenario({
    seed: SEED,
    rounds: ROUNDS,
    mode,
    online: "host",
    humans: 0, // online path seats slots manually below
    headless: HEADLESS,
    fastMode: false, // real-time phases so human input lands
  });
  await host.input.pressKey(SLOT_KEYS[0]); // claim slot 0

  const code = await host.roomCode();

  await using client = await createE2EScenario({
    seed: SEED,
    rounds: ROUNDS,
    mode,
    online: "join",
    roomCode: code,
    humans: 0,
    headless: HEADLESS,
    fastMode: false,
  });
  await client.input.pressKey(SLOT_KEYS[1]); // claim slot 1

  // Install the per-sim-tick recorder on both peers up front (it no-ops until
  // state is ready, so it captures from round 1).
  await installTickRecorder(host);
  await installTickRecorder(client);

  // --- Both humans play minimally + a monitor watches for divergence -----
  const ctrl: RunControl = {
    stop: false,
    divergence: null,
    identities: new Map(),
    cursors: new Map(),
  };
  const peers = [
    { name: "HOST", sc: host },
    { name: "CLIENT", sc: client },
  ] as const;
  const [hostActs, clientActs] = await Promise.all([
    driveMinimalHuman(host, "HOST", DRIVE_TIMEOUT_MS, ctrl),
    driveMinimalHuman(client, "CLIENT", DRIVE_TIMEOUT_MS, ctrl),
    monitorDivergence(peers, ctrl),
  ]);
  console.log(`  HOST actions=${hostActs}, CLIENT actions=${clientActs}`);

  // --- First divergence wins: fail fast with the diverging round ---------
  if (ctrl.divergence) {
    const { round, reason, results } = ctrl.divergence;
    console.log(`  DIVERGENCE at round ${round}: ${reason}`);
    if (results) {
      for (const [name, result] of Object.entries(results)) {
        console.log(`    ${name} round ${round}: ${JSON.stringify(result)}`);
      }
    }
    // Pin the mechanism: align both peers' per-tick logs and dump the first
    // diverging sim-tick + field + a context window around it.
    const [hLog, cLog] = await Promise.all([readTickLog(host), readTickLog(client)]);
    dumpTickDivergence([
      { name: "HOST", log: hLog },
      { name: "CLIENT", log: cLog },
    ]);
    throw new Error(
      `peers diverged at round ${round}: ${reason} — the two humans did not ` +
        `play the same game`,
    );
  }

  // --- No per-round divergence: full end-of-game parity backstop ---------
  assertEquals(await host.mode(), "STOPPED", "host reached game-over");
  assertEquals(await client.mode(), "STOPPED", "client reached game-over");

  // No peer self-disconnected on a desync: the heartbeat (online-heartbeat.ts)
  // fires DESYNC_DETECTED if the host's RNG-cursor fingerprint disagrees with a
  // peer's own cursor at the matching simTick. Over a full real-browser match
  // this is the direct silent-divergence guard.
  assertEquals(
    (await client.bus.events(GAME_EVENT.DESYNC_DETECTED)).length,
    0,
    "client fired a desync disconnect",
  );

  const hSnap = await buildSnap(host);
  const cSnap = await buildSnap(client);
  console.log("  HOST  snap:", JSON.stringify(hSnap));
  console.log("  CLIENT snap:", JSON.stringify(cSnap));

  assert(hSnap.rng !== null, "host rng cursor readable at game-over");
  assertEquals(hSnap.rng, cSnap.rng, "RNG cursors diverged between peers");
  assertEquals(hSnap.round, cSnap.round, "round diverged");
  assertEquals(hSnap.players, cSnap.players, "per-player state diverged");
  assertEquals(hSnap.towerAlive, cSnap.towerAlive, "tower-alive set diverged");
  assertEquals(hSnap.grunts, cSnap.grunts, "grunt positions diverged");
  assertEquals(hSnap.cannonballs, cSnap.cannonballs, "cannonball count diverged");

  // Same outcome + same per-round sequence on both peers' bus logs.
  const hEnd = await host.bus.events(GAME_EVENT.GAME_END);
  const cEnd = await client.bus.events(GAME_EVENT.GAME_END);
  assertEquals(hEnd.length, 1, "host saw exactly one game-end");
  assertEquals(cEnd.length, 1, "client saw exactly one game-end");
  assertEquals(hEnd[0].winner, cEnd[0].winner, "winners diverged between peers");

  // Guard: each human actually acted (test can't pass on idle/unseated peers).
  const hostFired = await firedSlots(host);
  const clientFired = await firedSlots(client);
  assert(hostFired.has(0), "host's human (slot 0) never fired a cannon");
  assert(clientFired.has(1), "client's human (slot 1) never fired a cannon");
}
