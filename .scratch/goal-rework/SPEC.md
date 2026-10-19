# Spec — reworking the `opencode-goal` continuation loop

Status: drafted from 9 resolved grilling tickets and 4 live recordings, and now
implemented — tickets 13 through 22 plus the four the implementation found
(24 through 27). The acceptance run has happened and passes: see ticket 23 for
the before/after diff, the one difference that is not a rework difference, and
the one limitation (both runs go through `opencode serve`, not an interactive
TUI). What remains open is ticket 09's TUI observation, which needs a human at an
interactive terminal, and the human's confirmation of the one-line pass mark
ticket 10 supplied under the standing authorisation. Neither blocks the body.

## Problem Statement

I run a long-lived goal in opencode and the plugin that is supposed to keep the
agent working on it does not give me a continuation loop I can trust. Concretely:

- I cannot tell whether a goal stopped because it finished, because it is genuinely
  stuck, because it hit a budget, or because the provider refused it. A 429 looks
  like an ordinary failure, and the goal is left `active` with a process-local
  disarm — it reads as alive and never advances again, with nothing durable
  recording why.
- The model has to call `get_goal` first and copy back two fields exactly, and a
  missed digit is a rejected mutation. The machinery I never see is the machinery
  the model can get wrong.
- A goal that is working can be blocked for repeating its phrasing, because the
  no-progress guard cannot see that it made tool calls in between.
- A `goal_wait` with no deadline does not wait at all, and one with a deadline is
  never woken by a human arriving — both contradict what the tool's own
  description promises.
- Admission policy lives in two places that have already drifted from each other:
  the server driver clears an expired wait and catches a lost race, the human
  command plane does neither.

The plugin's claims about opencode v2's event semantics cannot be verified from
its own source, because the code and the comments disagree with each other and
with the documentation.

## Solution

One module owns the decision of whether a goal round may be admitted, and both
entry points — the server driver and the human command plane — cross that single
seam, so one policy governs. Accounting moves off the session transcript and onto
the durable native events, so the budget and the no-progress guard stop reading a
whole transcript per turn and stop silently under-counting after a restart. The
phase set stays small; every stop the system makes is a routable code rather than
a new state. The model stops quoting internal refs, and what it declares when it
claims completion becomes auditable rather than a sentence.

Accepted by a recorded scenario: a real opencode v2 server runs `/goal
<objective>` to a natural stop, with every round's prompt, tool call and event
captured, before and after.

## User Stories

### The human

1. As a goal owner, I want a goal that stops to always leave a durable, machine-routable
   reason, so that I can tell a finished goal from a stuck one from a budget-exhausted
   one from a provider-refused one without guessing.
2. As a goal owner, I want the goal to record that a provider refused it, so that a
   quota stop is not mistaken for the goal being broken.
3. As a goal owner, I want one admission policy rather than two, so that `/goal resume`
   and the autonomous driver cannot disagree about whether a round may start.
4. As a goal owner, I want the same run recorded before and after the rework and
   diffed, so that "it works" is an artifact rather than an opinion.
5. As a goal owner, I want a single condition that, if it fails, means the rework has
   not worked, so that I have a pass mark and not just an artifact.
6. As a goal owner, I want the TUI's event stream observed, so that a decision made on
   the strength of the CLI path alone is either confirmed or reversed.

### The model

7. As the model, I want to declare completion without quoting an id and a revision, so
   that a typo cannot reject my mutation.
8. As the model, I want my completion claim to be checkable, so that the work I
   actually did is visible rather than my summary of it.
9. As the model, I want to list the criteria I met with the evidence for each, so that
   a partially-met objective is not recorded as a success.
10. As the model, I want to record the commands I ran and their exit codes, so that a
    claim of verification is falsifiable.
11. As the model, I want `pause`, `resume`, `edit` and `wait` to remain mine to call,
    so that I can hand control back and take it again.
12. As the model, I want `goal_wait` to require a deadline, so that I cannot put a goal
    to sleep with no bound on it.
13. As the model, I want my wait to end when a human arrives, so that I do not sit
    silent while someone is typing at me.
14. As the model, I want a repeated sentence not to be read as no progress while I am
    making tool calls, so that I am not blocked for working.
15. As the model, I want a turn in which I say nothing and do nothing to be caught as a
    stall, so that a goal that has gone quiet is stopped rather than looping.
