# 31 — A goal belongs to its session, not to the worktree

**Type:** defect (scope)
**Status:** implemented — `HEAD`

**What it delivers:** two sessions in one worktree hold two goals. Opening a new
session no longer inherits the previous one's objective, rounds or budget, and a
turn completing in one session says nothing about another's goal.

**Blocked by:** nothing. Requested by the human after ticket 30.

## The request

> 我的发现是在同一个工作目录下，所有的 goal 都是共享的，新开的 session 对话也会把旧
> session 中的 goal 任务拿来读取。我所期望的是就算是在同一工作目录下，也需要根据
> session 对话来区分 goal 任务，颗粒度要到 session 而不是目录。

## Phase 1 — the loop

`bun test test/tui.test.ts` — three tests in *a goal belongs to its session, not to
the directory*, red before the fix and green after. The observable is the command
plane's own answer: `/goal status` in a fresh session must say *"No goal is
currently set"*, and a goal created there must run in that session.

## The design

**One log, scoped by the fold.** The log stays one file per worktree — `GoalStore`
gains an optional `sessionID`, and the fold accepts a line only when it belongs to
that session. Splitting the file instead was tried first and reverted: it moved the
product's writes to a path the tests did not read, which broke twenty-three tests
for no gain, and the fold is the cheaper place to express the scope.

**Every write is stamped.** `GoalStore.append` is the single write path and stamps
the session, so no site can forget it — a line without a stamp is a line only the
unscoped view can see, which would make a session's own goal invisible to itself.

**`Tool.Context` carries `sessionID`**, as the second argument of every `execute`,
and the goal tools were ignoring it. That is why a goal the model created belonged
to the directory rather than to the conversation that asked for it.

**A subagent's work is charged to the goal it serves.** A subagent session has no
goal of its own, so its commands would be invisible to the completion claim they
back. `goalSessionOf` resolves a child to its parent before the store is opened.

## The migration, and why it is narrow

A goal written before this change carries no session on any line, so the only thing
it can be attributed to is the room it last worked in — the `goal/session`
coordinate. **Exactly that one session inherits it.** Every other session starts
with no goal; adopting the legacy lines for all of them would leave the sharing
behaviour exactly as it was.

Verified against the human's own log rather than a fixture: the directory-scoped
view still sees `goal-aeee8d39` (active, 2 rounds), the room `ses_ebb90a29…`
inherits it, and another session of the same worktree starts empty.

## What this subsumes

Ticket 30's defect — a turn in another session advancing the goal — is now
**structurally impossible**: there is no shared goal left to drive. The three-clause
`ownsTurn` heuristic the driver needed for it is no longer load-bearing, and its
tests still pass as regression guards.

## What this costs

**A goal whose room dies goes quiet.** Previously a turn in any session of the
worktree could carry it on, which was the defect; now only its own room can, so a
deleted or closed room leaves the goal waiting for `/goal resume` in a session that
has it. That is recoverable and it is the honest trade, but it is a real cost and
it is recorded rather than assumed away.

**`session.idle` no longer adopts.** It never did on its own account: the adoption
it performed came from the store existing before the goal did, a trick a per-session
store cannot repeat, and the live server never publishes an idle anyway (ticket 22).
The turn-completion event is the vehicle now, and it arms through
`adoptOnHumanTurn`.

## Tests — 29 new, and 15 corrected

Three new tests fail on `HEAD`. The corrected ones are the interesting part: each
had been written while one goal log served a whole worktree, and several used a
**different session id as the vehicle** for an assertion about something else — which
asserted along the way that a turn in another session advances the goal, or that a
new session inherits the old one's goal. Those vehicles now name the goal's own
session, and every assertion about attribution, lookup, blocking, waiting and the
lease is untouched.

**Proof the corrections did not hollow them out:** with `src/` reverted and every
test kept, exactly three fail and 280 pass — so the corrected tests mean the same
thing with and without the fix, and the three are red precisely because the fix is
absent.
