# Does goal_wait stay, and can the arranged wake source be enforced

Type: grilling
Status: resolved
Blocked by: —

## Question

Does the external-wait escape hatch survive the rework, and what guards it?

Codex has no `goal_wait` — waiting is just the `blocked` state. pi-goal has it
and is explicit that the model "must arrange a wake source first"; its
`resume_after_ms` is clamped to at least 10 s, and omitting it means an
indefinite quiet wait. This plugin has all of the mechanics and none of the
guard: a model can wait with no wake source arranged and the goal sleeps
forever, which is indistinguishable from the goal being broken.

Decide whether it stays or folds into `blocked`. If it stays, decide whether
"a wake source exists" is checkable, and what the plugin does when the wait
expires with nothing having happened.

The recording in ticket 01 may show a native `session.retry.scheduled` or inbox
event that changes the answer.

## Answer

Jev over five questions. Verdicts in
[`jev-07-verdicts.md`](../../../../AppData/Local/Temp/opencode-goal-rework/jev-07-verdicts.md).

| Question | Verdict | Confidence |
| --- | --- | --- |
| `goal_wait_fate` | **keep-as-wait-state** (0.600) | **0.40 → ESCALATED** |
| `inbox_event_wakes` | **YES** (0.73) | — |
| `wake_source_guard` | **require-deadline** (0.690) | **0.58 → ESCALATED** |
| `wait_expiry_behaviour` | **block-with-code** (0.520 over resume-round 0.460) | **0.29 → ESCALATED** |
| `wait_survives_restart` | **YES** (0.76) | — |

### New facts from the code and the recording

- **No `session.retry.scheduled` exists.** The recordings show `session.inbox.enqueued` instead, carrying envelope `location.directory` and `data = { sessionID, inboxID, item }` where `item = { type: "user", payload: { text, files }, delivery: "steer" }`. `session.inbox.delivered` follows with the same `inboxID`, and `session.execution.started` follows that. So the prompt itself travels through the inbox.
- **An omitted deadline does not wait at all.** `GoalStore.wait` sets `waitUntil = 0` when `resumeAfterMs` is undefined, and `waitUntil = 0` is the same value `drive()` reads as "not waiting". So `goal_wait` with no deadline admits the next round immediately — the exact opposite of pi-goal, where omitting the deadline means quiet indefinitely. The one sentinel is double-booked as both "no wait" and "no deadline", with no third value between them.
- **Nothing clears a wait except the deadline.** The tool description says continuation is suppressed "until the optional deadline or until other non-goal work arrives", and the `onSessionCreated` comment says "quiet until the deadline or the next human turn". Neither is implemented. Both documents describe behaviour that does not exist.
- **The `≥ 10 s` clamp already matches pi-goal.** That part needs no decision.

### It stays, and it becomes durable

`goal_wait_fate` says keep-as-wait-state (0.600) and `wait_survives_restart` says YES (0.76). **These cannot both hold** — the first option's own wording is "process-local deadline and reason, as today", and the second requires them to be durable. The conflict is recorded rather than smoothed over.

The durable one is the stronger signal: 0.76 clean against 0.23 for the explicit "keep as today" option, and its reasoning is the failure mode this whole rework exists to remove. A wait that evaporates on restart is a goal that silently un-waits — indistinguishable from a goal that never waited. So the answer is **keep the escape hatch, and make its deadline and reason durable**, which is the option Jev scored 0.23 on the choice question and 0.76 on the independent one.

### A deadline becomes required

`require-deadline` at 0.690, escalated only by 0.02. `no-guard` scored **0.000** — leaving it unguarded is not on the table at all. So `resume_after_ms` becomes a required argument and an omitted deadline is rejected.

This fixes the double-booked sentinel by construction: if a deadline is always present, `waitUntil > 0` always means "waiting", and the collision disappears. The cost is recorded: a genuinely open-ended wait is no longer expressible, and the model must put a number on how long it is willing to be quiet.

### The native inbox event is the wake

YES at 0.73. The trigger layer subscribes to `session.inbox.enqueued` and treats a user item as the end of the wait — arriving before the turn is submitted rather than after it finished, which is strictly better than waking on turn completion.

Distinguishing it from the goal's own continuation prompt is free: the plugin only submits a prompt when `drive()` is not suppressed, so while a goal is waiting no goal-originated inbox item can arrive. Any inbox item during a wait is a human.

### Expiry blocks rather than resumes

Escalated at 0.29 with 0.52 against 0.46 — the weakest verdict in this effort, a near coin flip. Adopted because the human delegated to Jev and Jev returned it, and recorded with that margin showing.

On expiry with nothing having arrived, the goal is blocked with a new **`wait-expired`** code rather than resuming. Ticket 05 settled that every system stop is a block code rather than a phase, so this composes: a goal that waited and got nothing becomes a machine-routable stop instead of a blind resume. It is an arithmetic-tier stop, so ticket 06's two-tier gate stops on it immediately rather than gating it three rounds.

`bounded-retries` scored 0.020 and is not reconsidered.