16. As the model, I want a reported impasse to be challenged for several rounds before
    it is accepted, so that declaring `blocked` is not an easy way out.
17. As the model, I want a round cap or a budget that has actually been reached to stop
    the goal immediately, so that arithmetic is not re-litigated.

### The plugin

18. As the plugin, I want the admission decision behind one interface, so that fixing a
    policy bug fixes it everywhere.
19. As the plugin, I want both entry points to call the same admission, so that drift
    between them is structurally impossible.
20. As the plugin, I want the one-round-at-a-time invariant enforced where it can be,
    so that a prompt submitted mid-turn is never coalesced away.
21. As the plugin, I want usage folded from durable events, so that a restart cannot
    silently under-count what a goal has spent.
22. As the plugin, I want the assistant text for the no-progress guard taken from a
    durable event, so that the guard does not depend on a transcript read succeeding.
23. As the plugin, I want the no-progress guard to observe tool calls, so that "any tool
    call resets the streak" is implementable without reading the transcript.
24. As the plugin, I want the session directory learned from a location-bearing event,
    so that attributing a location-less completion event costs no lookup.
25. As the plugin, I want a subagent identified before its turns are driven, so that a
    goal prompt is never injected into a sub-agent's narrow context.
26. As the plugin, I want a wait that survives a restart, so that a goal does not
    silently un-wait.
27. As the plugin, I want a wait that expires to stop the goal with a code, so that a
    goal which waited and got nothing is not resumed blind.
28. As the plugin, I want every guardrail breach to name which guardrail fired, so that
    the reason a goal stopped is one field away.
29. As the plugin, I want the transcript read removed, so that a failed read is no
    longer a silent failure retried at the next idle.
30. As the plugin, I want a lost compare-and-set race handled by every entry point, so
    that a concurrent writer never produces an unhandled rejection.
31. As the plugin, I want the goal's prompt rendered in one place, so that changing what
    a round says does not touch the admission policy.
32. As the plugin, I want the phase set to stay the size of the reference
    architecture's, so that the durable state does not grow states it does not need.

## Implementation Decisions

### The admission module

1. **One module owns the admission decision.** It answers "may this round be admitted,
   and if so commit it", and nothing else. Trigger routing, event-shape normalisation,
   usage accounting and prompt submission stay at the adapter.
2. **Its interface is one function with no parameter naming the caller.** Both entry
   points run identical policy, so a `cause` argument would encode nothing.

   ```ts
   function admitRound(store: GoalStore): AdmissionVerdict

   type AdmissionVerdict =
     | { kind: 'admitted'; round: number }
     | { kind: 'blocked'; reason: GoalBlockReason }
     | { kind: 'rejected'; code: 'not-active' | 'disarmed' | 'stale-ref' | 'waiting' }
   ```

   This shape encodes a decision; it is not an implementation.
3. **Inside it:** the guardrails, compare-and-set admission, external-wait deadline
   expiry, and block-on-guardrail-breach tolerating a lost race. **Left at the
   adapter:** directory resolution, per-session in-flight tracking, usage accounting,
   prompt submission, and reporting.
4. **It takes an already-resolved store, not a session.** The adapter has already
   resolved the directory before calling. This is a consequence of the event layer:
   the completion events carry no location.
5. **Both entry points cross the seam** — the server driver and the human command
   plane. This is what fixes the two drifts by construction: an expired wait is
   cleared once, and a lost compare-and-set race is tolerated once.
6. **The round prompt moves to its own module**, so the human command plane no longer
   imports the server half just to render a prompt, and prompt wording changes do not
   churn admission.
7. **Admission is single-phase.** `commit` is a synchronous append, durable on return,
   and every read re-folds the log before answering — so the reference architecture's
   two-phase protocol (reserve, await a checkpoint, re-check after the await, race
   fences) collapses to one phase and no second phase is added.

### The one thing that stays non-unified

8. **The one-round-at-a-time invariant is enforced by two different mechanisms, and
   that is the correct answer rather than a gap.** The server knows from its event
   stream whether a round is in flight; the human command plane can only ask the UI
   whether a turn is active. Forcing one mechanism would push a session concept into
   the UI or a UI probe into the server.

### The trigger layer

9. **The turn-completion signal is `session.execution.succeeded|failed|interrupted`**
   and nothing else. Verified across four recordings, including a two-step turn with
   two tool calls.
