# Which events drive continuation, and does directory attribution get deleted

Type: grilling
Status: resolved
Blocked by: —

## Question

Once the recording settles which events actually fire, what is the trigger layer
of the continuation loop?

The current design runs two triggers in parallel — `session.execution.succeeded|
failed|interrupted` as the real completion signal and `session.idle` as a legacy
one, each patched with "only while no round is in flight". That patching exists
because of claim 1.

**Both signals are real, and the recording settled which one fires.**
[Record the real opencode v2 event stream during one goal run](./01-record-the-real-opencode-v2-event-stream-during-one-goal-run.md) found
that `session.idle` never fires at turn end on v2.0.14 — not on a successful turn, not on
a failed one. So the legacy path is not hedging: `session.execution.succeeded` and `.failed`
are the only turn-completion signal that exists.

So this ticket is no longer about deleting a path. It is about what the trigger layer looks
like when *one* of two triggers is real and the other is dead weight — and about the fact
that `session.created` was **not observed** via `opencode run` either, which means every turn
event in run mode falls through to the `session.get` fallback, one extra API call per turn
completion.

Directory attribution stays. `session.execution.*` and `session.usage.updated` carry no
`location`, confirmed 3/3, 2/2 and 1/1 across three runs. The ~90 lines in `src/index.ts`
are load-bearing; the architecture review's recommendation to delete them is refuted.

The `parentID` subagent check still needs the map, though: `session.created` carries
`parentID` but `session.execution.*` carries only a `sessionID`, so a subagent session
reopened after a restart is indistinguishable from a normal one unless the directory map
remembered it.

## Answer

Resolved by inspecting the three recordings in `assets/` rather than reasoning
about them. Two findings overturn the ticket's own premise.

### New facts from the recordings

| Event | Envelope `location` | Notable `data` |
| --- | --- | --- |
| `session.step.started` / `session.step.streamed` / `session.text.*` / `session.reasoning.*` | **present on every one** | `assistantMessageID`, `finish`/`rawFinish` on `.ended`, `cost` + `tokens` on `session.step.ended` |
| `session.usage.updated` | **absent** | `cost`, `tokens` |
| `session.execution.started` / `.succeeded` / `.failed` | **absent** | `.failed` carries `error: { type, message, status }` |
| `session.execution.failed` | absent | `error: { type: "provider.auth", message: "...", status: 403 }` |
| `session.step.failed` | **present** | `error: { type, message, status }` |

So the location-less set is exactly three events wide: `session.execution.started`,
`.succeeded`, `.failed`, plus `session.usage.updated`. It is not "the execution
family and everything near it" — it is a narrow, enumerated set, and
`session.step.*` sits right beside it carrying `location.directory`.

`session.usage.updated` fires once per **turn**, not per step (one occurrence per
turn, tokens cumulative at 10941/5) — it lands between `session.step.ended` and
`session.execution.succeeded`. That makes it unreliable as a step counter but
reliable as a per-turn usage signal, which is ticket 11's question, not this one.

### The legacy `session.idle` path stays, gated on ticket 09

Jev verdict: **keep-for-tui** (0.55) over delete (0.40), confidence **0.33 —
escalated**. Verdicts in
[`jev-03-verdicts.md`](../../../../AppData/Local/Temp/opencode-goal-rework/jev-03-verdicts.md).

The evidence favours deletion: `session.idle` appears zero times across all
three recordings, including at session open, which directly contradicts the
source comment claiming a freshly opened session emits a burst of them — the
comment is the only thing motivating the path, and the "only while no round is
in flight" patch exists solely to defend against a burst that was never
observed. The recording of the answer above was written for deletion.

Jev's reason for keeping it is that the recordings cover only `opencode run`.
The TUI path was never observed, and the events come from the server, so the
honest position is that this is a bet on the strength of one client mode.

Recorded as **keep-for-tui**, with the escalation standing:

