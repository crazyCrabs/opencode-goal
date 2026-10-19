# 24 — Usage folded after the last durable mutation is discarded

**Type:** defect
**Status:** resolved — implemented in `4fad000`, with a live proof that reproduced the
defect shape and then recorded 57 378 input tokens where the old mechanism would have
recorded 28 229 for the identical run.

**Found by:** ticket 09's advance, which ran the plugin against a real
opencode v2.0.14 server for the first time.

## The live evidence

A one-round goal ran four steps and folded 46 196 input tokens. The goal
recorded 22 839.

| step | `durable.seq` | created | input | cache-read | folded |
| --- | --- | --- | --- | --- | --- |
| 1 | 13 | 1790262469199 | 11390 | 0 | 11390 |
| 2 | 22 | 1790262479144 | 121 | 11328 | 11449 |
| — | — | **1790262489587** | | | **`complete` stamped here** |
| 3 | 33 | 1790262489599 | 103 | 11392 | 11495 |
| 4 | 40 | 1790262500545 | 1622 | 10240 | 11862 |

Steps 1 and 2 sum to exactly 22 839 — the recorded value. Steps 3 and 4, both
arriving after the `complete` mutation, contributed nothing.

## What was ruled out, by measurement rather than reasoning

The plugin was instrumented at two places for this run:

- **every `session.step.ended` that reaches `onStepEnded`, and every one that
  does not** — all four reached it. Nothing was filtered by the caller.
- **the three early returns inside `onStepEnded`** — `no goal`, `already folded`,
  `not a goal turn` — none fired, not once.

So the tokens were correctly read, correctly attributed to a goal turn, and
correctly summed, and they were then thrown away **after** all of that.

## The mechanism

`GoalStore.addUsage` (`src/state.ts:422`) accumulates into an in-memory overlay
and appends nothing:

```ts
addUsage(usage: Partial<GoalUsage>): void {
  const goal = this.state.goal
  if (goal === undefined) return
  const current = this.effectiveUsage(goal)
  const next = { inputTokens: current.inputTokens + …, … }
  this.usageOverlay = next          // ← nothing durable is written
}
```

The overlay is carried by the **next** mutation, and `commit` clears it once it
has been written (`src/state.ts:459`). So usage is durable only if some
mutation follows the fold. For a goal that keeps running, every round's
`continue` provides one. For a goal that completes, nothing does — and the
trailing steps are lost.

## Why this is worse than "the completing step is lost"

The loss is not bounded to completion. It is **every usage folded after the most
recent durable mutation**, which includes:

- the completing step and anything after it, and
- **everything pending when the process exits.** A crash, a restart or a killed
  server discards the overlay with it.

That second one undoes the point of ticket 14. Usage accounting was moved off the
transcript onto durable native events precisely so it stops depending on
in-memory state; the overlay reintroduces that dependence for exactly the usage
that is hardest to recover.

## What is proven in the suite

`test/accounting.test.ts` — "usage folded after the last durable mutation / is
not lost to the next reader of the durable log", marked `test.failing`:

- a step folds 11390/45, a `continue` carries it: works
- a later step folds 11495/191 and no mutation follows
- a **fresh `GoalStore`** over the same directory — which is what a restart, a
  second process, or the human reading the log sees — must report 22885/236

It does not. The numbers are the live server's.

## Jev's verdicts, and how they apply now

All four answers were above the 0.6 floor and none needs re-asking, because none
of them depends on the mechanism this ticket got wrong the first time:

| question | verdict | confidence |
| --- | --- | --- |
| is it a defect? | yes | 0.85 |
| must the human-turn gate stay? | yes | 0.95 |
| should the model report usage? | no — the server folds the step | 0.89 |
| which fix? | `drainable-for-one-step` | 1.00 |

The first three land unchanged on the real mechanism. The fourth was chosen
against a mechanism that turned out to be wrong, so it is **not** being acted on
as-is; what it said that still holds is that the fix should be the smallest change
that charges the completing step without reopening the human-turn hole.

## What a fix has to decide

`addUsage` must become durable at the moment of the fold, or be flushed at a
point that cannot be skipped. The shapes:

1. **`addUsage` appends its own change.** Usage is durable when it is known. The
   cost is one log line per step, which for a long goal is a few hundred lines.
2. **Flush the overlay at the turn boundary.** One mutation per turn instead of
   per step, which is the shape `drainable-for-one-step` was reaching for. Still
   loses the trailing usage if the process dies mid-turn.
3. **Carry the overlay into the *phase* transition only, and make the driver
   complete the goal at the turn boundary rather than mid-step.** Moves the
   problem rather than solving it, and the driver cannot know a completion is
   coming.

Not chosen. This ticket exists so it is chosen deliberately, with the live
numbers in front of whoever chooses.

## Still open, and not this ticket