10. **The legacy `session.idle` path stays, patched as today — and is gated on the
    live-server observation.** Jev's verdict was a coin flip (0.55 against 0.40,
    confidence 0.33) tipped by the fact that the TUI was never observed. If the
    observation confirms the signal is absent there too, the path is deleted and this
    decision is superseded.
11. **The session directory is learned from `session.step.started`'s
    `location.directory`**, which fires at the start of every step and always precedes
    the completion event of the same session. No lookup is needed for the completion
    path at all.
12. **`session.get` is narrowed to one job: learning whether a session is a subagent,
    for a session never seen created.** It stops being the directory source. Its dead
    first branch (`info.directory`) goes, since the shape carries only
    `location.directory`.
13. **The session directory map keeps two entries, both load-bearing:** directory
    attribution for the four location-less events, and subagent exclusion.
14. **Subagent sessions are excluded at the event adapter**, and the admission module
    never learns that a subagent exists. A session created with a parentID never
    receives a goal round; deferral is the wrong tool, because a parent turn's
    completion already contains its subagent tool calls, so there is no overlap to
    wait for.

### Which events feed the loop

15. **Usage folds from `session.step.ended`.** It is durable, carries `location`, and
    carries `{ sessionID, assistantMessageID, cost, finish, rawFinish, tokens }`.
16. **The folding sums per-step deltas.** `session.step.ended` carries a step's delta;
    `session.usage.updated` carries a running cumulative total and fires more than
    once per step. The arithmetic was verified exactly against a two-step turn:
    successive cumulative differences equal the step deltas.
17. **`session.usage.updated` is not used.** It is `durability: "ephemeral"`, confirmed
    both in the schema and by a live envelope carrying no `durable` key. Folding an
    ephemeral event into a durable counter under-counts silently after a restart,
    which is the one failure mode a budget guard cannot have. It also carries no
    `location`.
18. **The no-progress guard's text comes from `session.text.ended`**, which is durable,
    carries `location`, and carries `{ sessionID, assistantMessageID, ordinal, text }`.
    An assistant message with several text parts arrives as several events, which must
    be collected before the fold.
19. **Tool calls come from `session.tool.*`.** `tool.input.started`, `tool.input.ended`,
    `tool.called` and `tool.success` are durable; `tool.progress` is ephemeral.
20. **The transcript read dies.** `accountSession`, the per-session cursor, the
    whole-transcript fetch per turn, and the silent retry-on-failed-read path all go.
    Every field the fold extracted now has a native event.
21. **Usage accounting becomes its own module.** Three event families now feed one
    concern, and the no-progress guard and the token budget would otherwise share
    bookkeeping through the adapter — which is the reasoning that changed from when
    accounting was a thin accumulation over events admission already routed.

### The guardrails

22. **A goal round is one admitted goal-sourced turn; a human turn is not a round.**
    Round counting already satisfies this, because only the admit mutation bumps the
    counter. Accounting now satisfies it too: usage and the no-progress fingerprint
    distinguish goal rounds from human turns instead of folding every assistant
    message newer than the last accounted one.
23. **The round cap default is 25.** Escalated at confidence 0.51, 0.63 against 0.35
    for the reference architecture's 256.
24. **The token budget stays**, and its breach is a block code, not a phase. This was
    the weakest verdict in the effort (0.57, in the near-0.5 band) and is the decision
    most worth revisiting if the implementation argues for it — the architecture this
    plugin's durability model comes from deliberately refuses token metering.
25. **The no-progress guard adopts "any tool call resets the streak"**, with the same
    count of three. Today it folds only the last assistant text and cannot see tool
    calls, so an agent that is working but repeats its phrasing is falsely blocked —
    the guard's worst failure mode, because it stops a goal that was working.
26. **A second stall counter is added:** too many consecutive turns with no tool call at
    all. The two counters are opposite in spirit and do not conflict — a tool call
    resets the no-progress streak and breaks the no-tool-call streak. A stretch with no
    tool calls does not always produce empty text; it produces the same text.

### The status set and how stops are routed

27. **The phase set stays `active | paused | blocked | complete`.** Escalated at 0.49,
    0.62 against 0.37.