- The path stays, still patched "only while no round is in flight".
- **It is gated on [What you saw on the live opencode v2 server](./09-what-you-saw-on-the-live-opencode-v2-server.md).** That ticket is the observation that settles it, and it is still open and unanswered. If it confirms `session.idle` is absent in the TUI too, the path is deleted and this section is superseded.
- With ticket 04's `admitRound(store)` unified, keeping it means the legacy path becomes a third caller of the same admission — which is now cheap, and is part of why the cost of keeping it is low.
- **A fourth recording strengthens the case for deletion without closing it.** `assets/recording-runD-multistep-tools.jsonl` is a two-step turn with two tool calls — a different shape from all three earlier runs — and `session.idle` appears **zero** times across its 42 session events. Four runs, 0 firings. It still says nothing about the TUI, which is the only remaining argument for keeping the path.

### The `session.get` fallback stops being the directory source

Two Jev verdicts, both above the floor: learn the directory from
**`session.step.started`** (0.930, confidence 0.90), and keep `session.get`
**narrowed to learning `parentID`** for a session never seen created (0.85).

The premise that it costs "one extra API call per turn completion" was wrong:
`rememberSession` caches the resolved directory, so it fires at most once per
session per process. But it is no longer the directory source at all, because
the recordings show one is unnecessary.

`session.step.started` carries `location.directory` and fires at the start of
every step, including the first step of a session this process never saw
created. `session.execution.succeeded` for a turn always follows at least one
`session.step.started` for the same session. So the directory is learned from a
location-bearing sibling event, before the location-less completion event needs
it — with no `session.get` call at all.

Caveat recorded honestly: an interrupted turn can end without `step.ended`, but
`step.started` has already fired by then, so the directory is known before any
completion event arrives either way. And `session.created` remains subscribed
for the TUI path, where the recordings cannot speak.

### The directory map keeps two entries, both load-bearing

`execution.location-less` is not evidence of a missing feature — the step family
proves the event system carries `location` when it chooses to. So attribution is
deliberately cheap in this path and must be done by hand. The map keeps:

1. **Directory attribution** for the three location-less events plus
   `session.usage.updated`.
2. **The subagent exclusion**, learned from `session.step.started`'s sibling
   `session.created` payload where available, else from `session.get` — because
   `session.execution.*` carries only a `sessionID` and a subagent's turn is
   otherwise indistinguishable from a root session's.

`session.get` is therefore kept **only** as the sub-probe inside the resolution
path, not as the primary directory source.

---

## The re-ask, and why the section above still stands

Decision 10 was gated on the TUI observation. The gate can now be evaluated
further than it could when the section above was written, so Jev was re-asked
twice (`jev-03-r2.mjs`, `jev-03-r3.mjs`).

| pass | choice | probability | self-assessed confidence |
| --- | --- | --- | --- |
| original | keep-for-tui | 0.55 | **0.33** |
| re-ask, full question | delete it | 0.64 | **0.52** |
| re-ask, narrowed | delete now | 0.44 | **0.16** |

Both re-asks returned **below the 0.6 floor**, and the narrower question returned
*worse* — 0.16 against 0.52, with the distribution flattening to delete-now 0.44,
delete-with-the-residual-recorded 0.24, keep-until-the-TUI-is-observed 0.32. Two
things are true at once: the evidence favours deletion, and Jev will not say so
above the floor. **The verdict is not a verdict, and it is recorded here as not
being one.**

A third re-ask would be the exact move criticized in
[ticket 26](./26-a-goal-appearing-beside-a-live-session-has-no-server-side-trigger.md):
re-asking a below-floor answer until it clears is the same as never having recorded
it. It was not done.

## The decision, and whose it is

**The path stays.** Not because the evidence says so — it says the opposite — but
because of a gate and a discipline, both of which are mine:

1. **Decision 10 said "gated on the TUI observation".** The TUI is still
   unobserved. Deleting around a stated gate rather than through it is the shortcut
   this effort exists to avoid.
2. **A deletion is a behaviour change**, and the boundary rule for this effort is
   that a behaviour change is its own ticket rather than a drive-by. Deleting on a
   0.44 probability is the reverse of that rule.

So the section above keeps its verdict, on a different basis than it kept it: the
first time it was Jev's answer, and this time it is the discipline with Jev's
answer recorded as absent. The ten guarded lines are the price, and it is worth
paying.

A deletion ticket, gated on the TUI observation, is the right home for this and
does not exist yet.
