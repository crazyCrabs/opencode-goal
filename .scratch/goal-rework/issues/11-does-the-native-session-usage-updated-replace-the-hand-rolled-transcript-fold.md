# Does the native session.usage.updated replace the hand-rolled transcript fold

Type: grilling
Status: resolved
Blocked by: —

## Question

Should usage accounting move off the transcript and onto the native event?

`src/driver.ts`'s `accountSession()` reads the whole session transcript through
`ctx.session.context({ sessionID })`, finds the last accounted message id, folds
every newer assistant message into a token/cost delta, and extracts the last
assistant text for the no-progress guard. It keeps a per-session cursor for
exactly that.

[Record the real opencode v2 event stream during one goal run](./01-record-the-real-opencode-v2-event-stream-during-one-goal-run.md)
established that v2 emits `session.usage.updated` carrying `{sessionID, cost,
tokens}`, and that `session.step.ended` carries `{finish, rawFinish, cost,
tokens}`. Both are native. The transcript read was the plugin's workaround for
v1's removed `message.updated`.

Decide which of the three survives:

- the transcript fold, as is
- fold `session.usage.updated` into the goal's counters instead
- both, cross-checked

Then decide where the surviving accounting lives, given that
`session.usage.updated` carries no `location` and therefore needs the same
directory-attribution fallback the execution family already uses. The no-progress
guard still needs the assistant *text*; note that `session.text.ended` carries
`text` natively, so check whether that covers it before keeping a transcript read
alive for one field.

## Answer

Jev over four questions. Verdicts in
[`jev-0811-verdicts.md`](../../../../AppData/Local/Temp/opencode-goal-rework/jev-0811-verdicts.md).

| Question | Verdict | Confidence |
| --- | --- | --- |
| `usage_source` | **step-ended** (0.970) | 0.96 |
| `text_source` | **text-ended** (0.670) | **0.50 → ESCALATED** |
| `transcript_read_dies` | **YES** (0.64) | near 0.5 |
| `accounting_location` | **YES — its own module** (0.67) | — |

### The fact that decided it: durability

The ticket framed this as "transcript fold, or `session.usage.updated`, or both".
That framing missed the decisive property, which survives in neither the ticket
nor the plugin's source comments:

- `session.usage.updated` has **`durability: "ephemeral"`** in the schema, and a
  live envelope confirms it — its keys are `[id, created, type, data]`, with no
  `durable` field at all.
- `session.usage.recorded` is durable, with `location` optional.
- `session.step.ended` is durable, carries `location`, and carries
  `{ sessionID, assistantMessageID, cost, finish, rawFinish, tokens }`.
- `session.text.ended` is durable, carries `location`, and carries
  `{ sessionID, assistantMessageID, ordinal, text }`.

The goal's token counter is durable, and ticket 05 makes its breach a durable
`blocked`. Folding an **ephemeral** event into a durable counter under-counts
silently after any restart — the goal would believe it has spent less than it
has, which is the one failure mode a budget guard cannot have. Jev scored
`usage-updated` **0.000** and `transcript-fold` **0.000**, and `step-ended`
0.970.

So the answer is neither of the ticket's two named options and not the cross-check:
it is a **third durable event the ticket did not list**.

### What folds where

| Field | Source |
| --- | --- |
| `inputTokens`, `outputTokens`, `cost` | `session.step.ended` |
| Assistant text for the no-progress guard | `session.text.ended` |
| Tool calls that reset the no-progress streak | `session.tool.*` (ticket 06) |

`session.step.ended` also carries `location`, so ticket 03's directory-attribution
problem does not apply to it at all — the location-less set stays the four
events ticket 03 enumerated.

`session.text.ended` carries one `ordinal` per text part, so an assistant message
with several text parts arrives as several events that must be collected before
the fold. That is the whole cost of moving off the transcript.

### The transcript read dies

YES at 0.64, near 0.5. Every field the fold extracts now has a native event, so
`accountSession()`, the per-session `AccountedState` cursor, the whole-transcript
fetch per turn, and the silent retry-on-failed-read path all go.

Caveat recorded honestly: the cross-check argument for keeping the read is real —
events can be missed and the transcript is authoritative. Jev scored "both" at
0.300 for the text source, which is that argument's residual weight. The reason
it loses is that a missed event now under-counts the budget rather than
double-counting it, and the guardrails are the wrong place to be silently wrong.

### Accounting becomes its own module

YES at 0.67. Ticket 04 left accounting at the adapter on the grounds that it was
a thin accumulation over events admission already routed. Three event families
now feed one concern, and the no-progress guard and the token budget would
otherwise share bookkeeping through the adapter, so the reasoning that moved it
out has changed.

### The gap is closed — the fold sums, and the arithmetic is exact

The condition above was recorded as open, and has since been settled by a fourth
recording (`assets/recording-runD-multistep-tools.jsonl`): a **two-step turn with
two tool calls** (`read` and `shell`) on opencode 2.0.14. The numbers:

| Event | tokens (in / out / reasoning) | Reading |
| --- | --- | --- |
| `session.usage.updated` | 37 / 17 / 773 | cumulative, first |
| `session.step.ended` (step 1, `finish=tool-calls`) | 10955 / 76 / 56 | **step delta** |
| `session.usage.updated` | 10992 / 93 / 829 | cumulative |
| `session.step.ended` (step 2, `finish=stop`) | 2722 / 9 / 60 | **step delta** |
| `session.usage.updated` | 13714 / 102 / 889 | cumulative |

`10992 − 37 = 10955` and `13714 − 10992 = 2722`, both exact. So
**`session.step.ended` carries a per-step delta and `session.usage.updated`
carries a running cumulative total**. The fold **sums** the deltas; it does not
diff. This is now settled, not conditional.

`session.usage.updated` also fires **more than once per step** — three times
across a two-step turn — which makes it unusable as a step counter on top of
being unusable because it is ephemeral.

Two further facts from the same recording, both needed by the spec:

- **`session.tool.success` carries `metadata`**, which for the shell tool
  included `{ status: "completed", truncated: false, exit: 0 }`. So the exit code
  of a command the model ran is **natively observable** — which is exactly the
  `checks: [{ command, result, exitCode }]` shape ticket 08 adopted for the
  completion claim. The plugin can verify a claimed exit code against the event
  rather than trusting the summary.
- **`session.tool.progress` is ephemeral**, like `session.usage.updated`. The
  tool family is not uniformly durable: `input.started`, `input.ended`,
  `called`, `success` are durable; `progress` is not.

`session.text.ended` fired once for the one assistant text block, with
`ordinal=0` and the complete `text`.