28. **Every system stop is a block code, not a phase.** `round-limit`,
    `budget-limited`, `no-progress`, `usage-limited`, `wait-expired`,
    `provider-unavailable`. `paused` remains the human stop and `complete` the
    model's.

    **Amended by ticket 29.** `provider-unavailable` was added because a transport
    failure was being classified as `usage-limited`, which is wrong in a way that
    costs the human time: a dead network and an exhausted subscription need
    different action, and the message sent them to their account. The refusal
    classifier's own documented policy — *a dropped connection is transient, and
    stopping a goal for one would lose work the next attempt would have finished* —
    was contradicted by its fallback branch, which sent every status-less
    `provider.*` error down the stop path. `provider.transport` is a status-less
    `provider.*` error. A transport failure now rides out, three consecutive ones
    stop the goal, and a failed turn no longer counts toward the `no-tool-call`
    stall guard, which is a claim about the model's behaviour and says nothing
    about a turn that never ran.
29. **A new `usage-limited` code closes the provider-quota gap.** Today a 429 leaves
    the goal `active` with a process-local disarm: nothing durable records that the
    stoppage was the provider, and the goal reads as alive while never advancing. The
    information is on the wire — `session.execution.failed` carries
    `error: { type, message, status }` — so the stop becomes durable `blocked` with a
    code naming the provider.
30. **`unmet` does not belong.** "Tried and failed" as a terminal phase appeared in one
    source of five, and the model-facing minimum gives the model exactly two verbs,
    `complete` and `blocked`. There is no model statement for it, so it could only be
    reached by a system inference no reference defines.

### The block gate

31. **The gate is two-tiered.** Judgment blocks — a model-reported `blocked`, and
    `no-progress` — are rejected until the same condition persists three consecutive
    rounds. Arithmetic stops — `round-limit`, `budget-limited`, `usage-limited`,
    `wait-expired` — stop immediately. Gating an arithmetic limit that has already been
    reached has no defensible reading, and that option scored zero.
32. **`no-progress` joins the judgment tier** on the grounds that it is a verdict about
    the agent rather than a fact about the budget.

### The external wait

33. **`goal_wait` stays, and its deadline and reason become durable.** A wait that
    evaporates on restart is a goal that silently un-waits, indistinguishable from one
    that never waited. Two verdicts conflicted here — the choice question preferred
    "keep as today, process-local" at 0.60 while the independent question said durable
    at 0.76 — and the durable one was taken because it is the stronger and cleaner
    signal and names the failure mode this rework exists to remove.
34. **`resume_after_ms` becomes a required argument.** Leaving the wait unguarded
    scored zero. This also fixes the double-booked sentinel: today `waitUntil = 0`
    means both "not waiting" and "waiting with no deadline", which is why a wait with
    no deadline does not wait at all. With a deadline always present, the ambiguity is
    gone. The cost is recorded: a genuinely open-ended wait is no longer expressible.
35. **The wake is a user item arriving at `session.inbox.enqueued`.** It is the only
    native signal that a human arrived, and it arrives before the turn is submitted
    rather than after it finished. Distinguishing it from the goal's own continuation
    prompt is free, because the plugin only submits a prompt when admission is not
    suppressed, so while a goal is waiting no goal-originated inbox item can arrive.
36. **Expiry blocks with a `wait-expired` code rather than resuming.** Escalated at
    0.29, 0.52 against 0.46 — the weakest verdict in the effort and the one most worth
    revisiting.

### The model-facing surface

37. **`update_goal` takes an action and its payload.** `goal_id` and `revision` leave
    the model's vocabulary; the server resolves which goal the session is working on.
    The whole class of "call `get_goal` first, copy two fields, be rejected on a typo"
    disappears.
38. **The tool bundle stays at four:** `get_goal`, `create_goal`, `update_goal`,
    `goal_wait`. Only arguments and descriptions change. Splitting `goal_complete` and
    `goal_blocked` into their own tools scored 0.020, because `action` already names the
    operation once the ref is gone.
39. **The model still owns `pause`, `resume`, `edit` and `wait`.** The reference's
    restriction to `complete | blocked` is deliberately not adopted; the model-facing
    surface scored 0.01 as a target, and reworking the model's lifecycle ownership
    belongs to a different effort.
40. **A `complete` claim carries structured criteria and checks:**

    ```ts
    {
      summary: string,
      criteria: [{ criterion: string, evidence: string[] }],
      checks: [{ command?: string, result: 'passed' | 'failed' | 'not-run', exitCode?: number, explanation?: string }]
    }
    ```

    This shape encodes a decision and is not an implementation. It is the prior art's
    shape, adopted at 0.970 (confidence 0.96) — the strongest verdict in the effort.
