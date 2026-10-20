---
name: code-review
description: Multi-pass code review and refactoring workflow. Use when the user asks to review code quality, clean up, or refactor.
user-invocable: true
---

# Code Review & Refactoring Workflow

Structured multi-pass review that catches issues in dependency order so each pass builds on a cleaner codebase.

## Passes (run in order)

### Pass 1: Dead code removal
- Unused imports, variables, functions, interfaces, type aliases
- No-op stubs (factories that return empty objects, unused callbacks)
- Commented-out code, unreachable branches
- **Why first:** reduces noise for all subsequent passes

### Pass 2: Hardcoded values
- Magic numbers (sizes, timers, thresholds, percentages)
- Inline font strings, color strings, CSsorruS values
- Repeated literals that should be named constants
- **Why second:** named constants make duplication visible

### Pass 3a: Duplicate code & missing helpers (syntactic)
- Same logic repeated in 2+ places
- Copy-pasted patterns (device detection, coordinate conversion, player ID resolution)
- Inline types / shapes used in multiple places that should be named
- Functions that could be shared but are defined locally in each call site
- **Why third:** easier to spot with constants in place and dead code gone
- **Tool:** `jscpd` catches identical clones; this pass catches near-clones the tool misses

### Pass 3b: Semantic duplication (structural)
- Multiple files independently branching on the same enum (Phase, Mode, CannonMode) to implement the same behavior through different code paths
- Same domain action dispatched via different call chains (e.g., keyboard vs touch implementing the same game action with separate phase/guard checks)
- Parallel dep interfaces in different files that carry the same fields as pass-throughs to the same consumer
- **Detection technique:** find files with high import overlap — if two files both import `Phase`, `isSelectionPhase`, `findNearestTower`, they likely both implement selection logic
- **Fix pattern:** extract a shared dispatch function that both call sites delegate to (like `dispatchGameAction`), or carry shared deps as a sub-object instead of re-declaring fields
- **Why separate from 3a:** jscpd and manual scanning miss this entirely because the code looks different despite doing the same thing
- **Scope per domain:** review one domain cluster at a time (input, rendering, online, phase transitions) — ask a sub-agent to read all files in the cluster and flag where the same responsibility is implemented in multiple places

### Pass 4: Misplaced logic
- Game logic in rendering code (state mutation in render functions)
- Rendering concerns in game runtime (pixel math, font strings, color values)
- Input handlers doing too much (business logic instead of delegation)
- Constants/helpers in the wrong module (increasing coupling)
- **Why fourth:** clearest when duplicates are merged and code is minimal
- **See also:** `/import-hygiene` skill for layer-violation audits (`.import-layers.json`)

### Pass 5: Workarounds & questionable patterns
- Device detection scattered in logic instead of using a shared constant
- Roundtrip conversions (convert A→B→A)
- Side effects in supposedly pure functions
- Fragile implicit dependencies (button position derived from magic arithmetic)
- **Why last:** many get fixed by earlier passes; what remains is genuine

## Automated tooling (run before manual passes)

Before starting manual passes, run the lint toolchain to catch mechanical issues:

```bash
npm run lint:fix          # Biome: auto-fix import sorting & unused imports
npm run lint:unused       # Knip: dead files, unused exports & dependencies
npm run lint:circular     # Madge: circular dependency detection
npm run lint:duplicates   # jscpd: copy-paste / duplicate code detection
npm run lint:literals     # AST-based: repeated string & numeric literals (baseline-aware)
```

Or run everything at once: `npm run lint:all`

- Fix Biome issues first (auto-fixable), then review Knip/Madge/jscpd output
- Knip unused exports feed directly into Pass 1 (dead code)
- jscpd clones feed directly into Pass 3 (duplicate code)
- Madge circular deps feed into Pass 4 (misplaced logic)
- `lint:literals` findings feed into Pass 2 (hardcoded values) — extract to named constants

### Duplicate literals tool

`scripts/find-duplicate-literals.ts` uses the TypeScript compiler API to find repeated string and numeric literals. It maintains a baseline (`.readonly-literals-baseline.json`) so `lint:all` only fails on NEW duplicates.

```bash
npm run lint:literals                          # Default: exit 0 if all findings are baselined
deno run -A scripts/find-duplicate-literals.ts --all                       # Show all findings (informational, exit 0)
deno run -A scripts/find-duplicate-literals.ts --all --files "src/game-*.ts"  # Scoped to specific files (for reviews)
deno run -A scripts/find-duplicate-literals.ts --update-baseline           # Acknowledge current findings as known
```

- **For reviews:** use `--all --files <globs>` to scope — only counts and shows occurrences *within* the specified files (a literal duplicated 20× across the codebase but only 1× in scoped files won't be reported)
- **After fixing duplicates:** run `--update-baseline` to remove fixed entries from baseline
- **For CI/pre-commit:** default mode (no flags) — exits 1 only for new findings not in baseline

### File reorder tool

All `src/*.ts` files are automatically reordered by the pre-commit hook using `scripts/reorder-file.ts` (ts-morph AST tool). The enforced order is:

1. Imports (then re-exports, separated by blank line)
2. Types / interfaces / enums
3. `const` declarations — data and arrow functions, dependency-sorted (non-exported before exported)
4. `function` declarations — topologically sorted callers-first (hoisted, so order is for readability)

**Do not manually reorder top-level statements** — the hook handles it. When writing new code, place declarations anywhere; the tool will sort them on commit. Run manually with `npm run reorder -- <path>` or `npm run reorder:changed` for staged files.

## How to run each pass

1. **Launch a sub-agent** (Explore type) with:
   - The list of files to review (scope to the area of interest)
   - The specific category for this pass
   - Instruction: "report findings only, do NOT edit"

2. **Review findings** — cross-reference with lint tool output, discard false positives, confirm real issues

3. **Fix all issues** from the pass

4. **Build + test** — verify no regressions (`npm run build`, `npm run check:server`, E2E if UI changes)

5. **Commit** the pass as a single commit

6. **Proceed to next pass** — the sub-agent sees the clean state

7. **After fixing all passes, present deferred items** — this step is MANDATORY, do NOT skip it or wait for the user to ask. List every finding that was identified during exploration but excluded from fixes (too low-value, too risky, or borderline). For each item, include: file, line, what's wrong, severity (high/medium/low), and why it was deferred. Ask the user which (if any) they want fixed.

## Sub-agent prompt template

```
Review the following files for [CATEGORY]:
[file list]

Check for:
[specific checklist items from the pass above]

For each finding, report: file, line number, what the code does,
what's wrong, and the suggested fix. Do NOT make any edits.
Be pragmatic — only flag things where the fix genuinely improves
the codebase, not theoretical purity issues.
```

### What to look for specifically
- UI layout/pixel constants in non-rendering modules
- Re-exports that add indirection over canonical sources (prefer importing from the source)
- Constants marked "shared with X" in comments — they should live in the common parent module
- Types defined in a "types" file but only used by one domain

## Tips

- **Scope narrowly** — review 5-10 related files per session, not the whole codebase
- **Commit after each pass** — if something breaks, you know which pass caused it
- **Skip passes that don't apply** — if there's no dead code, go straight to pass 2
- **Don't fix everything** — low-value fixes that risk regressions can be deferred
- **Always run E2E after UI changes** — use `timeout 45 deno run -A scripts/online-e2e.ts local 1 --mobile --headless --action "mode:GAME screenshot:check exit" "" 3`
