# 27 — Two opencode processes driving one goal log double-drive it, and the ticket-22 anomaly is this

**Type:** defect
**Status:** resolved — implemented in `ba5f079`, with three tests proven against
`HEAD` and five live runs across two servers on one worktree.

**What it delivers:** rounds stop being admitted by a process that is not the one
driving the current round, so two opencode instances on one worktree cannot burn a
goal's round cap without doing any work, and the goal log shows who was driving.

**Blocked by:** 22 — the anomaly it explains. Nothing blocks it otherwise.

## The anomaly this explains

Ticket 22 recorded, from the user's own `goal-log.jsonl`:

> **eleven `continue` mutations inside 20 milliseconds, with zero usage folded across
> all of them.**

Both halves of that sentence are produced by one mechanism. A round is admitted, a
continuation prompt is submitted, and the prompt **interrupts the other process's
in-flight turn** — because opencode coalesces a prompt submitted mid-turn. The
interruption is itself a `session.execution.interrupted`, which is a turn-completion
event, which both processes handle by admitting again. Each admission submits, each
submission interrupts, and the only thing produced is round after round with no step
ever completing — so nothing folds usage, and the mutations are milliseconds apart
because the loop is running at the rate of the event bus rather than the rate of work.

## What was measured, in-process, this session

`test/burst-repro.test.ts` (scratch; deleted after the ticket was written). The
harness is lifted verbatim from `test/integration.test.ts` so a simpler mock cannot
be the explanation for any result.

| Measurement | Result |
| --- | --- |
| 11 turn-completion events for **one** session, no delay between them | **1 round admitted.** The guard is not the problem. |
| 11 **child** sessions completing in one burst | **0 rounds admitted.** `childSessions` filtering works. |
| one completion event fanned out to **two** plugin processes on one log | **2 rounds admitted.** The defect. |
| the cascade with prompt coalescing modelled | four `continue` mutations inside **51 ms**, `in=0 out=0` on every one |

The reproduction's log:

```
create    rev=1 rounds=0 active    in=0     out=0
continue  rev=2 rounds=1 active    in=0     out=0
continue  rev=3 rounds=2 active    in=0     out=0
continue  rev=4 rounds=3 active    in=0     out=0
continue  rev=5 rounds=4 active    in=0     out=0
block     rev=6 rounds=4 blocked   in=0     out=0  code=no-tool-call
```

The cascade is stopped by a stall guard, not by anything that knows there are two
processes. The user's run reached eleven because the run was longer before the guard
fired, not because the mechanism differed.

## Why the existing guards do not cover it

- `roundsInFlight` and `inflight` are both keyed by session and both in-memory. Two
  processes have two copies of each, and a second process's submission interrupts
  the first's turn, so neither ever observes the other's round as in flight.
- `admitRound`'s compare-and-set re-folds the log on every read and CASes on the
  current revision, so two drivers that do not interleave both succeed. The
  revision number says *where* the goal is, not *who* is driving it.

**A poll is not the answer here and neither is a timer.** What is missing is not
observation but ownership: the log has to say which process owns the current round.

## Jev's verdicts

`jev-27.mjs`, three questions, confidence floor 0.6.

| Question | Answer | Confidence |
| --- | --- | --- |
| which of A lease / B file lock / C accept-and-document / D wall-clock valve | **A — a durable round lease in the log** | **0.98** |
| is an expiry deadline enough, or does the lease need renewal? | **both — renewal for a live round, expiry for a dead one** | **0.83** |
| is a lease line in the goal log an acceptable cost? | *acceptable only if it is clearly not a goal state verb* | **0.43 — under the floor, recorded, not re-asked** |

