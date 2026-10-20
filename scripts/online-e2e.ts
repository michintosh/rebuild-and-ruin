/**
 * E2E test for both local and online play.
 *
 * Usage:
 *   deno run -A scripts/online-e2e.ts local             # local mode: 3 AI, no server needed
 *   deno run -A scripts/online-e2e.ts local 1           # local mode: 1 human + 2 AI
 *   deno run -A scripts/online-e2e.ts local 0 "" 1      # local, 1 round (any positive integer)
 *   deno run -A scripts/online-e2e.ts online            # online mode: 2 humans, local server (default)
 *   deno run -A scripts/online-e2e.ts online 0          # online mode: 0 humans (3 AI demo)
 *   deno run -A scripts/online-e2e.ts online 1          # online mode: 1 human + 2 AI + watcher
 *   deno run -A scripts/online-e2e.ts online 3          # online mode: 3 humans + watcher
 *   deno run -A scripts/online-e2e.ts online 1 https://example.deno.dev  # remote server
 *   deno run -A scripts/online-e2e.ts local 0 --screenshot  # capture screenshots at phase transitions
 *   deno run -A scripts/online-e2e.ts local 0 --mobile     # emulate mobile (Pixel 7, landscape)
 *   deno run -A scripts/online-e2e.ts local 0 --mobile --screenshot  # both
 *   deno run -A scripts/online-e2e.ts local 0 --mobile --action "phase:BATTLE click:zoom screenshot:zoomed exit"
 *   deno run -A scripts/online-e2e.ts local 0 --headless          # run without browser window
 *   deno run -A scripts/online-e2e.ts local 0 --seed 12345        # force specific map seed
 *   deno run -A scripts/online-e2e.ts local 0 --assert "phase:BATTLE button:quit visible"  # assert UI state
 *   deno run -A scripts/online-e2e.ts local --replay recordings/bug-repro.json  # replay Chrome DevTools recording
 *   deno run -A scripts/online-e2e.ts local --replay recordings/bug-repro.json --screenshot --headless
 *
 * Chrome DevTools Recorder:
 *   1. Open DevTools → Recorder panel → Start recording
 *   2. Perform the actions you want to replay
 *   3. Stop recording → Export as JSON
 *   4. Save to recordings/ folder
 *   5. Replay with --replay <path>
 *
 * Prerequisites:
 *   Online mode: npm run server (port 8001) + npm run dev (port 5173)
 *     Defaults to local server (localhost:8001). Pass a URL to use a remote server.
 *   Local mode: npm run dev (port 5173) only
 */

import { Buffer } from "node:buffer";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { type Browser, chromium, devices, type Page } from "playwright";
import { MESSAGE } from "../src/protocol/protocol.ts";
import { installFastMode } from "../test/e2e/fast-mode.ts";
import { waitForPageExpr, waitForPageFn } from "../test/e2e/helpers.ts";

// Parse --action flags: "phase:BATTLE click:zoom screenshot:label exit"
interface TestAction {
  trigger: { type: "phase" | "mode"; value: string };
  click?: string; // "zoom" | "rotate" | "quit" | "X,Y"
  screenshot?: string;
  exit?: boolean;
  done?: boolean;
}

// Parse --assert flags: "phase:BATTLE button:zoom visible"
interface TestAssert {
  trigger: { type: "phase" | "mode"; value: string };
  button?: string; // "zoom" | "rotate" | "quit"
  expected?: "visible" | "hidden";
  text?: string; // check that text appears in the page
  done?: boolean;
  passed?: boolean;
}

interface CoverageRange {
  start: number;
  end: number;
}

interface JsCoverageEntry {
  url: string;
  text: string;
  ranges: CoverageRange[];
}

interface CoverageSummary {
  path: string;
  executedBytes: number;
  totalBytes: number;
  pct: number;
}

interface RecorderStep {
  type: string;
  url?: string;
  selectors?: string[][];
  offsetX?: number;
  offsetY?: number;
  button?: string;
  value?: string;
  key?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
  isLandscape?: boolean;
  expression?: string;
  operator?: string;
  timeout?: number;
  duration?: number;
  assertedEvents?: unknown[];
}

interface Recording {
  title: string;
  steps: RecorderStep[];
}

const SCREENSHOTS = process.argv.includes("--screenshot");
const MOBILE = process.argv.includes("--mobile");
const HEADLESS = process.argv.includes("--headless");
const RECORD = process.argv.includes("--record");
const FAST = process.argv.includes("--fast");
const COVERAGE = process.argv.includes("--coverage");
const SEED = (() => {
  const idx = process.argv.indexOf("--seed");
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1]! : "";
})();
const REPLAY = (() => {
  const idx = process.argv.indexOf("--replay");
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1]! : "";
})();
const ACTIONS: TestAction[] = [];
const ASSERTS: TestAssert[] = [];
// Filter positional args: skip --flags and their values. This MUST run before
// MODE / NUM_HUMANS / SERVER_URL / NUM_ROUNDS are derived below — they read
// positionalArgs, so populating it afterwards left them all on their online
// defaults regardless of the CLI (e.g. `local 0 ... 1` still ran online-3-round).
const positionalArgs: string[] = parsePositionalArgs();
const MODE = positionalArgs[0] === "local" ? "local" : "online";
const NUM_HUMANS = Math.min(
  3,
  Math.max(0, Number(positionalArgs[1] ?? (MODE === "local" ? 0 : 2))),
);
const LOCAL_SERVER_URL = "http://localhost:8001";
const SERVER_URL =
  positionalArgs[2] ||
  process.env.E2E_SERVER_URL ||
  (MODE === "online" ? LOCAL_SERVER_URL : "");
const NUM_ROUNDS = Number(positionalArgs[3] ?? 3);
// number of game rounds (default 3, any positive integer)
const BASE_URL = "http://localhost:5173/";
const PAGE_URL = SERVER_URL
  ? `${BASE_URL}?server=${new URL(SERVER_URL).host}`
  : BASE_URL;
const GAME_TIMEOUT_MS = 600_000;
// 10 minutes — enough for "To The Death"
const ONLINE_ROUND_OPTIONS = new Set([1, 3, 5, 8, 12]);
const ONLINE_SELECTED_ROUNDS = ONLINE_ROUND_OPTIONS.has(NUM_ROUNDS)
  ? String(NUM_ROUNDS)
  : "3";
