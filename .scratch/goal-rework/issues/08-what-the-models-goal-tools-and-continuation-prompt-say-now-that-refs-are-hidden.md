# What the model's goal tools and continuation prompt say now that refs are hidden

Type: grilling
Status: resolved
Blocked by: —

## Question

With the compare-and-set ref moved inside the server, what does the model still
have to know?

Today every mutation needs the exact `goal_id` and `revision` echoed back, so the
model must call `get_goal` first and copy two fields — and a missed or
misremembered one is a rejected mutation. Codex's answer to the same shape is a
`get_goal` returning status, budgets and remaining usage, plus an `update_goal`
restricted to `complete` or `blocked`.

This ticket is not the model-tool-contract rework — that surface scored 0.01 as a
target. It is the consequence of hiding the ref: what `update_goal`'s arguments
become, what `renderGoalRoundPrompt` and the system-prompt block say now that
there is no ref to quote, and what evidence "complete" must carry given the
three-consecutive-round block gate adopted at charting.

**Prior art already answered the evidence question, and better than a free-text string.**
[What did the earlier opencode goal plugins get right and wrong](./02-what-did-the-earlier-opencode-goal-plugins-get-right-and-wrong.md) reports
that `william-ricchiuti`'s `goal_complete` takes a structured claim: `{summary, criteria:
[{criterion, evidence[]}], checks: [{command?, result: passed|failed|not-run, exitCode?,
explanation?}], changedFiles?, knownLimitations?}`. This is not an external verifier — the
model still declares its own completion — but it forces the claim into a shape that can be
audited, including the commands it ran and their exit codes. Decide whether to adopt it.
Avoid the same repo's marker-in-prose alternative (`[goal:complete]` honored only when
adjacent to `[goal:evidence]`), which it admits is fragile and model-dependent.

## Answer

Jev over four questions. Verdicts in
[`jev-0811-verdicts.md`](../../../../AppData/Local/Temp/opencode-goal-rework/jev-0811-verdicts.md).

| Question | Verdict | Confidence |
| --- | --- | --- |
| `update_goal_shape` | **action-and-payload** (0.740) | 0.60 |
| `structured_claim` | **YES** (0.60) | near 0.5 |
| `evidence_bar` | **criteria-and-checks** (0.970) | 0.96 |
| `tool_count` | **NO — stays at four** (0.40) | near 0.5 |

### `update_goal` takes an action and its payload, nothing else

`goal_id` and `revision` disappear from the model's vocabulary. The server
resolves which goal the session is working on, and the compare-and-set ref that
ticket 04's seam already owns becomes an internal detail in both senses. A missed
or misremembered field can therefore no longer reject a mutation — the whole
class of "call `get_goal` first, copy two fields" goes away.

`split-tools` scored 0.020. Splitting `goal_complete` and `goal_blocked` into
their own tools buys nothing once the ref is gone, because `action` already names
the operation.

### The bundle stays at four

`tool_count` = NO at 0.40, in Jev's near-0.5 band, so recorded with that margin.
Only the arguments and descriptions change. The set is `get_goal`,
`create_goal`, `update_goal`, `goal_wait` — the same four as today, with
`resume_after_ms` now required on the wait (ticket 07).

This ticket is the consequence of hiding the ref, not the model-tool-contract
rework — that surface scored 0.01 as a target. The standing parameter still
holds: the model keeps `pause`, `resume`, `edit` and `wait`, and Codex's
restriction to `complete | blocked` is deliberately not adopted.

### The completion claim is structured, and it carries checks

Two verdicts here, one much stronger than the other.

`structured_claim` = YES at 0.60, near 0.5 — genuinely uncertain. The reasoning
that tips it: ticket 06 gates a model-reported `blocked` until the same condition
persists three consecutive rounds, and that gate only works if the model's own
claims can be compared across rounds. A free-text summary is unfalsifiable; a
structured one is comparable.

`evidence_bar` = **criteria-and-checks at 0.970, confidence 0.96** — the strongest
verdict in this pass. So `complete` carries
`{ summary, criteria: [{ criterion, evidence[] }], checks: [{ command?, result: passed|failed|not-run, exitCode?, explanation? }] }`.
This is `william-ricchiuti`'s shape, adopted because it is the only bar that
records *what was verified*, and the commands it ran with their exit codes.

It is still not an external verifier. The model declares its own completion; what
changes is that the declaration is auditable against the recorded scenario this
effort's spec is accepted by.

The marker-in-prose alternative from the same repo is not considered, exactly as
the ticket directs — its own authors call it fragile and model-dependent.
