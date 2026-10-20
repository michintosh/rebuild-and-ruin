/**
 * Application entry point — SPA router, fullscreen, auto-join, service worker.
 *
 * Hash-based routing (`#/`, `#/online`, `#/play`) with native back button support.
 * Route handlers load game modules on demand; game-exit cleanup runs when
 * the router navigates away from an active game.
 */

import "./style.css";
import { DEFAULT_SERVER_HOST } from "./online/online-config.ts";
import {
  GAME_CONTAINER_ACTIVE,
  GAME_EXIT_EVENT,
  initRouter,
  navigateTo,
  onRoute,
} from "./online/online-router.ts";
import { ROUTE_HOME, ROUTE_ONLINE, ROUTE_PLAY } from "./protocol/routes.ts";
import { GRID_PORTRAIT_LAUNCHED } from "./shared/core/grid.ts";
import { IS_TOUCH_DEVICE } from "./shared/platform/platform.ts";

const SERVER_STORAGE_KEY = "castles99_server";
const CLICK_EVENT = "click";
const gameContainer = document.getElementById("game-container")!;
const serverHostInput = document.getElementById(
  "server-host",
) as HTMLInputElement;
const params = new URLSearchParams(location.search);
const autoJoinCode = params.get("join");
// Lock orientation on mobile (best-effort, silently ignored if unsupported).
// Locks to whichever orientation the game booted in: a portrait boot pins
// the grid axes to 28×44, so we want to keep the screen in portrait too.
// When the lock isn't honoured AND we booted in portrait, GRID_PORTRAIT_LAUNCHED
// has already flipped the grid axes; tag the body so the CSS layout stays in
// portrait mode even if the device is physically rotated (a landscape boot
// that later rotates still gets the orientation-driven portrait CSS via
// `is-portrait` below — `portrait-launched` only fires on the boot path).
const targetOrientation = GRID_PORTRAIT_LAUNCHED ? "portrait" : "landscape";
// `is-portrait` drives the portrait layout. It's the union of "we're
// currently in portrait orientation" and "we booted in portrait" — the
// second clause keeps the layout pinned even if the device rotates while
// the orientation lock isn't honoured (same platforms where the lock
// silently fails are the ones that allow the unwanted rotation).
const portraitMQ = matchMedia("(orientation: portrait)");

// Flips to true when the user clicks "Local Play" — the click both activates
// the AudioContext (needs a user gesture) and enters #/play. A direct hit on
// `/#play` (bookmark, reload, shared link) would bypass that gesture, so we
// redirect those visits to the home page.
let userInitiatedPlay = false;
// The two game modules each build a full runtime — a THREE.WebGLRenderer on
// the shared #canvas/#world-canvas stack, a perpetual RAF loop, document
// listeners — as a module-level side effect of first import, and everything
// downstream (composition.ts, online/runtime/game.ts) assumes one
// composition per page lifetime. Importing BOTH in one page session would
// put two renderers with independent GL-state caches on one context and
// leave two frame loops running. Track which module is resident; switching
// to the other game route reloads the page instead of importing a second
// runtime.
let loadedGameModule: "local" | "online" | undefined;

if (GRID_PORTRAIT_LAUNCHED) {
  document.body.classList.add("portrait-launched");
}

try {
  (
    screen.orientation as {
      lock?: (orientation: string) => Promise<void>;
    }
  )
    ?.lock?.(targetOrientation)
    .catch(() => {});
} catch {
  /* unsupported */
}

syncIsPortrait();

portraitMQ.addEventListener("change", syncIsPortrait);

function syncIsPortrait(): void {
  document.body.classList.toggle(
    "is-portrait",
    GRID_PORTRAIT_LAUNCHED || portraitMQ.matches,
  );
}

// --- Route handlers ---
onRoute(ROUTE_ONLINE, () => {
  if (loadedGameModule === "local") {
    // The local runtime is resident — reload; the fresh page boots straight
    // into #/online (this route supports direct entry).
    location.reload();
    return;
  }
  exitGameIfActive();
  serverHostInput.value =
    localStorage.getItem(SERVER_STORAGE_KEY) || DEFAULT_SERVER_HOST;
  void importOnline();
});

onRoute(ROUTE_PLAY, () => {
  if (loadedGameModule === "online") {
    // The online runtime is resident — reload; the direct-entry guard below
    // then bounces the fresh page to home, where the player re-clicks
    // "Local Play" (a reload can't preserve the audio-unlock gesture anyway).
    location.reload();
    return;
  }
  if (!userInitiatedPlay) {
    // Direct entry (bookmark, reload, shared link) — bounce back home so the
    // visitor has to click "Local Play", which is the only place we get a user
    // gesture to unlock the AudioContext before music boot.
    navigateTo(ROUTE_HOME, true);
    return;
  }
  userInitiatedPlay = false; // consume; require a fresh gesture on the next entry
  tryFullscreen(); // works when navigated via user gesture; silently fails on bookmark
  // Fallback: first tap on any game UI button triggers fullscreen
  gameContainer.addEventListener(CLICK_EVENT, () => tryFullscreen(), {
    once: true,
    capture: true,
  });
  void importLocal().then((module) => module.enterLocalLobby());
});