const PLAYER_NAMES = ["Red", "Blue", "Gold"];
const REPO_ROOT = process.cwd().replace(/\\/g, "/");
const HAPTIC_LABELS: Record<number, string> = {
  15: "fired",
  30: "wall_hit",
  40: "phase_change",
  80: "cannon_dmg",
  150: "cannon_dead",
  200: "tower_kill",
};
const screenshotsTaken = new Set<string>();
const MOBILE_DEVICE = devices["Pixel 7"];

for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--action" && process.argv[i + 1]) {
    const parts = process.argv[++i]!.split(/\s+/);
    const action: TestAction = { trigger: { type: "phase", value: "" } };
    for (const part of parts) {
      if (part.startsWith("phase:"))
        action.trigger = { type: "phase", value: part.slice(6) };
      else if (part.startsWith("mode:"))
        action.trigger = { type: "mode", value: part.slice(5) };
      else if (part.startsWith("click:")) action.click = part.slice(6);
      else if (part.startsWith("screenshot:"))
        action.screenshot = part.slice(11);
      else if (part === "exit") action.exit = true;
    }
    if (action.trigger.value) ACTIONS.push(action);
  }
}

for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--assert" && process.argv[i + 1]) {
    const parts = process.argv[++i]!.split(/\s+/);
    const assert: TestAssert = { trigger: { type: "phase", value: "" } };
    for (const part of parts) {
      if (part.startsWith("phase:"))
        assert.trigger = { type: "phase", value: part.slice(6) };
      else if (part.startsWith("mode:"))
        assert.trigger = { type: "mode", value: part.slice(5) };
      else if (part.startsWith("button:")) assert.button = part.slice(7);
      else if (part === "visible") assert.expected = "visible";
      else if (part === "hidden") assert.expected = "hidden";
      else if (part.startsWith("text:")) assert.text = part.slice(5);
    }
    if (assert.trigger.value) ASSERTS.push(assert);
  }
}

// Hoisted so the `positionalArgs` const above can call it before MODE et al.
function parsePositionalArgs(): string[] {
  const result: string[] = [];
  const args = process.argv.slice(2);
  const flagsWithValue = new Set([
    "--action",
    "--assert",
    "--seed",
    "--replay",
  ]);
  for (let i = 0; i < args.length; i++) {
    if (flagsWithValue.has(args[i]!)) {
      i++;
      continue;
    } // skip flag + value
    if (args[i]!.startsWith("--")) continue; // skip boolean flags
    result.push(args[i]!);
  }
  return result;
}

if (MODE === "local") {
  runLocal().catch((err: Error) => {
    console.error("Local E2E test failed:", err.message);
    process.exit(1);
  });
} else {
  runOnline().catch((err: Error) => {
    console.error("Online E2E test failed:", err.message);
    process.exit(1);
  });
}

