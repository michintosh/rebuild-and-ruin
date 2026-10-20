---
name: import-hygiene
description: Audit and fix the module import hierarchy using the layer linter. Use when the user asks to check import direction, layer violations, or module placement.
user-invocable: true
---

# Import Hierarchy Audit & Fix

Systematic workflow for finding and fixing imports that violate the module hierarchy — types defined in the wrong file, lower layers reaching into higher layers, peer modules with unnecessary directional dependencies.

## When to use

- After extracting a new module or splitting a file
- Periodically as the codebase grows
- When madge shows no circular deps but the import graph still "feels wrong"

## Tooling

### `scripts/generate-import-layers.ts`

AST-based tool (ts-morph) that parses every `.ts` file, builds the full import graph, and either generates or lints the layer map.

```bash
# Generate — compute layers from import graph, write .import-layers.json
deno run -A scripts/generate-import-layers.ts

# Lint — check actual imports against intended layers in .import-layers.json
deno run -A scripts/generate-import-layers.ts --check
```

| Flag | Description |
|---|---|
| (default) | Compute layers from the import graph and write `.import-layers.json` |
| `--check` | Lint mode: read `.import-layers.json` as intended layers, report upward violations, exit 1 if any found |
| `--print` | Print the layer map to stdout without writing to disk |
| `--server` | Include `server/` files in the analysis |

**How layers are computed (default mode):**
Each file's layer = 1 + max(layer of its dependencies), with leaf files at layer 0. This gives the finest-grained layering (one group per depth level). The result has 0 violations by definition — it reflects what the code actually does, not what you intend.

**How --check works:**
Reads `.import-layers.json`, then for every import in the source, checks whether the importing file's intended layer is lower than the dependency's. Output shows group names and distinguishes type-only vs runtime imports:

```
✘ 2 layer violation(s) found:

  src/render-types.ts [core types & systems] → src/game-ui-types.ts [game UI] (type-only)
  src/runtime-host-battle-ticks.ts [runtime] → src/online-send-actions.ts [assembly]
```

### `.import-layers.json`

The layer map file. Committed to the repo. An array of named groups — position in the array = layer number (0 = bottom, higher = closer to entry points). Each group has `name`, `tier`, and `files` fields.

**Rule: imports must flow downward.** A file in group N can import from any group 0..N. Importing from group N+1 or higher is a violation.

**Current architecture:** See `.import-layers.json` for the full layer map (group names, tier assignments, file lists). See `.domain-boundaries.json` for domain membership and allowed cross-domain imports.

Groups are named by role/abstraction level, not by domain — files from any domain land at the layer dictated by their deepest import. Each group has a `tier` field for quick orientation: **types** (L0–L4) → **logic** (L5–L6) → **systems** (L7–L9) → **assembly** (L10–L13) → **roots** (L14–L17).

When a new file is added but not yet in `.import-layers.json`, `--check` warns and treats it as layer 0 (maximally strict). Regenerate to pick up new files, then move them to the right group.

## Workflow

The workflow has two phases: first make the layer map match reality (compute → name → group by domain), then make reality match the ideal (find violations → fix code → iterate).

### Phase A — Build the layer map

#### Step A1 — Generate computed layers

```bash
deno run -A scripts/generate-import-layers.ts
```

This gives fine-grained layers (one per depth level, typically 15–17 groups). It always passes `--check` because the layers are computed from the actual imports.

#### Step A2 — Name the groups and assign tiers

Give every group a meaningful name and a `tier` in `.import-layers.json`. **Naming groups reveals misplacements.** When a file's domain doesn't match its group name, something is pulling it to the wrong depth. Assign one of: `types`, `logic`, `systems`, `assembly`, `roots`.

#### Step A3 — Reorganize by domain

Merge the fine-grained computed layers into coarser domain-based groups. Key principles:

- **Group by domain, not by depth.** All `render-*` files belong together even if their computed depths differ. All `online-*` together, all `ai-*` together, etc.
- **Co-dependent peers belong in one group.** If two modules import from each other (or share types bidirectionally), they're peers — merge them rather than forcing a hierarchy. Example: `game-ui-types` and `render-types` share overlay types, so they're in the same "UI & render" group.
- **Wiring modules go high.** Files like `game-bootstrap` that connect systems + controllers + UI are wiring — they belong in "runtime", not "game systems".
- **Interface splits unlock domain grouping.** When a file mixes pure types and implementation (e.g., `controller-types.ts` had both `PlayerController` interface and `BaseController` class), splitting them lets the interfaces drop to a low layer and the implementation stay with its domain.
- **Order groups by dependency direction.** Lower groups are foundations, higher groups are consumers. Verify by asking: "can everything in group N work without group N+1?" If yes, the order is correct.

