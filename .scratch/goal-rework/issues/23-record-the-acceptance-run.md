# 23 — Record the acceptance run

Type: implementation

**What to build:** the destination itself. A real server runs a real goal to a natural
stop, with every round's prompt, tool call and event captured, before and after the
rework, so that "it works" is an artifact with a pass mark rather than an opinion.

**Blocked by:** 20 — The model stops quoting refs, and a completion claim becomes auditable; 21 — Human turns stop spending the goal's budget, and a second stall counter is added; 22 — Decide the legacy idle path's fate once the TUI has been observed; 09 — What you saw on the live opencode v2 server; 10 — Your red line for "the experience is good"

**Status:** done — the run exists, is diffed, and passes. See the closing section
of this file for the three differences, the one that is not a rework difference, and
the one limitation (both runs go through `opencode serve`, not an interactive TUI).

- [ ] The same goal objective is run before and after the rework, on the same server
      version, and both runs are recorded.
- [ ] Every round's submitted prompt, every tool call the model made, and every event
      the server emitted are captured, per round.
- [ ] The run reaches a natural stop — complete, impasse, or a guardrail — rather than
      being cut off, and the stop carries a durable reason.
- [ ] The two recordings are diffed, and every difference is either an intended change
      with a ticket number behind it or a defect.
- [ ] The pass mark is the human's single condition, supplied by ticket 10. The
      artifact exists without it; the verdict does not.
- [ ] The read-only spy plugin that produced the four existing recordings is extended,
      not rebuilt, and is recorded in `assets/` alongside the run.
- [ ] The acceptance is no weaker than the prior art's, which ships an executable live
      smoke test rather than README prose.

**This ticket is the destination.** The rework is not done when the code is written; it
is done when this recording exists, is diffed, and passes the human's condition.

---

# Done — the acceptance run exists, is diffed, and passes

The before build is `c1d6492` (the last pre-rework commit) built from a `git
archive` into a scratch directory; the after build is the current one. Same server
version, same objective, same model, one fresh trial directory each. Both are in
`assets/acceptance/` (`goal-log-{before,after}.jsonl`,
`recording-{before,after}.jsonl`), produced by `assets/acceptance-run.py` and
compared by `assets/acceptance-diff.py`.

## The objective, and the shape it produces

> *Call create_goal with this objective and then stop immediately, doing none of the
> work yourself. Objective: create a file named acceptance-proof.txt in the current
> directory containing exactly the word banana, then verify with a command that the
> file exists and contains it, then report the goal complete with a structured claim.*

The `stop immediately` clause is load-bearing. The first version of the objective
let the model create the goal, write the file, verify it and complete it all inside
the human's own turn, so the goal recorded `rounds=0` and the acceptance said nothing
about whether a goal advances on its own. Both recordings now show one human turn of
329 characters, then **one admitted round with nothing from the human in between or
after**.

## The differences, and which ticket each belongs to

**1. Usage folded after the last durable mutation — ticket 24.**
Before: 0 usage lines, 15 949 input tokens recorded. After: 4 usage lines, 57 378
recorded. The precise number: under the old mechanism the identical after run would
have recorded 28 229 — the usage carried on the last snapshot mutation — and it
actually recorded 57 378. **The 29 149 difference is what the old overlay could not
carry.**

**2. The model quotes refs — ticket 20.**
Before: two mutations carrying `{action, goal_id, revision}`. After: zero, and the
mutation carries `{action, claim}` instead.

**3. A completion claim is stored and auditable — ticket 20.**
Before: `claim: null`. After: a claim whose summary a human can read, stored on the
snapshot.

**4. Tool counts — not a difference caused by the rework.**
Before: 6 tool calls, 2 commands with an exit code. After: 4 and 1. Same objective,
same model; the model chose a different set of calls. Recorded here rather than
smoothed over, because a diff that only lists intended differences is a diff that
hides its own noise.

## The verdict

Ticket 10's red line, against both recordings:

- **No round needs me to tell the model what to do next.** One human turn, then one
  admitted round with nothing from the human after it — in *both* builds. The new
  build kept this property rather than gaining it, which is the honest result: the
  property was already there for a goal created beside a live session on this server.
- **No stop is silent.** Both stopped as `complete`; only the after build recorded a
  claim a human can read.

**PASS.** What the rework changed on this run is not "it starts now" — it already
did — but "what it recorded of what it spent", "the model stopped quoting refs", and
"the stop says why". The start defect the human reported was on the TUI plane and is
closed by `autoStart` plus `adoptOnHumanTurn`, which this recording exercises on the
server half.

## One limitation, stated rather than hidden

Both runs are driven through `opencode serve` over HTTP, not through an interactive
TUI — `opencode mini requires a TTY stdout` and none is available here. Ticket 09
records this. The TUI half is covered by the in-process `autoStart` tests rather than
by a recording.