41. **It is not an external verifier.** The model still declares its own completion.
    What changes is that the declaration is auditable against the recorded scenario,
    including the commands it ran and their exit codes.
42. **The claimed exit codes are cross-checkable against the events.**
    `session.tool.success` carries `metadata`, which for a shell command included
    `{ status, truncated, exit }` — so the exit code of a command the model actually
    ran is natively observable and does not have to be trusted from the summary.
43. **The marker-in-prose alternative is rejected**, as its own authors concede it is
    fragile and model-dependent.

### The two drifts, and where the fix lands

44. **Both drifts are recorded in a carry ticket** rather than folded silently into this
    spec, because this effort is planning-only and the code lands later. One ticket,
    not two: they share one root cause, and splitting them would cut one decision into
    two.

## Testing Decisions

45. **The spec is accepted by a recorded scenario, not by a unit count.** The same run
    is recorded before and after and diffed. That is an objective artifact; its pass
    mark is the human's, and is still outstanding.
46. **A good test crosses an interface, not an implementation.** The admission module's
    tests go through `admitRound(store)` and nowhere else — if a test needs to reach
    past it, the module is the wrong shape.
47. **The seam is one, and the test surface is that seam.** Two adapters cross it (the
    server driver and the human command plane), so both are exercised through the same
    tests. A third adapter would not be tested at a new seam.
48. **The accounting module is tested through the events it consumes**, not through the
    transcript it no longer reads. The multi-step recording in `assets/` is the fixture
    for the sum-of-deltas arithmetic; it contains a two-step turn whose cumulative
    differences equal the step deltas exactly.
49. **The guardrails are tested at the verdict, not the internals.** "Three consecutive
    identical texts blocks", "a tool call resets", "a reached cap stops immediately",
    "a judgment block is retried for three rounds" are all assertions about
    `AdmissionVerdict`.
50. **The two-tier gate is tested by tier, not per code**, because the tier is the
    decision and the codes are its members.
51. **Prior art for the test surface:** the earlier goal plugins ship an executable
    live-server smoke test rather than README prose, and this spec's acceptance should
    be no weaker than that. The read-only spy plugin that produced the four recordings
    is the seed of the acceptance harness and should be extended, not rebuilt.
52. **A missed event is a test case, not an assumption.** The event layer is now the
    source of truth for the budget, so the accounting tests include "one step event
    never arrived" and assert the counter under-counts rather than double-counts.

## Out of Scope

53. **The model-facing tool contract as a target surface.** It scored 0.01. What is in
    scope is only the consequence of hiding the ref — the arguments, the prompt, and
    what `complete` must carry.
54. **The human command plane's UX.** Toasts, palette entries and the sidebar row
    scored 0.00. The plane still executes the first round and crosses the admission
    seam, but its interface design is not part of this.
55. **Which model lifecycle verbs the model owns.** Settled at charting as unchanged,
    and recorded as a standing parameter. The reference's answer is a different effort.
56. **npm packaging and the release process.**
57. **A README rewrite.** It follows the spec; it does not shape it.

## Further Notes

58. **Three decisions in this spec are escalated verdicts** — Jev named a winner and
    refused to stand behind the margin: the `session.idle` path (0.55/0.40, confidence
    0.33), the round cap default (0.63/0.35, 0.51), and the two-tier gate (0.63/0.37,
    0.45). They are recorded with their margins showing rather than smoothed, and they
    are the three most worth revisiting.
59. **One decision is a synthesis rather than a verdict.** The wait's durability: two
    verdicts conflicted, and the durable one was taken because the stronger and cleaner
    signal was the independent question at 0.76, against 0.23 for the explicit
    "keep as today" option.
60. **Two decisions are gated on the live-server observation.** The `session.idle` path
    (this spec's decision 10) turns on whether the signal appears in the TUI. Whether
    `session.created` ever fires is visible in the same recording, and if it is absent
    there too, a goal surviving a restart never re-arms itself without a human — which
    would be a new decision, not a settled one.
61. **The acceptance pass mark is the human's and is outstanding.** The recorded
    scenario is the artifact; the single condition that makes it a pass is not yet
    given, and it is not inferred here.
62. **Every recorded event fact in this spec came from a live opencode v2.0.14
    server.** Four recordings are in `assets/`. Where the schema and a live envelope
    disagree, the live envelope wins; where the plugin's source comment and a live
    envelope disagree, the live envelope wins.