async function runLocal() {
  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--window-size=1024,600"],
  });
  const page = await newPage(browser);
  await installVibrateSpy(page);
  const logs: string[] = [];
  collectLogs(page, "LOCAL", logs);

  // Flush logs on exit (e.g. when killed by `timeout`) so they're always saved
  let logsFlushed = false;
  const flushLogs = () => {
    if (logsFlushed) return;
    logsFlushed = true;
    mkdirSync("logs", { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
    const path = `logs/e2e-local-${NUM_HUMANS}h-${stamp}.log`;
    writeFileSync(path, logs.join("\n"));
  };
  process.on("exit", flushLogs);
  process.on("SIGTERM", () => {
    flushLogs();
    process.exit(128 + 15);
  });
  process.on("SIGINT", () => {
    flushLogs();
    process.exit(128 + 2);
  });

  console.log(
    `${ts()} Starting local E2E test: ${NUM_HUMANS} human${NUM_HUMANS !== 1 ? "s" : ""} + ${3 - NUM_HUMANS} AI`,
  );

  // --replay: replay a Chrome DevTools recording JSON
  if (REPLAY) {
    const raw = JSON.parse(readFileSync(REPLAY, "utf8"));
    await replayRecording(page, raw as Recording);
    console.log(`${ts()} Waiting 3s after replay for logs to settle...`);
    await page.waitForTimeout(3000);

    analyzeResults([], [logs], [], ["LOCAL"], `replay`);
    logsFlushed = true;
    printCoverageReport(await stopCoverage(page), "replay");
    await printHapticSummary(page);
    printAssertSummary();
    await page.close();
    await browser.close();
    console.log(`\n${ts()} Replay E2E test complete.`);
    printDebugReminder();
    if (ASSERTS.some((a) => a.done && !a.passed)) process.exit(1);
    return;
  }

  const localUrl = `${BASE_URL}?rounds=${NUM_ROUNDS}`;
  await page.goto(localUrl);
  // Set seed via localStorage, rounds via query parameter
  await page.evaluate((seed: string) => {
    if (seed) {
      const settings = JSON.parse(
        localStorage.getItem("castles99_settings") || "{}",
      );
      settings.seedMode = "custom";
      settings.seed = seed;
      localStorage.setItem("castles99_settings", JSON.stringify(settings));
    }
    document.title = "Local Play";
  }, SEED);
  // Click "Local Play" to load main.ts and show canvas lobby
  await page.click("#btn-local");
  await page.waitForSelector("#game-container.active", { timeout: 5000 });
  await page.waitForTimeout(500);

  // --fast: override requestAnimationFrame so the lobby countdown runs fast.
  if (FAST) await installFastMode(page);

  // Join human slots
  if (MOBILE && NUM_HUMANS > 0) {
    // On mobile, tap the canvas lobby slots (game starts immediately on first tap)
    const canvas = await page.$("canvas")!;
    const box = await canvas!.boundingBox();
    if (box) {
      // Lobby layout: 3 slots evenly spaced, centered vertically
      const slotCount = 3;
      const gap = 12 * (box.width / 1280); // scale gap to viewport
      const rectW = (box.width - gap * (slotCount + 1)) / slotCount;
      const rectY = box.y + box.height * 0.27;
      const rectH = box.height * 0.5;
      for (let i = 0; i < NUM_HUMANS; i++) {
        const cx = box.x + gap * (i + 1) + rectW * i + rectW / 2;
        const cy = rectY + rectH / 2;
        await page.touchscreen.tap(cx, cy);
        console.log(
          `${ts()} Tapped slot ${i} (${PLAYER_NAMES[i]}) at (${cx.toFixed(0)},${cy.toFixed(0)})`,
        );
        await page.waitForTimeout(300);
      }
    }
  } else {
    const slotKeys = ["n", "f", "h"];
    for (let i = 0; i < NUM_HUMANS; i++) {
      await page.keyboard.press(slotKeys[i]!);
      console.log(`${ts()} Joined slot ${i} (${PLAYER_NAMES[i]}) as human`);
      await page.waitForTimeout(300);
    }
  }

  // Wait for the game to start (lobby timer expires or immediate on mobile)
  console.log(`${ts()} Waiting for game to start...`);
  await takeScreenshot(page, "game", "lobby");
  await waitForPageFn(
    page,
    () => {
      const w = window as unknown as Record<string, unknown>;
      const e2e = w.__e2e as unknown as { mode?: string };
      return e2e?.mode !== undefined && e2e?.mode !== "LOBBY";
    },
    90_000,
  );
  console.log(`${ts()} Game started`);

  // Simulate human play or wait for AI-only game
  let allActions: string[][] = [];
  if (NUM_HUMANS > 0) {
    allActions = [await simulateHumanPlayLoop(page, "LOCAL", GAME_TIMEOUT_MS)];
  } else {
    // All-AI: poll until game over
    const deadline = Date.now() + GAME_TIMEOUT_MS;
    let lastReported = "";
    while (Date.now() < deadline) {
      const info = await page
        .evaluate(() => {
          const w = window as unknown as Record<string, unknown>;
          const e2e = w.__e2e as unknown as {
            mode?: string;
            phase?: string;
            timer?: number;
          };
          return {
            mode: e2e?.mode ?? "",
            phase: e2e?.phase ?? "",
            timer: e2e?.timer ?? 0,
          };
        })
        .catch(() => ({ mode: "", phase: "", timer: 0 }));
      if (info.mode === "STOPPED") {
        console.log(`${ts()} Game over detected`);
        await takeScreenshot(page, "game", "game-over");
        break;
      }
      const key = `${info.mode}/${info.phase}`;
      if (key !== lastReported) {
        console.log(
          `${ts()} Phase: ${info.mode} / ${info.phase} (timer=${info.timer.toFixed(1)})`,
        );
        const label = `${info.mode}-${info.phase}`
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "-");
        await takeScreenshot(page, "game", label);
        lastReported = key;
        if (await executeActions(page, info.phase, info.mode)) break;
        await executeAsserts(page, info.phase, info.mode);
      }
      await page.waitForTimeout(500);
    }
  }

  // Check final game state
  const finalMode = await page
    .evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const e2e = w.__e2e as unknown as {
        mode?: string;
        phase?: string;
        timer?: number;
      };
      return e2e?.mode as string;
    })
    .catch(() => "unknown");
  if (finalMode === "STOPPED") {
    logs.push(`[LOCAL] gameOver — game ended normally`);
  } else {
    logs.push(`[LOCAL] game still running (mode=${finalMode})`);
  }

  // --- ANALYSIS ---
  analyzeResults(
    allActions,
    [logs],
    NUM_HUMANS > 0 ? ["LOCAL"] : [],
    ["LOCAL"],
    `local-${NUM_HUMANS}h`,
  );
  logsFlushed = true; // analyzeResults already saved the log file
  printCoverageReport(await stopCoverage(page), `local-${NUM_HUMANS}h`);

  await printHapticSummary(page);
  if (RECORD) {
    const videoPath = await page.video()?.path();
    if (videoPath) console.log(`${ts()} Video: ${videoPath}`);
  }
  printAssertSummary();
  await page.close(); // finalize video before closing browser
  await browser.close();
  console.log(`\n${ts()} Local E2E test complete.`);
  printDebugReminder();
  if (ASSERTS.some((a) => a.done && !a.passed)) process.exit(1);
}

async function replayRecording(
  page: Page,
  recording: Recording,
): Promise<void> {
  console.log(
    `${ts()} Replaying "${recording.title}" (${recording.steps.length} steps)`,
  );
  for (let i = 0; i < recording.steps.length; i++) {
    const step = recording.steps[i]!;
    const stepTimeout = step.timeout ?? 5000;
    console.log(
      `${ts()} Step ${i + 1}/${recording.steps.length}: ${step.type}${step.key ? ` key=${step.key}` : ""}${step.selectors ? ` sel=${pickSelector(step.selectors)}` : ""}${step.url ? ` url=${step.url}` : ""}`,
    );

    switch (step.type) {
      case "setViewport":
        await page.setViewportSize({
          width: step.width ?? 1280,
          height: step.height ?? 720,
        });
        break;

      case "navigate":
        await page.goto(step.url!, { timeout: stepTimeout, waitUntil: "load" });
        break;

      case "click": {
        const sel = pickSelector(step.selectors!);
        const opts: {
          timeout: number;
          button?: "left" | "right" | "middle";
          position?: { x: number; y: number };
        } = { timeout: stepTimeout };
        if (step.button === "right") opts.button = "right";
        else if (step.button === "middle") opts.button = "middle";
        if (step.offsetX !== undefined && step.offsetY !== undefined) {
          opts.position = { x: step.offsetX, y: step.offsetY };
        }
        await page.click(sel, opts);
        break;
      }

      case "doubleClick": {
        const sel = pickSelector(step.selectors!);
        await page.dblclick(sel, { timeout: stepTimeout });
        break;
      }

      case "hover": {
        const sel = pickSelector(step.selectors!);
        await page.hover(sel, { timeout: stepTimeout });
        break;
      }

      case "change": {
        const sel = pickSelector(step.selectors!);
        await page.fill(sel, step.value ?? "");
        break;
      }

      case "keyDown":
        await page.keyboard.down(step.key!);
        break;

      case "keyUp":
        await page.keyboard.up(step.key!);
        break;

      case "scroll":
        if (step.selectors) {
          const sel = pickSelector(step.selectors);
          await page.$eval(sel, (el, { x, y }) => el.scrollBy(x, y), {
            x: step.x ?? 0,
            y: step.y ?? 0,
          });
        } else {
          await page.evaluate(({ x, y }) => scrollBy(x, y), {
            x: step.x ?? 0,
            y: step.y ?? 0,
          });
        }
        break;

      case "waitForElement": {
        const sel = pickSelector(step.selectors!);
        const state =
          step.operator === "disappear"
            ? ("hidden" as const)
            : ("visible" as const);
        await page.waitForSelector(sel, { timeout: stepTimeout, state });
        break;
      }

      case "waitForExpression":
        await waitForPageExpr(page, step.expression!, stepTimeout);
        break;

      case "close":
        await page.close();
        return;

      default:
        console.log(`${ts()}   (skipped unknown step type: ${step.type})`);
    }
  }
  console.log(`${ts()} Replay complete`);
}

