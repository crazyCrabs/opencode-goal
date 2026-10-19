# Should the status set gain usage_limited and budget_limited

Type: grilling
Status: resolved
Blocked by: —

## Question

Should `GoalPhase` grow states, or is DSH's four-state set with block codes the
right shape?

The four sets:

- DeepSeek Harness: `active | paused | blocked | complete`
- pi-goal: `active` (including waiting, non-terminal) `| paused | blocked | usage_limited | budget_limited | complete | cleared`
- Codex CLI: `active | paused | blocked | usage_limited | budget_limited | complete`
- This plugin: `active | paused | blocked | complete`

Both references make `budget_limited` a distinct state. This plugin folds it
into `blocked` with a `budget-limited` code. Both references have `usage_limited`
for provider quota and rate limits; this plugin has nothing — a 429 looks like an
ordinary failure, and `drive()` disarms on provider error.

Decide the set, and decide how the phase/activation split carries a state that
means "stopped by the system, not by a human or the model".

**Prior art adds a state none of the references has.**
[What did the earlier opencode goal plugins get right and wrong](./02-what-did-the-earlier-opencode-goal-plugins-get-right-and-wrong.md) found
`prevalentWare` running `active | paused | complete | unmet | budgetLimited | usageLimited`.
`unmet` is a terminal state meaning *tried and failed* — distinct from `blocked` (still
stuck) and from `complete` (succeeded). Neither DSH, pi-goal nor Codex has it, and this
plugin lacks it too, so a goal that was attempted and abandoned is indistinguishable from
one that is merely stuck. Decide whether it belongs, and note that both prior plugins also
carry `budgetLimited` and `usageLimited`, which independently corroborates those two.

## Answer

Jev over three questions. Verdicts and probabilities in
[`jev-0506-verdicts.md`](../../../../AppData/Local/Temp/opencode-goal-rework/jev-0506-verdicts.md).

| Question | Verdict | Confidence |
| --- | --- | --- |
| `phase_set` | **dsh-4** (0.620 over codex-6 0.370) | **0.49 → ESCALATED** |
| `unmet_belongs` | **NO** (0.40, near 0.5) | — |
| `usage_limited_gap` | **YES** (0.90) | — |

### The phase set stays DeepSeek Harness's four

`active | paused | blocked | complete`. Escalated, so recorded with the escalation
standing rather than smoothed over: 0.62 against 0.37 is a majority, not a
confident answer. It is adopted because the human delegated this decision set to
Jev and Jev returned it, and because the two other verdicts make it coherent.

### But the usage gap is closed — with a code, not a phase

`usage_limited_gap` is the one unambiguous verdict in the set (0.90). So the gap
is real and in scope; Jev's answer for closing it is *not* a new phase.

Today a provider quota or rate-limit error leaves the goal `active` with
process-local `disarmed`. Nothing durable records that the stoppage was the
provider, and the goal reads as alive while never advancing — the exact failure
mode this rework exists to remove. And the information exists on the wire:
ticket 03's recording found `session.execution.failed` carrying
`error: { type: "provider.auth", message: "...", status: 403 }` and
`session.step.failed` carrying the same object alongside its `location`.

So the provider-quota stop becomes a durable `blocked` carrying a **new
`usage-limited` code**, alongside the existing `round-limit`, `budget-limited`
and `no-progress`. The gap is closed — durable state now records why the goal
stopped and that it was the provider — without growing the phase set, and it
composes with ticket 06's block gate, which stops on `usage_limited` immediately
rather than gating it for three rounds.

### `unmet` does not belong

NO at 0.40, inside Jev's near-0.5 band. One source of five, and Codex CLI — the
authority on what the model may declare — gives the model exactly two verbs,
`complete` and `blocked`. There is no model statement for "tried and failed", so
the state could only be reached by a system inference that no reference defines.

### How the phase/activation split carries "stopped by the system"

The split stays exactly as it is: `GoalPhase` durable, `GoalActivation`
process-local, continuation requiring both `active` and `armed`. "Stopped by the
system" is carried by the **block code**, not the phase:

| Phase | Who stopped it |
| --- | --- |
| `paused` | the human |
| `complete` | the model, with evidence |
| `blocked` + `round-limit` / `budget-limited` / `no-progress` / `usage-limited` | the system, and the code says which |

That keeps the phase set the same size as DeepSeek Harness's while every stop is
still machine-routable through `GoalBlockReason.code`. Both prior plugins
carrying `budgetLimited` and `usageLimited` as phases is recorded as the
dissenting view, not overruled.