onRoute(ROUTE_HOME, () => {
  exitGameIfActive();
});

initRouter();

// --- Navigation handlers ---
document.getElementById("btn-local")!.addEventListener(CLICK_EVENT, () => {
  tryFullscreen();
  // Kick off the music sub-system's audio/WASM boot inside this user-gesture
  // window — once the dynamic import resolves the gesture is stale for
  // AudioContext.resume(). Safe to call even if no Rampart files are in IDB
  // (subsystem no-ops). Fire-and-forget: audio is optional, never block nav.
  // Skipped when the online runtime is resident: the route handler is about
  // to reload the page, and importing main.ts here would construct the very
  // second runtime the reload exists to prevent.
  if (loadedGameModule !== "online") {
    void importLocal().then((module) => module.activateMusic());
  }
  userInitiatedPlay = true;
  navigateTo(ROUTE_PLAY);
});

document.getElementById("btn-online")!.addEventListener(CLICK_EVENT, () => {
  activateOnlineAudio();
  navigateTo(ROUTE_ONLINE);
});

// Persist server host
serverHostInput.addEventListener("change", () => {
  const val = serverHostInput.value.trim();
  if (val) localStorage.setItem(SERVER_STORAGE_KEY, val);
  else localStorage.removeItem(SERVER_STORAGE_KEY);
});

// Fullscreen + audio boot on Create/Join confirm (needs user gesture — click for mobile compat)
document
  .getElementById("btn-create-confirm")!
  .addEventListener(CLICK_EVENT, () => {
    tryFullscreen();
    activateOnlineAudio();
  });

document
  .getElementById("btn-join-confirm")!
  .addEventListener(CLICK_EVENT, () => {
    tryFullscreen();
    activateOnlineAudio();
  });

// --- Auto-join via QR code: ?join=XXXX&server=host ---
// Skip in portrait-launched mode — the grid is 28×44 and would desync from a
// landscape host's 44×28 wire format. The user lands on the home page (which
// hides the "Play Online" button via CSS in this mode) instead.
if (autoJoinCode && !GRID_PORTRAIT_LAUNCHED) {
  tryFullscreen(); // call synchronously — QR tap navigation preserves user activation
  activateOnlineAudio();
  void (async () => {
    navigateTo(ROUTE_ONLINE, true);
    const { lobbyReady } = await importOnline();
    const { joinRoom } = await lobbyReady;
    joinRoom(autoJoinCode.toUpperCase());
  })();
}

// Kick off audio boot inside the click's user-gesture window — same rationale
// as btn-local's activateMusic call. online-client.ts lazy-loads the online
// runtime; once resolved, activateAudio warms the music synth + SFX context.
// Wired to every online entry point (create, join, QR auto-join) as a
// belt-and-suspenders: any of them is a fresh gesture the browser accepts
// for AudioContext.resume().
function activateOnlineAudio(): void {
  // Same guard as btn-local's activateMusic: with the local runtime
  // resident, the #/online route handler reloads the page — don't construct
  // a second runtime inside this gesture window first.
  if (loadedGameModule === "local") return;
  void importOnline().then((module) => module.activateAudio());
}

/** Single import sites for the two game modules — they record which runtime
 *  is resident so the route handlers can reload instead of double-importing. */
function importLocal() {
  loadedGameModule = "local";
  return import("./main.ts");
}

function importOnline() {
  loadedGameModule = "online";
  return import("./online-client.ts");
}

/** Hide the game container and notify game modules to clean up. */
function exitGameIfActive(): void {
  if (gameContainer.classList.contains(GAME_CONTAINER_ACTIVE)) {
    gameContainer.classList.remove(GAME_CONTAINER_ACTIVE);
    document.dispatchEvent(new Event(GAME_EXIT_EVENT));
  }
}

/** Request fullscreen + wake lock + orientation lock on mobile (must be called
 *  from a user gesture handler). Orientation lock is chained AFTER fullscreen
 *  resolves: Chrome (and most engines) reject `screen.orientation.lock()`
 *  unless the document is fullscreen, so the boot-time attempt on the home
 *  page silently fails. The chain here is the only path that actually pins
 *  the orientation. */
function tryFullscreen(): void {
  if (!IS_TOUCH_DEVICE) return;
  // @ts-ignore — import.meta.env is Vite-specific (not recognized by Deno LSP)
  if (import.meta.env?.DEV) return; // skip Vite dev server; preview is a prod build
  document.documentElement
    .requestFullscreen?.()
    .then(() => {
      (
        screen.orientation as {
          lock?: (orientation: string) => Promise<void>;
        }
      )
        ?.lock?.(targetOrientation)
        .catch(() => {});
    })
    .catch(() => {});
  navigator.wakeLock.request?.("screen").catch(() => {});
}

// @ts-ignore — import.meta.env is Vite-specific (not recognized by Deno LSP)
if ("serviceWorker" in navigator && !import.meta.env?.DEV) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