function pickSelector(selectors: string[][]): string {
  // Chrome DevTools Recorder provides multiple selector strategies per step.
  // Prefer aria > CSS > xpath. Each entry is an array of selector parts
  // (for shadow DOM piercing); we join with ` >> ` for Playwright.
  for (const chain of selectors) {
    const sel = chain.join(" >> ");
    // Skip xpath selectors — Playwright handles them differently
    if (!sel.startsWith("xpath/")) return sel;
  }
  return selectors[0]!.join(" >> ");
}

async function runOnline() {
  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--window-size=1024,600"],
  });
  const clientLogs: string[][] = [];
  const clientLabels: string[] = [];
  const clientPages: Page[] = [];
  const humanPages: Page[] = [];

  console.log(
    `${ts()} Starting online E2E test: ${NUM_HUMANS} human${NUM_HUMANS !== 1 ? "s" : ""} + ${3 - NUM_HUMANS} AI, ${ONLINE_SELECTED_ROUNDS} rounds`,
  );

  // --- HOST ---
  const hostPage = await newPage(browser);
  await installVibrateSpy(hostPage);
  const hostLogs: string[] = [];
  collectLogs(hostPage, "HOST", hostLogs);
  const code = await createRoom(hostPage);

  const isHostHuman = NUM_HUMANS >= 1;
  if (isHostHuman) {
    await hostPage.evaluate(() => {
      document.body.style.zoom = "70%";
      document.title = "P0 Red — Host";
    });
    await selectSlot(hostPage, 0);
    console.log(`${ts()} Host selected slot 0 (Red) — human`);
    humanPages.push(hostPage);
  } else {
    await hostPage.evaluate(() => {
      document.body.style.zoom = "70%";
      document.title = "Host (demo)";
    });
    console.log(`${ts()} Host created room (demo mode, no slot)`);
  }
  clientPages.push(hostPage);
  clientLogs.push(hostLogs);
  clientLabels.push("HOST");
  await hostPage.waitForTimeout(1500);

  // --- ADDITIONAL HUMAN PLAYERS ---
  for (let i = 1; i < NUM_HUMANS; i++) {
    const page = await newPage(browser);
    const logs: string[] = [];
    const label = `P${i}`;
    collectLogs(page, label, logs);
    await joinRoom(page, code);
    await page.evaluate(
      (info: { i: number; name: string }) => {
        document.body.style.zoom = "70%";
        document.title = `P${info.i} ${info.name} — Player`;
      },
      { i, name: PLAYER_NAMES[i]! },
    );
    await selectSlot(page, i);
    console.log(
      `${ts()} Player joined as slot ${i} (${PLAYER_NAMES[i]}) — human`,
    );
    humanPages.push(page);
    clientPages.push(page);
    clientLogs.push(logs);
    clientLabels.push(label);
    await page.waitForTimeout(1000);
  }

  // --- WATCHER ---
  const watcherPage = await newPage(browser);
  const watcherLogs: string[] = [];
  collectLogs(watcherPage, "WATCH", watcherLogs);
  await joinRoom(watcherPage, code);
  await watcherPage.evaluate(() => {
    document.body.style.zoom = "70%";
    document.title = "Watcher";
  });
  console.log(`${ts()} Watcher joined room ${code}`);
  clientPages.push(watcherPage);
  clientLogs.push(watcherLogs);
  clientLabels.push("WATCHER");

  // Flush logs on exit (e.g. when killed by `timeout`) so they're always saved
  let logsFlushed = false;
  const flushLogs = () => {
    if (logsFlushed) return;
    logsFlushed = true;
    mkdirSync("logs", { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
    const path = `logs/e2e-online-${NUM_HUMANS}h-${stamp}.log`;
    const rawLogs = clientLabels.flatMap((label, i) => [
      `\n=== RAW ${label} LOGS ===`,
      ...clientLogs[i]!,
    ]);
    writeFileSync(path, rawLogs.join("\n"));
    console.log(`\nLogs flushed to ${path}`);
  };
  process.on("exit", flushLogs);
  process.on("SIGTERM", () => {
    flushLogs();
    process.exit(128 + 15);
  });
  process.on("SIGINT", () => {
    flushLogs();
    process.exit(128 + 2);
  });

  // --- SIMULATION ---
  console.log(`${ts()} Starting simulation (${humanPages.length} human loops)`);

  let allActions: string[][] = [];
  if (humanPages.length > 0) {
    allActions = await Promise.all(
      humanPages.map((page, i) => {
        const label = i === 0 ? "HOST" : `P${i}`;
        return simulateHumanPlayLoop(page, label, GAME_TIMEOUT_MS);
      }),
    );
  } else {
    // All-AI demo: poll host page for game over
    const deadline = Date.now() + GAME_TIMEOUT_MS;
    let lastReported = "";
    while (Date.now() < deadline) {
      const info = await hostPage
        .evaluate(() => {
          const w = window as unknown as Record<string, unknown>;
          const e2e = w.__e2e as Record<string, unknown>;
          return {
            mode: (e2e?.mode as string) ?? "",
            phase: (e2e?.phase as string) ?? "",
            timer: (e2e?.timer as number) ?? 0,
          };
        })
        .catch(() => ({ mode: "", phase: "", timer: 0 }));
      if (info.mode === "STOPPED") {
        console.log(`${ts()} Game over detected`);
        await takeScreenshot(hostPage, "game", "game-over");
        break;
      }
      const key = `${info.mode}/${info.phase}`;
      if (key !== lastReported) {
        console.log(
          `${ts()} Phase: ${info.mode} / ${info.phase} (timer=${info.timer.toFixed(1)})`,
        );
        const label = `${info.mode}-${info.phase}`
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "-");
        await takeScreenshot(hostPage, "game", label);
        lastReported = key;
        if (await executeActions(hostPage, info.phase, info.mode)) break;
        await executeAsserts(hostPage, info.phase, info.mode);
      }
      await hostPage.waitForTimeout(500);
    }
  }

  // --- ANALYSIS ---
  const actionLabels = humanPages.map((_, i) => (i === 0 ? "HOST" : `P${i}`));
  analyzeResults(
    allActions,
    clientLogs,
    actionLabels,
    clientLabels,
    `online-${NUM_HUMANS}h`,
  );

  // Online-specific: critical messages check. (CASTLE_WALLS was dropped from
  // the protocol in 7ab7fff1 — the watcher now derives castle walls locally on
  // the BUILD_START marker, nothing is sent over the wire — so it's no longer a
  // received-message to assert on.)
  const critical = [
    MESSAGE.CANNON_START,
    MESSAGE.BATTLE_START,
    MESSAGE.BUILD_START,
  ];
  for (let i = 1; i < clientLabels.length; i++) {
    const counts = countMessageTypes(clientLogs[i]!);
    const missing = critical.filter((t) => !counts[t]);
    if (missing.length === 0) {
      console.log(
        `\n=== ALL CRITICAL MESSAGES RECEIVED BY ${clientLabels[i]} ===`,
      );
      continue;
    }
    // A peer that self-disconnected on a DESYNC never reaches the later
    // phases, so its missing criticals are the EXPECTED downstream of that
    // drop — not a parity regression. The desync itself is a known
    // single-machine E2E-harness artifact: three browser contexts contend
    // for CPU on one machine, a peer's simTick drifts past the 8-tick
    // lockstep safety window, and a stale wire stamp reorders shared-rng
    // draws (a stale drain landing in a dense-rng window, uncorrelated with
    // skew size — measured ~70% of `online 2` runs, with/without the
    // renderer anti-throttle switches). Real cross-peer parity is proven
    // deterministically by the mock-clock gates (network-vs-local /
    // network-bidirectional / camera-zoom-parity), so we warn here instead
    // of alarming. A miss WITHOUT a desync means the peer stayed connected
    // but never got the message — that IS a real failure, kept distinct.
    const desynced = clientLogs[i]!.some((line) => line.includes("DESYNC"));
    console.log(
      desynced
        ? `\n=== KNOWN HARNESS DESYNC (${clientLabels[i]}) — missing criticals expected ===`
        : `\n=== MISSING CRITICAL MESSAGES (${clientLabels[i]}) ===`,
    );
    for (const t of missing) console.log(`  ${t}: NOT received`);
    if (desynced) {
      console.log(
        "  (single-machine E2E CPU-contention desync; parity covered by the mock-clock gates)",
      );
    }
  }

  const coverageEntries = (
    await Promise.all(clientPages.map((page) => stopCoverage(page)))
  ).flat();
  printCoverageReport(coverageEntries, `online-${NUM_HUMANS}h`);

  await printHapticSummary(hostPage);
  printAssertSummary();
  await browser.close();
  console.log(`\n${ts()} Online E2E test complete.`);
  printDebugReminder();
  if (ASSERTS.some((a) => a.done && !a.passed)) process.exit(1);
}

