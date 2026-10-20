/**
 * Screen overlay builders — options, controls, lobby.
 *
 * Pure functions that take a UIContext and return RenderOverlay data.
 * Consumed by subsystems via DI (composition root injects these).
 */

import type { UIContext } from "../runtime/ui-contracts.ts";
import { cannonTier } from "../shared/core/cannon-tier.ts";
import { GAME_MODE_MODERN } from "../shared/core/game-constants.ts";
import type { GameMap } from "../shared/core/geometry-types.ts";
import type { KeyBindings } from "../shared/core/input-action.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import { IS_TOUCH_DEVICE, KEY_UP } from "../shared/platform/platform.ts";
import type { OptionEntry, RenderOverlay } from "../shared/ui/overlay-types.ts";
import {
  ACTION_KEYS,
  getPlayerColor,
  PLAYER_NAMES,
  SEED_CUSTOM,
} from "../shared/ui/player-config.ts";
import {
  CANNON_HP_OPTIONS,
  DIFFICULTY_LABELS,
  DPAD_LABELS,
  GAME_MODE_LABELS,
  HAPTICS_LABELS,
  OPT_CANNON_HP,
  OPT_CONTROLS,
  OPT_DIFFICULTY,
  OPT_DPAD,
  OPT_GAME_MODE,
  OPT_HAPTICS,
  OPT_ROUNDS,
  OPT_SEED,
  OPT_SOUND,
  OPTION_NAMES,
  ROUNDS_OPTIONS,
} from "../shared/ui/settings-defs.ts";
import { formatKeyName } from "../shared/ui/settings-ui.ts";

const CONTROL_ACTION_NAMES: readonly string[] = [
  "Up",
  "Down",
  "Left",
  "Right",
  "Confirm",
  "Rotate",
];

export function createOptionsOverlay(frameCtx: UIContext): {
  map: GameMap;
  overlay: RenderOverlay;
} {
  const lobbyMap = frameCtx.lobby.map!;
  const readOnly = frameCtx.getOptionsContext().kind === "gameplay";
  const visible = visibleOptions(frameCtx);
  const options: OptionEntry[] = visible.map((i) => {
    // Seed is typed, Controls opens a sub-screen — no left/right cycling.
    // Sound is editable: arrows toggle on/off when assets are loaded, or
    // open the Sound modal when they aren't (handled in changeOption).
    if (i === OPT_SEED || i === OPT_CONTROLS)
      return {
        name: OPTION_NAMES[i]!,
        value: optionValue(frameCtx, i),
        editable: false,
      };
    // Online: Rounds, Cannon HP, Game Mode are locked by room host
    if (
      frameCtx.isOnline &&
      (i === OPT_ROUNDS || i === OPT_CANNON_HP || i === OPT_GAME_MODE)
    )
      return {
        name: OPTION_NAMES[i]!,
        value: optionValue(frameCtx, i),
        editable: false,
      };
    // In-game: Difficulty, Cannon HP, Game Mode are locked
    if (
      readOnly &&
      (i === OPT_DIFFICULTY || i === OPT_CANNON_HP || i === OPT_GAME_MODE)
    )
      return {
        name: OPTION_NAMES[i]!,
        value: optionValue(frameCtx, i),
        editable: false,
      };
    return {
      name: OPTION_NAMES[i]!,
      value: optionValue(frameCtx, i),
      editable: true,
    };
  });
  const state = frameCtx.getState();
  const castles = state
    ? state.players
        .filter((player) => player.castleWallTiles.size > 0)
        .map((player) => ({
          walls: player.walls,
          interior: player.interior,
          cannons: player.cannons,
          playerId: player.id,
          cannonTier: cannonTier(player),
        }))
    : undefined;
  const overlay: RenderOverlay = {
    selection: { highlighted: null, selected: null },
    castles,
    entities: state
      ? {
          towerAlive: state.towerAlive,
          burningPits: state.burningPits,
        }
      : undefined,
    ui: {
      optionsScreen: {
        options,
        cursor: frameCtx.optionsCursor.value,
        readOnly,
      },
    },
  };
  return { map: state?.map ?? lobbyMap, overlay };
}

export function createControlsOverlay(frameCtx: UIContext): {
  map: GameMap;
  overlay: RenderOverlay;
} {
  const lobbyMap = frameCtx.lobby.map!;
  const controlsState = frameCtx.controlsState;
  const playerCount = IS_TOUCH_DEVICE ? 1 : PLAYER_NAMES.length;
  const players = PLAYER_NAMES.slice(0, playerCount).map((name, player) => {
    const keyBinding = frameCtx.settings.keyBindings[player]!;
    return {
      name: name!,
      color: getPlayerColor(player as ValidPlayerId).wall,
      bindings: ACTION_KEYS.map((key) => formatKeyName(keyBinding[key])),
    };
  });
  const overlay: RenderOverlay = {
    selection: { highlighted: null, selected: null },
    ui: {
      controlsScreen: {
        players,
        playerIdx: controlsState.playerIdx,
        actionIdx: controlsState.actionIdx,
        rebinding: controlsState.rebinding,
        actionNames: CONTROL_ACTION_NAMES,
      },
    },
  };
  return { map: frameCtx.getState()?.map ?? lobbyMap, overlay };
}