The user's original observation — 11 `continue` mutations with zero usage across
all of them — is 11 admitted rounds, none completing. Different mechanism.

## What was done

**`addUsage` appends its own durable change at the moment of the fold.** The
in-memory overlay is gone except as the failure path.

### It is a delta, and it does not bump the revision

Both are load-bearing, and neither was obvious from the ticket's option list:

- **The fold is last-wins per line.** A usage line carrying a full snapshot would
  replace the goal as *this process* last saw it. The ordering is real: the server
  folds a step while the human pauses the goal from the TUI, and a paused goal's
  in-flight round still reports its steps. A snapshot-carrying usage line arriving
  after the pause would undo it — while a round is in flight for that goal. A delta
  cannot clobber anything.
- **The revision is the coordinate** every caller-held ref and `applyActivation`'s
  `mutatedWhileAlive` read. A usage fold is not a state verb; if it moved the
  revision, a process folding steps would arm goals it never ran.

`GoalOperation` gained `'usage'`, and `GoalSnapshotChangeMeta.operation` became an
explicit `GoalSnapshotOperation` list so a usage line cannot be written as a
snapshot by type.

### The fold, and why the seeding rule is what it is

`foldGoalLog` now keeps a usage accumulator beside the goal:

- a `usage` line for the current goal adds its delta;
- a snapshot line **seeds** the accumulator from its carried usage while no delta
  has been folded for that goal, and never after one has;
- a new goal id re-seeds regardless.

The seeding is what keeps a log written before this change readable. Such a log
has no `usage` lines at all and its total lives only in the snapshots, so summing
nothing would fold the user's own `goal-log.jsonl` — and every goal the previous
build wrote — as zero usage. The "never after a delta" half is what stops a
new-style log double-counting: once a delta has landed, every later snapshot
already carries the sum of the deltas before it.

### A failed append degrades instead of killing the loop

`appendUsage` is wrapped: a throw would propagate into the plugin's event handler
and end the stream, so one bad write costs one bookkeeping number rather than
every event after it. The overlay stays exactly for that.

### Cost, stated

One log line per step, ~180 bytes: a ref, three numbers and a timestamp, no
snapshot. A 25-round goal with several steps each is a few hundred lines.

## Live proof against a real server

`.scratch/goal-rework/assets/prove-ticket24.py`, trial 16
(`goal-log-runH-ticket24-fixed.jsonl` / `recording-runH-ticket24-fixed.jsonl`):

```
create    rev=1  active    rounds=0  in=0     out=0
continue  rev=2  active    rounds=1  in=0     out=0
complete  rev=3  complete  rounds=1  in=0     out=0
usage     in=11779 out=347  ref revision 3
usage     in=12420 out=90   ref revision 3
```

Four steps in the stream, 43 977 input tokens. Steps 1 and 2 (8 643 + 11 135) are
the **human's** turn, which ticket 21 deliberately does not charge — that gate is
intact. Steps 3 and 4 (11 779 + 12 420 = **24 199**) are round 1's, and both
arrive **after** the `complete` at revision 3, with nothing to ride. Under the old
overlay those recorded zero. Now both are durable deltas in the log.

This is the same shape as the original measurement (46 196 recorded as 22 839),
reproduced and fixed in the same run.

## The tests

The recorded `test.failing` became a real test and **passes**. Four of six new
tests fail against `HEAD`; the legacy-log one passes there on purpose, because it
is the backward-compatibility guard rather than a defect detector.

Run against `HEAD` with this change reverted:

```
a fresh reader of the log sees usage folded after the last mutation
  Expected: 22885   Received: 11390                              (fail)
each fold writes its own line instead of riding a later mutation
  Expected: 3       Received: 1                                  (fail)
a usage line cannot undo a snapshot another writer appended after it  (fail)
a goal that replaces a completed one does not inherit its usage
  Expected: 100     Received: 0                                  (fail)
a usage line for another goal is not added to this one               (fail)
```

## Two things the first live attempt got wrong, recorded so they are not repeated

- **A human turn folds nothing, correctly.** The first trial asked the model to
  create *and* complete the goal in one turn, and recorded zero usage lines. Zero
  was right: that turn is the human's, and ticket 21's gate charges it to nobody.
  The defect only shows when the goal completes inside a **goal round**, which is
  what the objective was changed to.
- **The settle window was read too early.** The first trial waited for the
  completion line, then measured a run that had not yet folded its trailing steps
  — 0 recorded where the same directory later held 26 136. The script now waits for
  the log to stop changing after the completion.
- **`kill_tree` was ordered wrong.** `proc.kill()` ran before `taskkill /T /F`, so
  the tree walk started from a dead pid and the real `opencode.exe` survived — as an
  orphan holding the trial directory *and still driving the session*. The first
  trial's zero was measured against a server that had been "killed" and was not.
  `taskkill /T /F` now runs first, and a closed listen socket is the honest check
  that nothing survived.