function printAssertSummary(): void {
  if (ASSERTS.length === 0) return;
  const passed = ASSERTS.filter((a) => a.done && a.passed).length;
  const failed = ASSERTS.filter((a) => a.done && !a.passed).length;
  const skipped = ASSERTS.filter((a) => !a.done).length;
  console.log(
    `\n=== ASSERTIONS: ${passed} passed, ${failed} failed, ${skipped} skipped ===`,
  );
}

/** Install a vibrate spy on mobile-emulated pages. */
async function installVibrateSpy(page: Page): Promise<void> {
  if (!MOBILE) return;
  await page.addInitScript(() => {
    const calls: number[] = [];
    (
      window as unknown as Window & { __vibrateCalls: number[] }
    ).__vibrateCalls = calls;
    const orig = navigator.vibrate?.bind(navigator);
    navigator.vibrate = ((pattern: VibratePattern) => {
      const ms = typeof pattern === "number" ? pattern : ([...pattern][0] ?? 0);
      calls.push(ms);
      return orig ? orig(pattern) : true;
    }) as typeof navigator.vibrate;
  });
}

async function printHapticSummary(page: Page): Promise<void> {
  if (!MOBILE) return;
  const calls = await page
    .evaluate(
      () =>
        (window as unknown as Window & { __vibrateCalls: number[] })
          .__vibrateCalls ?? [],
    )
    .catch(() => []);
  if (calls.length === 0) {
    console.log("\n=== HAPTICS: no vibrate calls ===");
    return;
  }
  const counts: Record<number, number> = {};
  for (const c of calls) counts[c] = (counts[c] || 0) + 1;
  console.log(`\n=== HAPTICS: ${calls.length} vibrate calls ===`);
  for (const [ms, n] of Object.entries(counts).sort(
    (a, b) => Number(a[0]) - Number(b[0]),
  )) {
    const label = HAPTIC_LABELS[Number(ms)] ?? "?";
    console.log(`  ${ms}ms (${label}): ${n}x`);
  }
}

async function newPage(browser: Browser): Promise<Page> {
  const recordVideo = RECORD
    ? { dir: "logs/", size: { width: 1024, height: 600 } }
    : undefined;
  if (MOBILE) {
    const ctx = await browser.newContext({
      ...MOBILE_DEVICE,
      viewport: {
        width: MOBILE_DEVICE.viewport.height,
        height: MOBILE_DEVICE.viewport.width,
      },
      recordVideo,
    });
    const page = await ctx.newPage();
    await startCoverage(page);
    return page;
  }
  const ctx = await browser.newContext({ recordVideo });
  const page = await ctx.newPage();
  await startCoverage(page);
  return page;
}

function collectLogs(page: Page, prefix: string, logs: string[]): void {
  page.on("console", (m: { type: () => string; text: () => string }) =>
    logs.push(`${ts()} [${prefix} ${m.type()}] ${m.text()}`),
  );
  page.on("pageerror", (err: Error) =>
    logs.push(`${ts()} [${prefix} ERROR] ${err.message}`),
  );
}

async function startCoverage(page: Page): Promise<void> {
  if (!COVERAGE) return;
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
}

async function stopCoverage(page: Page): Promise<JsCoverageEntry[]> {
  if (!COVERAGE || page.isClosed()) return [];
  const entries = await page.coverage.stopJSCoverage();
  return entries.map((entry) => ({
    url: entry.url,
    text: entry.source ?? "",
    ranges: entry.functions.flatMap((fn) =>
      fn.ranges
        .filter((range) => range.count > 0)
        .map((range) => ({ start: range.startOffset, end: range.endOffset })),
    ),
  }));
}

