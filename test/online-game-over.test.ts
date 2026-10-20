/**
 * E2E test: full 1-round online game through the browser + WebSocket relay.
 *
 * Launches a Playwright browser with a host (0 humans, 3 AI) and a watcher.
 * The host creates a 1-round room, the watcher joins. The game runs to
 * completion and the test verifies the watcher received gameOver.
 *
 * Requires: vite dev server (port 5173) + npm run server (port 8001)
 * Run with: deno test --allow-all test/online-game-over.test.ts
 */

import { assert } from "@std/assert";
import { chromium, type Page } from "playwright";
import { MESSAGE } from "../src/protocol/protocol.ts";
import { installFastMode } from "./e2e/fast-mode.ts";
import { waitForPageFn } from "./e2e/helpers.ts";

const PAGE_URL = "http://localhost:5173/?server=localhost:8001";

Deno.test("1-round online game delivers gameOver to watcher via browser", async () => {
  const browser = await chromium.launch({ headless: true });
  const watcherLogs: string[] = [];

  try {
    const hostPage = await (await browser.newContext()).newPage();
    const watcherPage = await (await browser.newContext()).newPage();
    collectLogs(watcherPage, watcherLogs);

    const code = await createRoom(hostPage);
    await joinRoom(watcherPage, code);

    // Wait for host to reach STOPPED (game over)
    await waitForPageFn(
      hostPage,
      () => (globalThis as unknown as Record<string, Record<string, unknown>>).__e2e?.mode === "STOPPED",
      120_000,
    );

    // Poll watcher logs for gameOver — the relay may need a moment to
    // deliver it after the host transitions to STOPPED.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (watcherLogs.some((log) => log.includes(MESSAGE.GAME_OVER))) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const sawGameOver = watcherLogs.some((log) =>
      log.includes(MESSAGE.GAME_OVER),
    );
    assert(sawGameOver, "watcher did not receive gameOver");
  } finally {
    await browser.close();
  }
});

function collectLogs(page: Page, logs: string[]): void {
  page.on("console", (msg) => logs.push(msg.text()));
}

async function createRoom(page: Page): Promise<string> {
  await page.goto(PAGE_URL);
  await installFastMode(page);
  await page.click("#btn-online");
  await page.waitForSelector("#page-online[data-ready]", { timeout: 10000 });
  // 10s wait gives the watcher time to launch its browser context and join
  // before the host auto-sends INIT (which closes the room to new joiners).
  await page.selectOption("#create-wait", "10");
  await page.selectOption("#create-rounds", "1");
  await page.click("#btn-create-confirm");
  await waitForPageFn(
    page,
    () => document.getElementById("page-online")?.hidden === true,
    30000,
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
  await installFastMode(page);
  await page.click("#btn-online");
  await page.waitForSelector("#page-online[data-ready]", { timeout: 10000 });
  await page.fill("#join-code", code);
  await page.click("#btn-join-confirm");
  await waitForPageFn(
    page,
    () => document.getElementById("page-online")?.hidden === true,
    30000,
  );
}
