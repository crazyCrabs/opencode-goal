# 21 — Human turns stop spending the goal's budget, and a second stall counter is added

**Type:** implementation
**Status:** resolved

**What to build:** a human asking a question no longer spends the goal's round budget
or moves its no-progress fingerprint, and a goal that talks without acting is caught as
stalled even when it keeps producing fresh text.

**Blocked by:** 14 — Usage accounting moves off the transcript onto durable native
events; 18 — The block gate is two-tiered

## Acceptance criteria

- [x] A human turn does not consume a round. This already held for the round counter,
      because only the admit mutation bumps it, and there is a test that keeps it true.
- [x] A human turn no longer spends the token budget or moves the no-progress
      fingerprint. This is the change: accounting now distinguishes goal rounds from
      human turns instead of folding every assistant message newer than the last
      accounted one.
- [x] A second stall counter counts consecutive turns with no tool call at all. A goal
      that talks without acting is stopped even when its text keeps changing.
- [x] The two counters do not conflict, and there is a test showing both holding at
      once: a tool call resets the no-progress streak and breaks the no-tool-call
      streak, in the same turn.
- [x] The no-tool-call counter's stop is a judgment-tier stop, so it is gated three
      consecutive rounds rather than stopping on the first observation.
- [x] Its threshold is configurable, and the default follows the prior art's value of 2
      unless the implementation argues otherwise in the pull request.
- [x] The round cap and the token budget remain as they are — cap default 25, budget
      default unlimited — and this ticket adds a test asserting those defaults so that
      changing them becomes visible.

**Recorded with its margin:** the token budget staying at all was the weakest verdict
in that ticket, 0.57 in the near-0.5 band. If the implementation argues for dropping
it, that is the decision to reopen — not the counter, the budget.

## Outcome

**202 tests pass, 0 fail. `tsc --noEmit` clean. `bun run build` clean.**

`GoalAccounting` gained an `isGoalTurn` hook — which the driver answers from its
in-flight set, the one set that knows whose prompt started the turn — and
`onTurnEnded`, which is the single place both stall counters are decided. A new
`no-tool-call` block code joined the judgment tier in ticket 18's table.

### Whose turn it is

`GoalDriver.roundsInFlight` was already the answer: a session enters it when a round's
prompt is submitted and leaves when the turn reports back. So the hook is a one-line
read of state that existed, and it lives on the driver rather than in accounting
because the driver is the only writer that can answer — the same reason `drive()`
already gives for not unifying the in-flight checks.

A step whose session is not a goal turn is skipped entirely: no usage folded, no text
fed to the no-progress guard. That closes both halves of the criterion at once — a
human's question no longer spends the token budget, and a human's rephrasing no longer
reads as progress.

### The second counter

`turnsWithoutToolCall` sits in the store's runtime beside `recentOutputs`, and the two
are reset by one method (`resetStallCounters`) and one event (`noteToolCall`). They are
deliberately not one counter: the no-progress guard catches a goal that says the same
thing, and this catches a goal that keeps saying different things while doing nothing.
One counter cannot hold both, and a goal whose text changes but whose hands stay still
is exactly the failure this one exists for.

`onTurnEnded` is called at `session.execution.*`, before the driver's own completion
handler, so a guardrail checked at admission sees the counters the turn that just ended
actually produced.

### One conflict, and how it is resolved

The ticket's criteria 5 and 6 cannot both be literally true. Criterion 5 says the stop
is "gated three consecutive rounds"; criterion 6 says the threshold defaults to the
prior art's value of 2. With a threshold of 2 and a separate three-round gate, the stop
would come at five consecutive tool-less turns, which is not what either sentence means.

The implementation resolves it by making the consecutive-turn threshold **be** the
persistence requirement for this condition — the tier still says "judgment, so
challenged rather than immediate", and the challenge length is what the threshold
configures. A reader who wants three sets it to three; the default follows the prior
art. This is the same shape `no-progress` already has, where the three-round count is
the challenge and is not separately gated.

### A related fix

`maxTurnsWithoutToolCall: 0` was accepted as "disabled" but read as "already stalled"
(`0 >= 0`), which would have blocked a goal on its first tool-less turn with no way to
turn the guard off. The guard now checks for zero before comparing.

## Related

- Ticket 18's tier table gained `no-tool-call` on the judgment side.
- The four integration tests that simulate working turns now emit a
  `session.tool.called` per turn. They were passing before by simulating turns that
  made no tool calls at all — which the new guard correctly reads as a stalled goal,
  so the tests had to start telling the truth about what the model did.