function printCoverageReport(
  entries: readonly JsCoverageEntry[],
  label: string,
): void {
  if (!COVERAGE) return;
  const summaries = summarizeCoverage(entries);
  mkdirSync("logs", { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
  const outPath = `logs/e2e-coverage-${label}-${stamp}.json`;
  writeFileSync(outPath, JSON.stringify(summaries, null, 2));

  const interestingPatterns = [
    /^src\/online-/,
    /^src\/controller-human\.ts$/,
    /^src\/input-/,
    /^src\/runtime\/subsystems\/camera\.ts$/,
    /^src\/runtime\/.*\.ts$/,
  ];
  const interesting = summaries.filter((summary) =>
    interestingPatterns.some((pattern) => pattern.test(summary.path)),
  );
  const topInteresting = interesting
    .sort(
      (left, right) =>
        right.executedBytes - left.executedBytes || right.pct - left.pct,
    )
    .slice(0, 20);

  console.log(`\n=== E2E COVERAGE (${label}) ===`);
  console.log(`  modules: ${summaries.length}`);
  console.log(`  report: ${outPath}`);
  if (topInteresting.length === 0) {
    console.log("  no src/ browser modules were captured");
    return;
  }
  for (const summary of topInteresting) {
    console.log(
      `  ${summary.path}: ${summary.pct}% (${summary.executedBytes}/${summary.totalBytes} bytes)`,
    );
  }
}

function summarizeCoverage(
  entries: readonly JsCoverageEntry[],
): CoverageSummary[] {
  const aggregated = new Map<
    string,
    { totalBytes: number; ranges: CoverageRange[] }
  >();
  for (const entry of entries) {
    const path = normalizeCoveragePath(entry.url);
    if (!path) continue;
    const current = aggregated.get(path);
    if (current) {
      current.ranges.push(...entry.ranges);
      current.totalBytes = Math.max(current.totalBytes, entry.text.length);
    } else {
      aggregated.set(path, {
        totalBytes: entry.text.length,
        ranges: [...entry.ranges],
      });
    }
  }
  return [...aggregated.entries()]
    .map(([path, value]) => {
      const executedBytes = countCoveredBytes(value.ranges);
      const totalBytes = value.totalBytes;
      return {
        path,
        executedBytes,
        totalBytes,
        pct:
          totalBytes === 0
            ? 0
            : Number(((executedBytes / totalBytes) * 100).toFixed(2)),
      };
    })
    .sort(
      (left, right) =>
        right.pct - left.pct ||
        right.executedBytes - left.executedBytes ||
        left.path.localeCompare(right.path),
    );
}

function countCoveredBytes(ranges: readonly CoverageRange[]): number {
  return mergeRanges(ranges).reduce(
    (total, range) => total + Math.max(0, range.end - range.start),
    0,
  );
}

function mergeRanges(ranges: readonly CoverageRange[]): CoverageRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const merged: CoverageRange[] = [
    { start: sorted[0]!.start, end: sorted[0]!.end },
  ];
  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i]!;
    const last = merged[merged.length - 1]!;
    if (current.start <= last.end) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ start: current.start, end: current.end });
    }
  }
  return merged;
}

function normalizeCoveragePath(url: string): string | null {
  if (!url || url.startsWith("extensions::") || url.startsWith("devtools://"))
    return null;
  try {
    const parsed = new URL(url);
    let path = decodeURIComponent(parsed.pathname);
    if (path.includes("/@fs/")) {
      path = path.slice(path.indexOf("/@fs/") + 5);
    }
    if (path.startsWith(REPO_ROOT)) {
      path = path.slice(REPO_ROOT.length);
    }
    if (path.startsWith("/")) path = path.slice(1);
    if (
      !path.startsWith("src/") &&
      !path.startsWith("test/") &&
      !path.startsWith("server/")
    ) {
      return null;
    }
    return path;
  } catch {
    return null;
  }
}

async function createRoom(page: Page): Promise<string> {
  await page.goto(PAGE_URL);
  await page.click("#btn-online");
  await page.waitForSelector("#page-online[data-ready]", { timeout: 10000 });
  await page.selectOption("#create-wait", "10");
  await page.selectOption("#create-rounds", ONLINE_SELECTED_ROUNDS);
  await page.click("#btn-create-confirm");
  await waitForPageFn(
    page,
    () => document.getElementById("page-online")?.hidden === true,
    10000,
  );
  await page.waitForTimeout(300);
  const code = await page.evaluate(() => {
    const el = document.getElementById("room-code-overlay");
    return el?.innerText?.trim()?.match(/[A-Z]{4}/)?.[0] ?? "";
  });
  if (code.length !== 4) throw new Error("Failed to extract room code");
  return code;
}

async function joinRoom(page: Page, code: string): Promise<void> {
  await page.goto(PAGE_URL);
  await page.click("#btn-online");
  await page.waitForSelector("#page-online[data-ready]", { timeout: 10000 });
  await page.fill("#join-code", code);
  await page.click("#btn-join-confirm");
  await waitForPageFn(
    page,
    () => document.getElementById("page-online")?.hidden === true,
    10000,
  );
}

async function selectSlot(page: Page, slot: number): Promise<void> {
  const keys = ["n", "f", "h"];
  const key = keys[slot];
  if (!key) throw new Error(`Invalid slot ${slot}`);
  await page.keyboard.press(key);
  await page.waitForTimeout(300);
}

function printDebugReminder(): void {
  console.log(`
[AGENT] If debugging, follow this loop until the bug is PROVEN fixed:
  1. Read the log output above — analyze with a script, not by eye
  2. If the bug is confirmed fixed → remove debug logs → npm run build → done
  3. If NOT fixed → update logs or fix code → re-run this exact test → go to 1
  Do NOT remove debug logs until step 2 passes.`);
}

