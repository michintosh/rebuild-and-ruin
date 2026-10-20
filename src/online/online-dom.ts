/**
 * Centralized DOM acquisition for the online runtime — a single, explicit
 * boundary so other online modules receive typed element references instead
 * of scattering getElementById calls. No project imports.
 */

// ── Game elements ──────────────────────────────────────────────────

export const canvas = document.getElementById("canvas") as HTMLCanvasElement;
export const worldCanvas = document.getElementById(
  "world-canvas",
) as HTMLCanvasElement;
export const roomCodeOverlay = document.getElementById("room-code-overlay")!;
export const pageOnline = document.getElementById("page-online")!;
// ── Lobby elements ─────────────────────────────────────────────────
export const btnCreateConfirm = document.getElementById("btn-create-confirm")!;
export const btnJoinConfirm = document.getElementById("btn-join-confirm")!;
export const createRounds = document.getElementById(
  "create-rounds",
) as HTMLSelectElement;
export const createHp = document.getElementById(
  "create-hp",
) as HTMLSelectElement;
export const createWait = document.getElementById(
  "create-wait",
) as HTMLSelectElement;
export const createGameMode = document.getElementById(
  "create-game-mode",
) as HTMLSelectElement;
export const createPlayerCount = document.getElementById(
  "create-player-count",
) as HTMLSelectElement;
export const createWebcam = document.getElementById(
  "create-webcam",
) as HTMLSelectElement;
export const createSeed = document.getElementById(
  "create-seed",
) as HTMLInputElement;
export const joinCodeInput = document.getElementById(
  "join-code",
) as HTMLInputElement;
// ── Shared (used by both lobby and deps) ───────────────────────────
export const createError = document.getElementById("create-error")!;
export const joinError = document.getElementById("join-error")!;

/** Show the `<main class="page" data-route="...">` matching `route`,
 *  hide the others. Called by the router on every route change. */
export function setActivePageByRoute(route: string): void {
  for (const element of document.querySelectorAll<HTMLElement>(".page")) {
    element.hidden = element.dataset["route"] !== route;
  }
}
