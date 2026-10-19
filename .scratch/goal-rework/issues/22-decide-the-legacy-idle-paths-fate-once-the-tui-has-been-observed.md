# 22 — Decide the legacy idle path's fate once the TUI has been observed

**Type:** implementation
**Status:** resolved

**What it delivers:** the TUI path has now been observed for real, and the observation
produced one defect and one fix rather than a verdict about `session.idle`.

**Blocked by:** 09 — What you saw on the live opencode v2 server

## The observation

The user ran `/goal` in the interactive TUI in a real project. What was seen:

1. `/goal create` from the **home route** printed
   *"No session is open in this project, so the goal has nothing to run in yet.
   Open a session here and it starts on its own — no /goal resume needed."*
2. The goal then **did not start**. It started only after the user manually sent a
   message.
3. After that, rounds ran — eleven of them, visible as continuation prompts.

The hint's promise was false, and that is the defect.

## Root cause

Nothing in the TUI reacts to the route becoming a session. The only two things that
start a goal are:

- the command plane's `kickRound`, which needs a session **at the moment of the
  command**, and
- the server driver's `session.created` handler, which is **one-shot per session** —
  a session that already existed when the goal was created is never adopted by it.

So a goal created from the home route has exactly one way to start: a human doing
something that produces a turn-completion event.

## The fix

`autoStart` in `src/tui.tsx`, driven by the sidebar's existing poll. It arms a fresh
fold of the durable log and kicks a round, keyed by goal-and-session so one session
starts one goal once. It runs on the poll rather than on a subscription because the
router exposes `current()` with no change signal, and because the poll also covers
**opening a session that already existed** — which a `session.created` subscription
would miss.

### A second finding the fix surfaced

`openStore` creates a **new `GoalStore` per call** — the TUI folds the durable log
from disk on every command. A store that came alive beside a goal it did not mutate
reads as `disarmed`, so `admitRound` rejects it. The auto-start therefore arms before
kicking, exactly as the server driver arms on session adoption: opening a session *is*
the human touching the goal, which is what makes arming right.

## The `session.idle` question

Not settled by this observation, and now **narrower than it was**. `session.idle` is
ephemeral with no durable block (confirmed in `@opencode/protocol`), so it can fire
repeatedly and carries no sequence to dedupe. What the observation does rule out is
that `session.idle` is what starts a goal in the TUI: the goal stayed silent through
whatever idles arrived until a turn actually completed.

The legacy idle path (`onSessionIdle` → `handle()`) therefore stays, but it is now
known to be a *supplementary* trigger rather than the adoption trigger, and it is
guarded by `roundsInFlight` so it cannot burst. Its remaining question is whether a
turn that ends without an execution event can leave the loop stalled — which needs a
recording of exactly that, not a TUI run.

## Two defects found while investigating, fixed here

**1. A goal written before the stall threshold existed silently lost the guard.**
`GoalSnapshot.maxTurnsWithoutToolCall` was added in ticket 21, and a log line without
it folded as `undefined` — which made `hasStalledWithoutTools()` compare against
nothing and return false forever. The guard read as configured-off for every older
goal, with nothing saying so. The user's own `goal-log.jsonl` had exactly this shape.
`normalizeSnapshot` now defaults it, as it already defaulted the token budget.

**2. The driver did not dedupe turn-completion events.** Accounting deduped its own
fold by `durable.seq`; the driver had no equivalent, so a replayed or duplicated
`session.execution.succeeded` released a round that was not in flight and admitted
another one. These events are **durable** (confirmed in the protocol), so replay is
real. `foldedTurnSeq` now mirrors accounting's O(1) check, and an event with no
sequence is folded rather than dropped — dropping it would stall the loop silently,
which is worse than admitting a round twice.

## An anomaly this did not settle

The same `goal-log.jsonl` records **eleven `continue` mutations inside 20
milliseconds, with zero usage folded across all of them**. Both facts are unusual: a
round admission normally follows a turn, and a turn normally folds `session.step.ended`
usage. Zero usage across eleven rounds means no step event was ever folded.

What can be ruled out from the evidence: it is not the TUI (the TUI admits only on a
command and on the new auto-start, both keyed once per goal-and-session), and it is
not a replay of `session.execution.succeeded` alone, since the driver now dedupes
those and the mutation burst predates that fix.

What remains open, with what would distinguish it:

| Hypothesis | What would distinguish it |
| --- | --- |
| several server processes driving the same goal log, each with its own `roundsInFlight` | more than one opencode server alive during the run |
| turns completing without any step event (a failing or no-op turn) | an event recording of the same run |
| an execution event emitted per assistant step rather than per turn | an event recording of the same run |

The compare-and-set in `admitRound` does **not** cover this: each process re-folds on
every read and CASes on the current revision, so two drivers that do not interleave
both succeed. That is a multi-process gap the single-process design does not claim to
close, and closing it needs its own ticket rather than a drive-by.

**Not fixed here, and recorded as the next ticket.**

---

# The anomaly is now explained — measured, in-process, this session

The three hypotheses the table above listed are closed by four measurements rather
than by argument. The harness is `test/integration.test.ts`'s, lifted verbatim, so no
result can be an artifact of a simpler mock. The scratch test was deleted after the
findings were recorded here.

| Hypothesis | Measurement | Result |
| --- | --- | --- |
| an execution event emitted per assistant step rather than per turn | runD had 2 `session.step.ended` and 1 `session.execution.succeeded`; runH had 4 and 2 | **ruled out** — execution events are per turn |
| a burst of completion events for one session | 11 `session.execution.succeeded` for one session, no delay between them | **1 round admitted.** The guard is not the problem. |
| turns completing without any step event | eleven *child* sessions completing in one burst | **0 rounds admitted.** `childSessions` filtering works, so a subagent flood is not it either. |
| several server processes driving the same goal log | one completion event, fanned out to two plugin processes on one log | **2 rounds admitted.** **This is it.** |

And the multi-process case reproduces the anomaly exactly when opencode's documented
prompt coalescing is modelled — a prompt submitted mid-turn interrupts the running
turn, and the interruption is itself a turn-completion event:

```
create    rev=1 rounds=0 active    in=0     out=0
continue  rev=2 rounds=1 active    in=0     out=0
continue  rev=3 rounds=2 active    in=0     out=0
continue  rev=4 rounds=3 active    in=0     out=0
block     rev=6 rounds=4 blocked   in=0     out=0  code=no-tool-call
```

Four `continue` mutations inside 51 ms, `in=0 out=0` on every one, stopped only by a
stall guard. Zero usage, because no step ever completes; milliseconds apart, because
the loop runs at the rate of the event bus rather than the rate of work. Both halves
of the original anomaly from one mechanism.

The user's run reached eleven rather than four because it ran longer before the guard
fired, not because the mechanism differed.

**Filed as ticket 27**, with Jev's design verdict: a durable round lease in the log
(confidence 0.98), renewal for a live round and expiry for a dead one (0.83). The
third question it asked — whether a lease line in the goal log is acceptable — came
back at **0.43, under the floor**, and is recorded there rather than re-asked.
