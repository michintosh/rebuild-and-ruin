# Rebuild & Ruin

A web-based multiplayer remake of Rampart (1990). Build castles, place cannons, and destroy your opponents in tournament-style rounds.

## Play

Play the game online at **[gildas-lormeau.github.io/rebuild-and-ruin](https://gildas-lormeau.github.io/rebuild-and-ruin/)**

## Build

```
npm install
npm run build
```

## Run locally

```
npm run dev
```

Open `http://localhost:5173/` and choose **Local** for offline play (vs AI) or **Online** to host/join a game.

## Online multiplayer

Start the relay server:

```
npm run server
```

The server listens on port 8001. Players connect via the Online lobby. The server is a pure WebSocket relay; all game logic runs on the host client.

For production, run `server/server.ts` on any Node host (`npm run server`, honours `PORT`) and the static site to GitHub Pages.

## Game Rules

See [game-rules.md](game-rules.md) for the complete rules: phases, scoring, AI players, online multiplayer.

## Test

```
deno run test/headless.test.ts                          # game logic invariants
deno run -A scripts/online-e2e.ts local                  # local play, 3 AI
deno run -A scripts/online-e2e.ts online 2               # online, 2 humans + watcher (needs server + dev)
deno run -A scripts/online-e2e.ts online 1 https://...   # online with remote server
```
