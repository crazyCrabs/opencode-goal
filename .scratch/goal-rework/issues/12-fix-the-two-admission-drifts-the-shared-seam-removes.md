# Fix the two admission drifts the shared seam removes

Type: task
Status: resolved
Blocked by: — (lands with the implementation effort)

## Question

Close the two live bugs that
[What shape is the deepened round-admission module](./04-what-shape-is-the-deepened-round-admission-module.md)
recorded. Both come from the server driver and the TUI command plane enforcing
the same admission policy in two drifted ways.

**1. Unhandled rejection on a lost compare-and-set race in the TUI.**

`src/tui.tsx`'s `kickRound()` calls `store.continue({ id, revision })` with no
try/catch, and `runGoalCommand` calls `await kickRound(store)` with no try/catch
either. `store.continue` reaches `GoalStore.expectCurrent`, which throws
`GOAL_NOT_FOUND` or `GOAL_STALE_REVISION`. `src/driver.ts` catches the same
exception at the same call site and logs it. So a human typing `/goal resume`
while the server driver just admitted a round produces an unhandled rejection
in the TUI.

**2. A goal stuck silent after `goal_wait` expires when the TUI is the only
entry point.**

`src/driver.ts`'s `drive()` clears an expired external wait — `waitUntil = 0`
and `waitReason = undefined` — before admitting. `src/tui.tsx`'s `kickRound()`
only bails with `if (store.waitUntil > Date.now()) return` and never clears it.
Nothing else in the TUI path clears it, so the goal stays quiet after the
deadline passes.

## What "fixed" means

Both entry points cross the admission module's seam, so the policy that clears an
expired wait and the policy that tolerates a lost CAS race each run once. The
ticket is done when neither behaviour exists in two places.

## Resolution

**Closed by ticket 15.** Both drifts were two copies of one policy, and the fix
was to have one policy.

**1. The unhandled rejection.** The command plane no longer calls
`store.continue` or `store.block` at all — it calls `admitRound(store)`, which
reads the view and commits it back to back inside one function, and answers
`{ kind: 'rejected', code: 'stale-ref' }` instead of throwing. There is a test
(`a goal another writer moved > the legacy pattern throws; the seam does not`)
that runs the old pattern and the new one on the same moved goal: the old one
throws `GOAL_STALE_REVISION`, the seam answers.

**2. The silent goal after an expired wait.** `admitRound` clears an expired
wait and then admits, so whichever entry point reaches the goal clears it. There
is a test that a wait whose deadline has passed is cleared exactly once, by one
policy, and that a second admission finds nothing left to clear.

Neither behaviour exists in two places any more: `src/tui.tsx` and
`src/driver.ts` both import `admitRound` from `./admission.ts`, and neither
imports `goalBlockReason`.
