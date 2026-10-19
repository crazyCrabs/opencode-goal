# The goal log is a protocol, and adding a line kind is five edits

`~/.opencode/goal-log.jsonl` is append-only and every process that touches a goal
folds it. A line kind is therefore a protocol change: the writer, the fold, the
in-memory shape and the sync comparator all have to agree, and only the first is
checked by the compiler.

Adding `goal/lease` and `goal/session` each took exactly these five. Nothing
enforces the other four.

## The checklist

1. **`src/types.ts`** — add the meta interface and put it in the `GoalLogLine` union.
   Give it a `version` field, and a `kind` string no other line uses. If the line
   describes where the goal is rather than what happened to it, say so in the
   doc comment: that distinction is what the rest of the checklist turns on.

2. **`src/state.ts`, the fold** — a branch that reads the line into its own local and
   `continue`s. **The `continue` is the whole point.** A line that falls through to
   the `goal/change` branch is either dropped as an unknown kind or, worse, counted
   as a mutation.

3. **`src/state.ts`, `GoalFoldState`** — a readonly slot on the folded state. Without
   one, the value has nowhere to live and step 5 has nothing to compare.

4. **`src/state.ts`, `sameX` and `unchangedFold`** — a comparator, and a clause in the
   conjunction. This is the step that is easiest to forget and most expensive to
   miss: `sync()` short-circuits on `unchangedFold`, so a coordinate that changes
   without its own clause is invisible to every other process. See ADR 0005 for what
   a missing lease clause cost.

5. **The writer and its tests** — one call site that appends the line, and tests that
   fold it back. A coordinate written by only one of the two entry points is a
   coordinate only that entry point can see.

## State verb or coordinate

Decide this before step 2, because it decides where the line goes.

A **state verb** says the goal changed: it reaches the goal accumulator, moves the
revision, and can re-arm or disarm a store through `sync()`.

A **coordinate** says where the goal is: the lease names who holds the current round,
the session line names the room and the model. It gets its own slot, is never
counted as a round, a block, usage or the revision, and — this is the part that
bites — **must not re-arm or disarm a store that adopts it**. `applyExternalChange`
computes `mutatedWhileAlive` from the revision, and a coordinate leaves the revision
alone, so an armed store adopting one reads as "not mutated while alive" and
disarms itself. `sync()` returns early for a coordinate for exactly this reason.

If a new line is a coordinate, it needs the early return in `sync()` as well as the
clause in `unchangedFold`. That is six edits, not five.

## What the fold already does for you

- A line naming another goal is dropped, not applied. One writer's lease cannot hold
  another goal's round; one writer's session cannot steal another goal's room.
- A `clear` drops every coordinate along with the goal, because a cleared goal has no
  round to own and no room to work in.
- An unscoped line belongs to a goal written before sessions were scoped, and only
  the room that goal last worked in inherits it.
