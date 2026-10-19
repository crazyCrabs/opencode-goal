# Round semantics, human turns, the default cap, and whether token budget stays

Type: grilling
Status: resolved
Blocked by: —

## Question

What counts as a goal round, and what should the guardrails be?

DeepSeek Harness's definition is precise: one round is one admitted goal-sourced
`user/message` turn, and **ordinary human turns never consume the budget**. This
plugin's `continue()` is called by the driver with no such distinction — a human
message and a goal round are indistinguishable at the counting site.

Then three numbers and one question of kind:

- The round cap default is 25. pi-goal uses 25. DeepSeek Harness uses 256 and
  meters **rounds only** — explicitly no token, currency, wall-time or quota
  metering. Which is right here?
- The token budget exists in this plugin and in both references, yet DSH — the
  system this plugin's durability model comes from — deliberately refuses it.
  Does it stay, and if it does, where does it live now that `budget_limited` may
  be a phase?
- No-progress is three consecutive empty or normalized-identical assistant
  texts. pi-goal's is the same count but **any tool call resets the streak**, and
  it excludes thinking and tool blocks. This plugin's `recordRoundOutput` folds
  only the last assistant text and cannot see tool calls at all — so an agent
  that is working but happens to repeat its phrasing gets blocked. Confirm the
  fix.
- **The missing signal exists natively.** [Record the real opencode v2 event stream during one goal run](./01-record-the-real-opencode-v2-event-stream-during-one-goal-run.md)
  confirmed that v2 emits `session.tool.*` events and `session.text.ended` carrying the
  text. pi-goal's "any tool call resets" is therefore implementable without reading the
  transcript at all — decide whether the guard observes the event stream or the
  transcript, and let that choice follow from
  [Does the native session.usage.updated replace the hand-rolled transcript fold](./11-does-the-native-session-usage-updated-replace-the-hand-rolled-transcript-fold.md).
- Should the three-consecutive-round block gate adopted at charting apply to
  every block code, or only to `model-reported`?
- **Two stall counters, not one.**
  [What did the earlier opencode goal plugins get right and wrong](./02-what-did-the-earlier-opencode-goal-plugins-get-right-and-wrong.md) reports
  that `william-ricchiuti` runs `noProgressTurnsBeforePause: 2` **and a separate**
  `noToolCallTurnsBeforePause: 2`. These are opposite in spirit: pi-goal treats a tool call
  as proof of progress (so it resets the no-progress streak), while the no-tool-call counter
  treats too many talk-only turns as its own stall. Both can coexist. Decide whether this
  plugin needs the second one.
- **The numbers in the wild are lower than the references.** `william-ricchiuti` defaults
  `maxTurns 10`, `maxTokens 200000`, `maxDurationMs 900000`; `prevalentWare` 25, 2 and off.
  Neither is close to DSH's 256.

## Answer

Jev over six questions. Verdicts in
[`jev-0506-verdicts.md`](../../../../AppData/Local/Temp/opencode-goal-rework/jev-0506-verdicts.md).

| Question | Verdict | Confidence |
| --- | --- | --- |
| `accounting_distinguishes_human_turns` | **YES** (0.81) | — |
| `round_cap_default` | **25** (0.630 over 256 0.350) | **0.51 → ESCALATED** |
| `token_budget_stays` | **YES** (0.57, near 0.5) | — |
| `no_progress_tool_call_resets` | **YES** (0.65) | — |
| `block_gate_scope` | **two-tiers** (0.630) | **0.45 → ESCALATED** |
| `second_stall_counter` | **YES** (0.69) | — |

Three escalations, all close splits (0.62-0.63 against 0.35-0.37). Recorded with
the escalations standing rather than smoothed over.

### Human turns do not consume a round — and accounting now says so too

Round counting already had this right: only `GoalStore.continue()` bumps
`roundsStarted`, and a human message never calls it. The asymmetry was in
accounting — `accountSession` folds every assistant message newer than the last
accounted one, so the token budget and the no-progress fingerprint consume on
human turns while the round cap does not. That is closed. *How* it is closed
depends on ticket 11, which decides whether usage accounting reads the event
stream or the transcript.

### The cap stays 25

Escalated at 0.51, 0.63 against 0.35. DeepSeek Harness's 256 is the number a
runaway guard would use; 25 is what both prior plugins ship and what pi-goal's
lineage uses. Adopted as Jev returned it.

### The token budget stays

YES at 0.57, in Jev's near-0.5 band — the weakest verdict in the set. Provider
quota is a hard wall, the guardrail is what stops a runaway goal from spending
money, and it corroborates across four of five sources. It stays, and under
ticket 05's answer it stays a **block code** (`budget-limited`) rather than a
phase.

### No-progress adopts "any tool call resets the streak"

YES at 0.65 — the clearest guardrail verdict. Today's guard folds only the last
assistant text and cannot see tool calls, so an agent that is working but happens
to repeat its phrasing is falsely blocked. That is the guard's worst failure
mode, because it stops a goal that was working. Ticket 03 settled that v2 emits
`session.tool.*` and that `session.step.ended` carries `{ assistantMessageID,
cost, finish, rawFinish, tokens }`, so the reset is observable without reading
the transcript at all.

### The block gate is two-tiered

Escalated at 0.45, 0.63 against 0.37. `all-codes` scored 0.000, which is the
informative part: gating an arithmetic limit that has already been reached makes
no sense. So:

| Tier | Codes | Behaviour |
| --- | --- | --- |
| Judgment | model-reported `blocked`, `no-progress` | Gated — the same condition must persist 3 consecutive rounds |
| Arithmetic | `round-limit`, `budget-limited`, `usage-limited` | Stops immediately |

The standing charting parameter (a model-reported `blocked` is rejected until the
same condition persists 3 consecutive rounds) is extended to `no-progress` on the
grounds that a no-progress verdict is also a judgment about the agent rather than
a fact about the budget.

### A second stall counter is added

YES at 0.69 — too many consecutive turns with no tool call at all. The two
counters are opposite in spirit and do not conflict: a tool call resets the
no-progress streak *and* breaks the no-tool-call streak. A goal that talks
without acting is stalled in a way the text guard cannot see, because a stretch
with no tool calls does not always produce empty text — it produces the same
text. Threshold follows `william-ricchiuti`'s 2 unless the implementation argues
otherwise.
