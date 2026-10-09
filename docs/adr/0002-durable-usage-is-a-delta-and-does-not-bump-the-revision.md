# 0002 — Durable usage is a delta and does not bump the revision

- **Status:** Accepted
- **Date:** 2026-10-08
- **Ticket:** 24

## Context

Usage was accumulated in an in-memory overlay and carried by the next snapshot
mutation. The overlay therefore rode whatever mutation happened next, and a turn
that folded usage after the last mutation lost all of it.

Measured on a live v2 server: a goal folded 46,196 input tokens across four
stream steps and recorded 22,839 — exactly the first two — because the goal went
complete 12 ms before the third step's `session.step.ended` arrived. A one-round
goal recorded 0/0 while its event stream carried 16,193 input tokens.

The obvious fix is to append the accumulated usage with the next mutation. It
does not work, for two reasons that only appear once the fold is read carefully.

The fold is **last-wins per line**. A usage line that carried a whole snapshot
would replace the goal as this process last saw it. That clobbers a concurrent
writer: the server folds a step while a human pauses the goal from the command
plane, and a paused goal's in-flight round still reports its steps — a snapshot
usage line arriving after the pause would undo the pause while a round is in
flight for it.

The revision is the **coordinate** every caller-held compare-and-set ref reads,
and `applyActivation` reads it to decide whether a goal was mutated while this
store was alive. A usage fold is not a state verb. If it moved the revision, a
process folding steps would arm goals it never ran.

## Decision

`GoalStore.addUsage` appends its own durable change at the moment of the fold.
The change is a **delta** — the tokens this fold added, each possibly absent —
carried by a `usage` line with a `ref` and an `at`, and it does not bump the
revision. The in-memory overlay remains only as the fallback for a failed append,
because a throw inside `addUsage` would end the event stream.

`foldGoalLog` seeds its accumulator from a snapshot's carried usage while no
delta has been folded for that goal, and never after one has, re-seeding on a new
goal id. Without the seeding, a log written before this change — which has no
`usage` lines at all, because the total lived only in the snapshots — would fold
as zero usage, including every goal written before the change existed.

## Consequences

- Usage folded after the last durable mutation is now durable at the fold. The
  live run that measured the defect reproduced the same shape and then recorded
  57,378 input tokens where the old mechanism would have recorded 28,229 for the
  identical run.
- A usage line cannot clobber a concurrent writer, because it carries no snapshot
  to clobber with.
- A usage fold cannot arm a goal, because it cannot move the revision.
- The fold gained a seeding rule that has to be understood before the accumulator
  is read: once a delta has landed, every later snapshot already carries the sum
  of the deltas before it, and adding both would double-count.
- `sync()` still early-returns when `sameGoal` reports no change, and `sameGoal`
  does not compare usage. A process therefore does not notice another process's
  usage lines until a snapshot mutation lands. That is recorded rather than
  fixed, because changing `sync()`'s early-return is a drive-by change to a
  different concern.