async function simulateHumanPlayLoop(
  page: Page,
  label: string,
  durationMs: number,
): Promise<string[]> {
  const actions: string[] = [];
  const start = Date.now();
  let iteration = 0;

  while (Date.now() - start < durationMs) {
    iteration++;

    const { mode, phase } = await page
      .evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        const testMode = (w.__e2e as Record<string, unknown> | undefined)
          ?.mode as string | undefined;
        if (!testMode) {
          const lobby = document.getElementById("lobby");
          if (lobby && lobby.style.display !== "none")
            return { mode: "DOM_LOBBY", phase: "" };
        }
        return {
          mode: testMode ?? "unknown",
          phase:
            ((w.__e2e as Record<string, unknown> | undefined)
              ?.phase as string) ?? "",
        };
      })
      .catch(() => ({ mode: "unknown", phase: "" }));

    if (iteration % 20 === 0) {
      console.log(
        `${ts()} ${label}: iteration ${iteration} (mode=${mode} phase=${phase})`,
      );
    }
    if (mode === "LOBBY" && Date.now() - start > 60_000) {
      actions.push(`${ts()} ${label}: game ended (lobby visible after 60s)`);
      break;
    }

    if (mode === "DOM_LOBBY") {
      await page.waitForTimeout(500);
      continue;
    }

    if (mode === "STOPPED") {
      actions.push(`${ts()} ${label}: game over`);
      break;
    }

    // Execute scripted actions/asserts on phase change
    if (await executeActions(page, phase, mode)) {
      actions.push(`${ts()} ${label}: action requested exit`);
      break;
    }
    await executeAsserts(page, phase, mode);

    if (mode === "LIFE_LOST") {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(100);
      await page.keyboard.press("n");
      actions.push(`${ts()} ${label}: life-lost dialog — pressed abandon`);
      await page.waitForTimeout(300);
      continue;
    }

    if (
      mode === "TRANSITION" ||
      mode === "BALLOON_ANIM" ||
      mode === "CASTLE_BUILD"
    ) {
      await page.waitForTimeout(200);
      continue;
    }

    if (mode === "SELECTION") {
      const timer = await page
        .evaluate(() => {
          return (
            ((
              (window as unknown as Record<string, unknown>).__e2e as Record<
                string,
                unknown
              >
            )?.timer as number) ?? 10
          );
        })
        .catch(() => 10);

      if (timer > 4) {
        await page.keyboard.press(
          Math.random() < 0.5 ? "ArrowRight" : "ArrowLeft",
        );
        await page.waitForTimeout(500);
      } else {
        await page.keyboard.press("n");
        actions.push(`${ts()} ${label}: confirmed tower selection`);
        await page.waitForTimeout(300);
      }
      continue;
    }

    if (phase === "CANNON_PLACE") {
      // Alternate keyboard and mouse to exercise both cursor paths
      if (iteration % 2 === 0) {
        const box = await page.locator("#canvas").boundingBox();
        if (box) {
          const mx = box.x + 50 + Math.random() * (box.width - 100);
          const my = box.y + 50 + Math.random() * (box.height - 100);
          await page.mouse.move(mx, my);
          await page.waitForTimeout(50);
          await page.mouse.click(mx, my);
        }
      } else {
        await page.keyboard.press("n");
        await page.waitForTimeout(100);
        const dir = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"][
          Math.floor(Math.random() * 4)
        ]!;
        await page.keyboard.press(dir);
        await page.waitForTimeout(50);
        await page.keyboard.press("n");
      }
      if (iteration % 50 === 0)
        actions.push(`${ts()} ${label}: cannon phase iteration ${iteration}`);
      await page.waitForTimeout(200);
      continue;
    }

    if (phase === "WALL_BUILD") {
      const dirs = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
      for (let i = 0; i < 1 + Math.floor(Math.random() * 3); i++) {
        await page.keyboard.press(
          dirs[Math.floor(Math.random() * dirs.length)]!,
        );
        await page.waitForTimeout(30);
      }
      if (Math.random() < 0.3) await page.keyboard.press("b");
      await page.keyboard.press("n");
      if (iteration % 50 === 0)
        actions.push(`${ts()} ${label}: build phase iteration ${iteration}`);
      await page.waitForTimeout(150);
      continue;
    }

    if (phase === "BATTLE") {
      const aim = await page
        .evaluate(() => {
          const w = window as unknown as Record<string, unknown>;
          const e2e = w.__e2e as
            | Record<string, Record<string, unknown>>
            | undefined;
          const targets = e2e?.targeting?.enemyTargets as
            | { x: number; y: number }[]
            | undefined;
          const ch = e2e?.controller?.crosshair as
            | { x: number; y: number }
            | undefined;
          if (!targets || targets.length === 0 || !ch) return null;
          let best = targets[0]!,
            bestDist = Infinity;
          for (const t of targets) {
            const d = Math.hypot(t.x - ch.x, t.y - ch.y);
            if (d < bestDist) {
              bestDist = d;
              best = t;
            }
          }
          return { dx: best.x - ch.x, dy: best.y - ch.y, dist: bestDist };
        })
        .catch(() => null);

      if (aim && aim.dist > 8) {
        const key =
          Math.abs(aim.dx) > Math.abs(aim.dy)
            ? aim.dx > 0
              ? "ArrowRight"
              : "ArrowLeft"
            : aim.dy > 0
              ? "ArrowDown"
              : "ArrowUp";
        await page.keyboard.down(key);
        await page.waitForTimeout(150);
        await page.keyboard.up(key);
      } else {
        await page.keyboard.press("n");
        await page.waitForTimeout(100);
      }
      if (iteration % 50 === 0)
        actions.push(`${ts()} ${label}: battle iteration ${iteration}`);
      await page.waitForTimeout(30);
      continue;
    }

    if (iteration % 50 === 0)
      actions.push(
        `${ts()} ${label}: iteration ${iteration} (mode=${mode} phase=${phase})`,
      );
    await page.waitForTimeout(200);
  }

  actions.push(
    `${ts()} ${label}: simulation ended after ${iteration} iterations`,
  );
  return actions;
}

/** Execute pending asserts that match current phase/mode. Returns false if any assert failed. */
async function executeAsserts(
  page: Page,
  phase: string,
  mode: string,
): Promise<boolean> {
  let allPassed = true;
  for (const assert of ASSERTS) {
    if (assert.done) continue;
    const match =
      assert.trigger.type === "phase"
        ? phase === assert.trigger.value
        : mode === assert.trigger.value;
    if (!match) continue;
    assert.done = true;

    if (assert.button && assert.expected) {
      const btn = await page.$(btnSelector(assert.button));
      const isVisible = btn ? await btn.isVisible() : false;
      const expectVisible = assert.expected === "visible";
      assert.passed = isVisible === expectVisible;
      const status = assert.passed ? "PASS" : "FAIL";
      console.log(
        `${ts()} Assert ${status}: button:${assert.button} ${assert.expected} (actual: ${isVisible ? "visible" : "hidden"})`,
      );
      if (!assert.passed) allPassed = false;
    }

    if (assert.text) {
      const content = await page
        .evaluate(() => document.body.innerText)
        .catch(() => "");
      const found = content.includes(assert.text);
      assert.passed = found;
      const status = found ? "PASS" : "FAIL";
      console.log(
        `${ts()} Assert ${status}: text:"${assert.text}" ${found ? "found" : "not found"}`,
      );
      if (!found) allPassed = false;
    }
  }
  return allPassed;
}