export function createLobbyOverlay(frameCtx: UIContext): {
  map: GameMap;
  overlay: RenderOverlay;
} {
  const remaining = Math.max(0, frameCtx.getLobbyRemaining());
  const overlay: RenderOverlay = {
    selection: { highlighted: null, selected: null },
    ui: {
      lobby: {
        players: PLAYER_NAMES.slice(0, frameCtx.lobby.joined.length).map(
          (name, i) => ({
            name: `${name} Player`,
            color: getPlayerColor(i as ValidPlayerId).wall,
            joined: frameCtx.lobby.joined[i]!,
            keyHint: frameCtx.settings.keyBindings[i]
              ? formatKeyHint(frameCtx.settings.keyBindings[i])
              : undefined,
          }),
        ),
        timer: remaining,
      },
    },
  };
  // The lobby always renders its own preview map. `state.map` is alive after
  // the first game ends (`stateInstalled` is sticky-once and never resets) and
  // would otherwise shadow the freshly-regenerated lobby map with the just-
  // played game's mutated tiles (sinkholes, high-tide flips, spawned houses).
  return { map: frameCtx.lobby.map!, overlay };
}

export function visibleOptions(frameCtx: UIContext): number[] {
  if (frameCtx.isOnline)
    return IS_TOUCH_DEVICE
      ? [
          OPT_ROUNDS,
          OPT_CANNON_HP,
          OPT_GAME_MODE,
          OPT_HAPTICS,
          OPT_SEED,
          OPT_CONTROLS,
          OPT_DPAD,
          OPT_SOUND,
        ]
      : [
          OPT_ROUNDS,
          OPT_CANNON_HP,
          OPT_GAME_MODE,
          OPT_SEED,
          OPT_CONTROLS,
          OPT_SOUND,
        ];
  return IS_TOUCH_DEVICE
    ? [
        OPT_DIFFICULTY,
        OPT_ROUNDS,
        OPT_CANNON_HP,
        OPT_GAME_MODE,
        OPT_HAPTICS,
        OPT_SEED,
        OPT_CONTROLS,
        OPT_DPAD,
        OPT_SOUND,
      ]
    : [
        OPT_DIFFICULTY,
        OPT_ROUNDS,
        OPT_CANNON_HP,
        OPT_GAME_MODE,
        OPT_SEED,
        OPT_CONTROLS,
        OPT_SOUND,
      ];
}

function optionValue(frameCtx: UIContext, idx: number): string {
  const settings = frameCtx.settings;
  const state = frameCtx.getState();
  switch (idx) {
    case OPT_DIFFICULTY:
      return DIFFICULTY_LABELS[settings.difficulty]!;
    case OPT_ROUNDS: {
      const opt = ROUNDS_OPTIONS[settings.rounds]!;
      if (frameCtx.getOptionsContext().kind === "gameplay" && state) {
        return `${opt.label} (round ${state.round})`;
      }
      return opt.label;
    }
    case OPT_CANNON_HP:
      return CANNON_HP_OPTIONS[settings.cannonHp]!.label;
    case OPT_HAPTICS:
      return HAPTICS_LABELS[settings.haptics] ?? "Off";
    case OPT_SEED: {
      if (frameCtx.isOnline) {
        const display = frameCtx.lobby.roomSeedDisplay;
        return display === null ? "—" : String(display);
      }
      if (frameCtx.getOptionsContext().kind === "gameplay" && state) {
        return String(state.rng.seed);
      }
      return settings.seedMode === SEED_CUSTOM
        ? settings.seed || "_"
        : "Random";
    }
    case OPT_DPAD:
      return DPAD_LABELS[settings.leftHanded ? 1 : 0]!;
    case OPT_GAME_MODE:
      return GAME_MODE_LABELS[settings.gameMode === GAME_MODE_MODERN ? 1 : 0]!;
    case OPT_SOUND:
      if (!frameCtx.getSoundReady()) return "Off";
      return settings.soundEnabled ? "On" : "Off";
    default:
      return "";
  }
}

/** Format a key binding as a short hint string (e.g. "Arrows + N (B rotate)"). */
function formatKeyHint(keyBindings: KeyBindings): string {
  const arrows =
    keyBindings.up === KEY_UP
      ? "Arrows"
      : keyBindings.up.toUpperCase() +
        keyBindings.left.toUpperCase() +
        keyBindings.down.toUpperCase() +
        keyBindings.right.toUpperCase();
  return `${arrows} + ${keyBindings.confirm.toUpperCase()} (${keyBindings.rotate.toUpperCase()} rotate)`;
}
