# 13 — Extract the round prompt and the guardrail verdict from the driver module

**Type:** implementation
**Status:** resolved

**What it delivers:** the continuation loop's two shared pieces live in a new
`src/round-policy.ts`, transport-free and owned by neither entry point.
`src/tui.tsx` imports them from there instead of from the driver. Nothing about
behaviour changes.

**Blocked by:** None — can start immediately.

## Acceptance criteria

- [x] The round prompt's rendering and the guardrail verdict are each reachable
      without importing the autonomous driver.
- [x] The human command plane imports neither of them from the driver module.
- [x] No observable behaviour changes: the recorded round prompt text and every
      guardrail verdict are byte-identical before and after.
- [x] The existing tests covering the prompt text and the guardrail verdict pass
      unmodified — they move, they do not change.
- [x] Definable that ticket 15, which closes ticket 12's first drift, builds on this.

## Outcome

**71 pre-existing tests pass; 11 new tests pass; `tsc --noEmit` clean; 82 total.**

Proof of the byte-identity criterion was taken two ways, deliberately redundant:

1. **Verbatim move.** Both function bodies were extracted from
   `git show HEAD:src/driver.ts` and from `src/round-policy.ts` and diffed as
   strings. `renderGoalRoundPrompt` and `goalBlockReason` are both **IDENTICAL**
   — the move changed their address and nothing else.
2. **Golden text pinned as a test.** The one prompt-rendering test that existed
   (a `toContain` triple) became an exact-equality assertion against a
   `GOLDEN_PROMPT` constant, so a reworded rule can no longer pass unnoticed. The
   old test is kept too, so both the loose and the strict pin exist.

The moved block was a whole `describe` in `test/driver.test.ts`; it now lives in
`test/round-policy.test.ts` next to the code it covers.

## Tests added beyond the move

The guardrail verdict had **no direct test at all** before this ticket — only the
coverage it got incidentally through driver tests. In its new home it has ten:
the prompt in three render states (unbudgeted round 1 and 2, budgeted round 3,
plus a check that the budget clause appears on exactly one line and never as
`budget 0/N`), and every branch of the verdict — admitted, no-progress at two vs
three rounds, no-progress on empty output, round cap at and below the limit, a
token budget at and below it, `0` meaning unlimited, and both precedence orders
(no-progress over round cap, round cap over budget).

## Defect found while writing those tests — not fixed here

`GoalStore.addUsage` stores into an in-memory overlay that it **overwrites**
rather than accumulates:

```ts
addUsage(usage: Partial<GoalUsage>): void {
  const goal = this.state.goal
  if (goal === undefined) return
  const current = goal.usage          // always the durable usage, never the overlay
  const next: GoalUsage = { inputTokens: current.inputTokens + (usage.inputTokens ?? 0), ... }
  this.usageOverlay = next            // replaces whatever overlay was there
}
```

So a second `addUsage` call discards the first call's delta. The driver happens
to be safe today because it calls `addUsage` at most once per finished turn, and
it accumulates locally across a turn's messages before that single call.

**This is a live defect, not a latent one:** the fold in ticket 14 runs per step,
so it will call `addUsage` several times per turn, and on the first turn with more
than one step it will silently under-count. Fix recorded as the first criterion of
ticket 14 — the overlay must read `this.currentUsage()` rather than `goal.usage`.
The two budget tests here deliberately reach the threshold in a single call so
they assert the guardrail without depending on that fix.

## Why the tests matter more than the move

The move is mechanical. What the ticket bought is that the guardrail verdict is
now tested where it lives, which is what surfaced the `addUsage` defect a week
before ticket 14 was going to trip over it.