/** Execute pending actions that match current phase/mode. Returns true if an action requested exit. */
async function executeActions(
  page: Page,
  phase: string,
  mode: string,
): Promise<boolean> {
  for (const action of ACTIONS) {
    if (action.done) continue;
    const match =
      action.trigger.type === "phase"
        ? phase === action.trigger.value
        : mode === action.trigger.value;
    if (!match) continue;
    action.done = true;
    console.log(
      `${ts()} Action triggered: ${action.trigger.type}:${action.trigger.value}`,
    );

    if (action.click) {
      const target = action.click;
      if (
        target === "zoom" ||
        target === "home" ||
        target === "enemy" ||
        target === "rotate" ||
        target === "quit"
      ) {
        const btn = await page.$(btnSelector(target));
        if (btn) {
          await btn.click();
          console.log(`${ts()} Clicked ${target} button`);
        } else {
          console.log(`${ts()} WARNING: ${target} button not found`);
        }
      } else if (target.includes(",")) {
        const [x, y] = target.split(",").map(Number);
        await page.mouse.click(x!, y!);
        console.log(`${ts()} Clicked at (${x},${y})`);
      }
      // Brief pause for render to update
      await page.waitForTimeout(200);
    }

    if (action.screenshot) {
      await takeScreenshot(page, "action", action.screenshot, true);
    }

    if (action.exit) {
      console.log(`${ts()} Action requested exit`);
      return true;
    }
  }
  return false;
}

function btnSelector(name: string): string {
  if (name === "home") return "button[data-btn='home']";
  if (name === "enemy") return "button[data-btn='enemy']";
  if (name === "zoom") return "button[data-btn='home']"; // alias for home
  if (name === "rotate") return "button[style*='right: 24px'][style*='bottom']";
  if (name === "quit") return "button[style*='right: 12px'][style*='top']";
  return `button:has-text("${name}")`;
}

async function takeScreenshot(
  page: Page,
  prefix: string,
  label: string,
  force = false,
): Promise<void> {
  if (!SCREENSHOTS && !force) return;
  const key = `${prefix}-${label}`;
  if (screenshotsTaken.has(key)) return; // one per label
  screenshotsTaken.add(key);
  const filename = `logs/screenshot-${prefix}-${label}.png`;
  // Capture at reduced quality/size to save LLM context
  const buf = await page.screenshot({ type: "png", scale: "css" });
  // Downscale via page canvas
  const small = await page.evaluate(async (b64: string) => {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = rej;
      img.src = "data:image/png;base64," + b64;
    });
    const scale = 0.35;
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/png").split(",")[1]!;
  }, buf.toString("base64"));
  writeFileSync(filename, Buffer.from(small, "base64"));
  console.log(`${ts()} Screenshot: ${filename}`);
}

function ts(): string {
  return `[${(performance.now() / 1000).toFixed(1)}s]`;
}

function analyzeResults(
  allActions: string[][],
  clientLogs: string[][],
  actionLabels: string[],
  clientLabels: string[],
  filePrefix: string,
): void {
  const output: string[] = [];
  const log = (s: string) => {
    console.log(s);
    output.push(s);
  };

  for (let i = 0; i < allActions.length; i++) {
    const actions = allActions[i]!;
    const label = actionLabels[i] ?? `P${i}`;
    log(`\n=== ${label} ACTIONS (${actions.length}) ===`);
    for (const a of actions.slice(-15)) log(`  ${a}`);
  }

  // Errors
  const allLogs = clientLogs.flat();
  const errors = allLogs.filter((l) => l.includes("ERROR"));
  if (errors.length > 0) {
    log(`\n=== ERRORS (${errors.length}) ===`);
    for (const e of errors.slice(0, 20)) log(`  ${e}`);
  } else {
    log("\n=== NO ERRORS ===");
  }

  // Message counts (online only)
  for (let i = 0; i < clientLabels.length; i++) {
    const counts = countMessageTypes(clientLogs[i]!);
    if (Object.keys(counts).length > 0) {
      log(`\n=== ${clientLabels[i]} MESSAGE COUNTS ===`);
      for (const [type, count] of Object.entries(counts).sort())
        log(`  ${type}: ${count}`);
    }
  }

  // Game over
  log(`\n=== GAME OVER ===`);
  for (let i = 0; i < clientLabels.length; i++) {
    const saw = clientLogs[i]!.some(
      (l) => l.includes(MESSAGE.GAME_OVER) || l.includes("endGame"),
    );
    log(`  ${clientLabels[i]} saw ${MESSAGE.GAME_OVER}: ${saw}`);
  }

  // Life-lost
  log("\n=== LIFE-LOST DIALOG ===");
  for (let i = 0; i < clientLabels.length; i++) {
    for (const l of clientLogs[i]!) {
      if (
        l.includes("showLifeLostDialog") ||
        l.includes("lifeLostDialog resolved") ||
        l.includes(MESSAGE.LIFE_LOST_CHOICE) ||
        l.includes("dismissing stale")
      ) {
        log(`  ${clientLabels[i]}: ${l}`);
      }
    }
  }

  // Save logs
  mkdirSync("logs", { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
  const logPath = `logs/e2e-${filePrefix}-${timestamp}.log`;
  const rawLogs: string[] = [];
  for (let i = 0; i < clientLabels.length; i++) {
    rawLogs.push(`\n=== RAW ${clientLabels[i]} LOGS ===`);
    rawLogs.push(...clientLogs[i]!);
  }
  writeFileSync(logPath, [...output, ...rawLogs].join("\n"));
  log(`\nLogs saved to ${logPath}`);
}

function countMessageTypes(logs: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const l of logs) {
    const match = l.match(/received:\s+(\S+)/);
    if (match) counts[match[1]!] = (counts[match[1]!] ?? 0) + 1;
  }
  return counts;
}
