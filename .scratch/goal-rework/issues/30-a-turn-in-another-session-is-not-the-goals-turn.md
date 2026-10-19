# 30 — A turn in another session of the same project is not the goal's turn

**Type:** defect
**Status:** implemented — `HEAD`

**What it delivers:** a goal advances only on turns in the session it is working in,
so a human talking in a second session of the same project neither advances the
goal nor spends its guardrails.

**Blocked by:** nothing. Reported by the human from live use.

## The report

> 我在用户目录下打开了 opencode 并使用 goal 创建了一个「制作一个中国古代建筑的沙盒，
> 使用 html 完成，可以自由拖拽，里面的建筑要求符合古风，3D」任务。同时我也在其他
> session 里面对话，当其他 session 里面的任务完成时，goal 的任务触发了。

## Phase 1 — the loop

`test/cross-session.test.ts`, one command:

```
bun test test/cross-session.test.ts
```

Built on the real plugin and the real event stream, with every session in the
project resolving to the same directory — the situation the human described. It
was red on three tests before the fix and green after.

The loop needed tightening once: a fixed 40-tick `settle()` measured **~650ms per
event** under this harness's event-loop load, eight times its nominal cost, so a
five-event test exceeded its timeout. It is now adaptive — the queue drains
synchronously as the subscription yields, so "empty and staying empty" is the
signal.

## Phase 2 — the measured symptom is worse than reported

The goal was not merely triggered. With the goal's own rounds producing tool calls,
one human turn in another session did this:

```
after ses-goal turn finished     rounds=2  prompts=2 -> ses-goal, ses-goal
after ses-human-1 turn finished  rounds=3  prompts=3 -> ses-goal, ses-goal, ses-human-1
```

**Round 3's prompt was submitted into `ses-human-1` — the human's own session.**
And with the goal's rounds tool-less, two human turns blocked the goal as
`no-tool-call`, because `GoalAccounting.onTurnEnded` charged the human's turn to
the goal's stall counter.

Two symptoms, one missing question.

## Phase 3 — the ranked hypotheses, and what settled them

| | Hypothesis | Prediction | Outcome |
|---|---|---|---|
| H1 | the handler does not ask which session the goal's round is in | gating both halves removes both symptoms | **correct** |
| H2 | only accounting is wrong | the block goes, the advance stays | disproven: the advance was measured independently |
| H3 | only the driver is wrong | the advance goes, the block stays | disproven: the block was measured independently |
| H4 | `resolveTurnSession` mis-attributes the session | it returns undefined for the human's session | disproven: it resolves, same project, same directory |
| H5 | `adoptOnHumanTurn` admits the round | removing it stops the advance | disproven: the log names `drive()`'s admission, not adoption |

H2 and H3 were separated by making the goal's own rounds produce tool calls, which
holds the stall counter at zero so only the cross-session defect can show.

## The fix

`GoalDriver.ownsTurn(sessionID, directory)` — three clauses, because the plugin can
only ever know where the goal **acted**, never which session the human is standing
in:

1. a round this process submitted is running here — definitive;
2. the goal last acted here — the clause that closes the reported bug, and it needs
   the driver to remember its room, which it never did;
3. the goal has never acted in any room — the `opencode run --standalone` and
   restart case, where the goal predates the process and so does its session.

The driver now pins the room at every admission and at the first session created
while a goal exists, and only the first: a session opened later must not steal the
goal away from the room it is working in, which is the same defect through another
door.

`GoalStore.rememberSession` merges the model rather than replacing it with
undefined, so the driver remembering a room cannot erase the model the command
plane learned — losing it would send the next recovery back to the server default,
which is the 403 ticket 28 exists to prevent.

`GoalAccounting.onTurnEnded` takes `belongsToGoal` and charges nothing for a turn
that is not the goal's. The adapter computes the answer once and passes it to both
halves, because a guard answered in two places can disagree with itself.

## Seven existing tests asserted the defect

Every one of them built the goal through the TUI plane — whose room is
`ses-integration` — and then used a **different** session id as the vehicle for a
directory-attribution assertion, which asserted along the way that a turn in
another session advances the goal. The vehicles are corrected to the goal's own
room. Every assertion about attribution, lookup and blocking is untouched.

**Proof the correction did not hollow them out:** with `src/` reverted and the
corrected tests kept, exactly the three cross-session tests fail and all seven
still pass. So they test the same thing with and without the fix, and the three new
ones are red precisely because the fix is absent.

## What this costs

**A goal whose room dies goes quiet instead of hijacking the human's next session.**
That is the intended trade — quiet is recoverable through `/goal resume` and
`ensureSession`, and a hijacked session is not — but it is a real cost, and it is
recorded rather than assumed away.

**Clause 3 is a residual hole.** A goal that has never acted, whose human then
works in a different session, is still adopted. Closing it needs a signal the
plugin does not have.

---

# The second report: the same defect through the TUI plane

> 这个问题还是存在，不能按照session来分开吗

Checked before anything was changed: the install matched the build by md5, and both
processes started at **19:01**, after the **17:25** commit. So the code was current
and the server-side fix was loaded — and the defect was still there.

`autoStart()` in `src/tui.tsx` read the session open on the router and kicked a
round **there**, with no question about whether that session was the goal's room. It
is driven by the sidebar poll *and* by `session.execution.succeeded`, so a turn
completing in any session re-ran it — which is the reported symptom arriving through
the command plane rather than the driver.

Measured, in the TUI harness: after `/goal` in `ses-room`, navigating to
`ses-elsewhere` took `prompts.length` from 1 to **2**, and the second round was
submitted into `ses-elsewhere`.

## The fix

The same three-clause rule the driver uses, because it is the same question: the
goal works in one room, and a goal with no room of its own adopts the open session —
which is ticket 26's case, a goal written by another writer whose room this process
never saw.

The server driver's gate was necessary and not sufficient. **A defect that lives at a
seam both entry points cross has to be closed at both.**

## Tests — four, two of which fail on HEAD

The two that pass on `HEAD` do so on purpose: the goal still starts in its own room
with no human input, and a goal with no room still starts in the session that is
open. Both are the behaviour the fix must not break.