#### Step A4 — Validate

```bash
deno run -A scripts/generate-import-layers.ts --check
```

The domain-based grouping will likely surface violations — these are the real architectural issues to fix.

### Phase B — Fix violations

#### Step B1 — Classify each violation

For each violation, trace the import and classify:

| Category | Example | Action |
|---|---|---|
| Type in wrong file | `render-types → game-ui-types` for `GameOverOverlay` | Move the type to the lower file |
| Function in wrong file | `render-effects → render-ui` for `drawShadowText` | Move the function to the lower file |
| Peer dependency on shared utils | `runtime-host-battle-ticks → runtime-host-phase-ticks` for `localActiveControllers` | Extract to a new shared module (e.g., `tick-context.ts`) |
| Import through middleman | `phase-ticks → online-serialize` for `SerializedPlayer` | Re-path to canonical source (`src/protocol/protocol.ts`) |
| Dead re-export | `export type { X } from "..."` with no consumers | Remove (run `knip` to find) |
| Interface mixed with impl | `controller-types.ts` has both interfaces and class | Split into `*-interfaces.ts` (pure types) + implementation file |
| Co-dependent peers | `game-ui-types ↔ render-types` | Merge into one group |
| Structural coupling | `game-bootstrap → game-ui-types` (wiring) | Move the wiring file to a higher group |

#### Step B2 — Fix (one move at a time)

1. **Add** the type/function to its new home (preserve JSDoc)
2. **Remove** from the old location
3. **Update all import sites** — use Grep to find every consumer
4. **Merge duplicate imports** — if a file already imports from the target module, merge
5. **Clean up unused imports** in the source file
6. If the moved item was used internally in the source file, add an import from the new location

#### Step B3 — Verify

```bash
npx tsc --noEmit                                       # type-check browser code
npm run check:server                            # type-check server code
npm run lint:all                                       # biome + knip + madge + jscpd + literals + layers + imports
deno run -A scripts/audit-imports.ts --check               # re-exports, duplicate names, layer misuse
npm run test:scenario                                       # headless game test
```

All must pass before moving to the next fix.

#### Step B4 — Re-review

Re-run `--check`. Fixes cascade — a file that dropped a layer may reveal new violations in its consumers. Keep fixing until clean, or until remaining violations are all structural.

#### Step B5 — Squeeze

After the main fixes, look for mechanical tightening:

- **Dead re-exports** — after re-pathing, the old `export type { X } from "..."` may be unused. `knip` catches these.
- **Middleman imports** — a file imports `X` from `middle.ts` which re-exports from `source.ts`. Import directly from `source.ts`.
- **`import type` targeting a higher module** — when the same type is available from a lower one.

#### Step B6 — Finalize the layer map

Regenerate to capture the new computed depths, then re-apply domain grouping and update group names and tiers. Verify `--check` passes. If a group moved across a tier boundary (e.g., from logic to systems), update its `tier` field.

## Tips

- **Cascade effect** — moving types from a widely-imported high-level file to a low-level one cascades: every consumer drops too. Prioritize these moves for maximum impact.
- **Naming is the analysis.** The computed layers are just raw depth numbers. The real insight comes from naming the groups and asking "does this file belong here?"
- **Type-only imports** (`import type`) have no runtime cost but still widen the dependency graph — fix them.
- **Don't move types coupled to their implementation** — a return type used only by its producing function belongs next to it.
- **Shared types used by 3+ modules** belong in a dedicated types file.
- **One fix per todo item** — mark complete before starting the next.
- **Run lint:all after every batch** — biome catches import sorting, knip catches unused exports, madge catches cycles.
- **Know when to stop** — once remaining violations trace to a single structural root (e.g., a file mixing types and implementation), consider splitting that file. If the split is clean (pure interfaces vs class), do it. If it requires deep rewiring, defer to a dedicated refactor plan.
