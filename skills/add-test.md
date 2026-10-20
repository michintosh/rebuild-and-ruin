---
name: add-test
description: Workflow for authoring a new test — pick a pattern, find a seed, write the test, verify, commit. Use when the user asks to add a test or cover new behavior.
user-invocable: true
---

# Add a test

Follow this end-to-end when adding a new test for gameplay, online, or
UI behavior. The pattern catalogue lives in
[test/patterns.md](../test/patterns.md) — skim it first.

## Step 1: Pick the shape

Match your intent to one of the five shapes in `test/patterns.md`:

1. **State assertion after phase** — invariant holds at a specific point.
2. **Event sequence verification** — ordered/counted bus events.
3. **Counterfactual comparison** — feature toggles produce the expected diff.
4. **Determinism check** — usually adds a fixture, not a new test.
5. **Online parity** — host mode matches local mode for the seed.

If nothing matches, stop and discuss with the user — forcing a new test
into an existing shape often means you're mutating state you shouldn't.

## Step 2: Find a seed that produces the condition

Tests must reach conditions through play, not state mutation (see
`.claude/.../memory/feedback_test_no_hacks.md`). Use
`scripts/find-seed.ts` to search for a seed that produces the condition
you want:

```bash
deno run -A scripts/find-seed.ts --mode classic --predicate "condition-name"
```

If the named predicate doesn't exist, add it to
[test/seed-conditions.ts](../test/seed-conditions.ts) first — a small
function that subscribes to the bus and returns true when the target
state is reached. Then re-run `find-seed.ts`.

Prefer registering the winning seed in the seed registry
(`scripts/record-seeds.ts`) with a descriptive name (e.g.
`SEED_CONDITIONS.walledInTowerRevival`) rather than hardcoding an
integer. This prevents drift when seeds change semantics.

## Step 3: Write the test

Copy the template from `test/patterns.md` matching your shape. Wrap
narrative beats in `step()` so failures point at the specific beat:

```ts
import { step } from "./scenario.ts";

Deno.test("scenario: …", async () => {
  const sc = await createScenario({ seed: loadSeed("walledInTowerRevival"), rounds: 3 });
  await step("reach second build", () => waitForPhase(sc, Phase.WALL_BUILD));
  await step("assert revival", () => {
    const revived = sc.state.players.some((p) => p.towers.some((t) => t.alive));
    assert(revived);
  });
});
```

For E2E tests, never call `page.waitForFunction` directly — use
`waitForPageFn(page, fn, timeoutMs)` from
[test/e2e/helpers.ts](../test/e2e/helpers.ts). Enforced by
`lint:raw-playwright`.

## Step 4: Run it

```bash
npm run test:scenario   # or test:determinism, test:sync, test:input, etc.
```

If E2E: requires `npm run dev` + `npm run server` in
separate terminals. See [CLAUDE.md](../CLAUDE.md) for the full list.

If the test fails, use the [/debug](./debug.md) skill — logs, analysis
script, evidence-driven fix. **Never** relax the assertion to make a
failing test pass; the test is the spec.

## Step 5: Pre-commit + commit

The pre-commit hook runs the full lint suite including:
- `lint:test-timeouts` — bans `maxTicks` / `maxFrames`, enforces `{ timeoutMs }`.
- `lint:raw-playwright` — bans raw `page.waitForFunction(` outside
  `test/e2e/helpers.ts`.
- `lint:literals` — flags new repeated literals.

Fix violations before the hook fails.

## Anti-patterns (will be rejected on review)

- Mutating `sc.state` directly (`state.phase = X`).
- Constructing subsystems standalone (`new PhaseSetup(...)`).
- Tick/frame-count timeouts.
- Catch-and-ignore assertions.
- Re-recording determinism fixtures without justifying the event-log delta.

## See also

- [test/patterns.md](../test/patterns.md) — the shape catalogue with templates.
- [skills/debug.md](./debug.md) — when the test fails unexpectedly.
- [skills/debug-e2e.md](./debug-e2e.md) — E2E-specific debugging.