The third question returned 0.43. Per the discipline this effort has been using, a
sub-floor verdict is recorded rather than re-asked until it clears. Its content
(0.62 "only if it is clearly not a goal state verb", 0.37 "acceptable, and it is a
feature") does not disagree with the first two answers — it constrains the shape. A
lease line drawn as anything like `continue`/`block`/`usage` would be read as a
round by every tool that folds the log, including a human's. So the design follows
the constraint directly: **the lease is a separate line kind that the fold recognises
as a coordinate rather than as a state verb.**

## Design

A `goal/lease` line, alongside and distinct from `goal/change`:

```json
{ "kind": "goal/lease", "version": 1, "id": "<goal id>", "holder": "<uuid>", "at": <epoch-ms>, "expiresAt": <epoch-ms> }
```

Rules:

1. **A holder is per-process and per-round.** The driver generates one at startup
   and presents it on each round it admits, exactly as it presents a session id.
2. **Admission requires either no unexpired lease, or one held by this process.**
   This is the only new condition in `admitRound`, and it is a *read* of the folded
   log, so it needs no coordination beyond the fold already performed.
3. **The lease is renewed by the round's own step events.** Every
   `session.step.ended` the driver attributes to its own round pushes `expiresAt`
   out by a fixed window. A live round therefore never expires.
4. **A dead holder expires.** A process that dies mid-round renews nothing, so its
   lease expires after the window and another process may take the round. This is
   what makes a crash safe rather than a deadlock — Jev's second answer carries
   exactly this reasoning.
5. **A finished turn releases the lease** by writing `expires: at`, the same line
   kind with an expiry that makes it immediately stale.
6. **The fold never counts a lease as a round, a block, a wait or usage.** It is a
   coordinate, not a verb. This is the direct answer to the sub-floor answer's
   constraint.

Open questions the implementation has to answer, none of which Jev settled:

- the renewal window's value. A window shorter than a real step interval would
  expire a live round; a window longer than a tolerable outage delays recovery.
- what the driver does when it submits a round in a session that another process's
  lease covers *for a different session*. The lease is per goal, not per session,
  and the ticket's reproduction has both processes driving the same session — but
  the general case that motivated it is two TUI windows, which are two sessions.

## Not in scope

- the wall-clock valve (option D) is not chosen, but the reproduction shows it is
  also not a bad *additional* safety net. It is a separate question and is not
  folded into this ticket.
- anything about the TUI's auto-start. It admits once per goal-and-session, per
  ticket 22, so it is not a source of double-driving.

---

# Implemented

## What changed

- **`src/types.ts`** — `GoalLeaseChangeMeta`, a line kind of its own: `{kind:'goal/lease', version:1, id, holder, at, expiresAt}`. `GoalLogLine` is the union the fold parses, so a lease is a first-class durable line and not a field smuggled into a snapshot.
- **`src/state.ts`** — the fold reads a lease into its own slot and never lets it reach the goal accumulator, the revision or `lastRef`. A lease naming a goal other than the current one is dropped, so one writer's lease cannot hold another goal's round. A `clear` drops it, because a cleared goal has no round to own.
  - `holdRound(ref, holder, expiresAt)` — a plain append; a renewal is the same call with a later expiry, because the log is append-only and the fold is last-wins.
  - `releaseRound(ref, holder)` — a lease line whose expiry is already past, not a delete. A holder that is no longer the holder writes nothing: overwriting a live lease would hand the round back to a process that just lost it.
  - `lease` — expiry is read at call time, so a process that dies mid-round releases its round by doing nothing at all. That is the whole crash story and it needs no liveness protocol.
  - `renewLeaseIfDue(ref, holder, windowMs)` — renews only when less than half the window remains, so a twenty-round goal writes a handful of lines rather than two hundred for one fact.
- **`src/admission.ts`** — `admitRound(store, {holder})` rejects with `'leased'` when an unexpired lease is held by another process. It sits **after** `disarmed` and **before** the wait and the guardrails, because it is the question "is this mine to decide at all": a process answering no must not also cross a round boundary or stop the goal on the holder's behalf. A caller that passes no holder is checked against no lease at all, which is the pre-lease behaviour rather than a silent refusal.
- **`src/driver.ts`** — one `randomUUID()` holder per driver, therefore one per process. Acquired after admission commits and before the prompt is submitted, so the lease describes a round that exists. Renewed by the round's own step events. Released when the turn reports back and on a submission error.
- **`src/index.ts`** — the step branch renews the lease, gated on `isGoalTurn(sessionID)` so a human's turn or a subagent's cannot renew another process's claim.
- **`src/tui.tsx`** — the command plane presents its own holder. It deliberately does **not** override: the command plane overriding the lease is the double-driving defect arriving through the one door that is meant to be the human's.

## What it does not do, stated plainly

**It does not make admission atomic.** Two processes can both pass the check before either writes, and one extra round is then admitted. What it closes is the *loop*, which is what made the original defect unbounded: the first lease written is the one every subsequent admission sees, so the second process defers from then on and the cascade converges on a single driver instead of running until a stall guard happens to fire.

## Tests — `test/lease.test.ts`, three tests

The main one was run against `HEAD` first, with the fix reverted:

| | on HEAD | with the fix |
| --- | --- | --- |
| rounds after adoption | **2** | 1 |
| rounds after one fan-out | **4** | 2 |
| rounds after 20 more events | 4 *(stopped by a stall guard, not by convergence)* | **2** |
| lease lines | 0 | 3 |
| distinct holders | — | 1 |

The other two prove a lease is a coordinate that never counts as a round, a block or usage, and that it carries a real future expiry so a dead holder does not stall the goal forever.

## Live proof — `assets/lease-live.py`, five runs

Two real `opencode serve` processes on one worktree, both loading the plugin, the goal created through the first. Across every run:

- the lease is written at admission and renewed by step events, with `expiresAt` moving forward each time;
- **one distinct holder, always**;
- usage deltas still recorded, so ticket 24 is unaffected;
- the second process's turns genuinely ran — proved by a diagnostic that reads its session's messages, because without it a missing deferral would be indistinguishable from a missing turn.

**What the live runs did not capture, and why.** The literal deferral never appeared in the second process's log. Every run, the first process's round completed the goal before the second process's turn landed, so the second process rejected with `not-active` — the phase check sits before the lease check, and a completed goal answers it first. Five objectives were tried, including one that forbade completing (ignored by the model) and one requiring ten files across ten rounds. The deferral itself is proven in-process instead, where the timing is deterministic.

A related fact the live runs did surface: the second server must start **before** the goal exists. A store born beside a goal it never mutated reads `disarmed` and rejects before the lease is ever consulted, so a second process started afterwards cannot reach the lease check at all. That is ticket 26's rule working as designed, and it is the reason the harness starts the second process first.
