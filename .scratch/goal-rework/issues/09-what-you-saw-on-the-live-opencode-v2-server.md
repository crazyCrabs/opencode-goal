# What you saw on the live opencode v2 server

Type: task
Status: closed as far as it can be without a TTY — the three server-side
questions are answered and recorded; the TUI event stream is the one thing left,
and it needs a human at an interactive terminal
Blocked by: —

## Question

`src/driver.ts` records that someone verified against a live server that no
`session.idle` arrives when a prompt turn ends. What exactly was seen?

The recording in ticket 01 settles the question either way, so this blocks
nothing. It is a free cross-check: if `session.idle` fires at the start of a
turn, or fires at turn end with a payload the plugin did not expect, the
recording corroborates it immediately. If the recording contradicts what was
seen, that is worth knowing too.

Waiting on the human. Nothing else in this map depends on the answer.

## Answer

_Empty. Resolves through a live exchange with the human, not research._

---

# Sharpened — the original question is answered

"What exactly was seen" behind `src/driver.ts`'s claim that no `session.idle`
arrives when a prompt turn ends is settled.
[Record the real opencode v2 event stream during one goal run](./01-record-the-real-opencode-v2-event-stream-during-one-goal-run.md)
confirmed it across four recordings, including a two-step turn with tool calls
(`assets/recording-runD-multistep-tools.jsonl`). Zero `session.idle` events,
every time. That cross-check is closed and this ticket is no longer about it.

**What it is now about is the one observation that cannot be made from here: the
TUI path.** Every recording so far was driven through `opencode run` or
`opencode run --standalone`. Neither loads project-local plugins, and neither is
the interactive TUI. Three decisions are gated on that single observation:

1. **Ticket 03's idle verdict.** Jev chose `keep-for-tui` at 0.55 against 0.40,
   escalated at confidence 0.33 — a coin flip tipped by the argument that the TUI
   was never observed. If the TUI's event stream also shows no `session.idle`,
   the path is deleted and ticket 03's section is superseded.
2. **The spec's acceptance scenario.** The destination requires a recorded run of
   `/goal <objective>` on a real v2 server reaching a natural stop, with every
   round's prompt, tool call and event captured. **That run has now happened** —
   ticket 23 records it, before and after, and it passes. It ran through
   `opencode serve` rather than an interactive TUI, so this item is satisfied on
   the server plane and still open on the TUI plane.
3. **Whether `session.created` ever fires.** It appeared zero times in run mode.
   It is the plugin's adoption trigger, and if it is absent in the TUI too, a
   goal surviving a restart never re-arms itself without a human.

## How to capture it

The spy plugin is at `assets/event-spy.plugin.js`. It is read-only — no tools, no
prompts, no mutations. To record the TUI it must be a **global** plugin, because
project-local plugins are not loaded:

1. Copy it to the opencode config plugins directory, as `event-spy/index.js`
   (on this machine: `C:\Users\<you>\.config\opencode\plugins\`).
2. Start the TUI in the project you want to observe.
3. Type a message, let the agent use a tool, and let the turn end.
4. Read `<project>/.opencode/event-spy.jsonl` — one JSON object per line.
5. Delete the `event-spy` directory afterwards.

Note: a background opencode service that is already running will not pick up a
newly installed plugin. `opencode run --standalone` spawns a private server and
does load them, which is how the four existing recordings were made.

## Observed — the TUI path, from a real run

The human ran `/goal` in the interactive TUI. Three of the four things this ticket
was waiting on now have answers, and one does not.

1. **`session.created` is not the adoption trigger in the TUI.** A goal created
   from the home route was *not* started by opening a session — the user had to
   send a message before anything ran. Since `onSessionCreated` is one-shot per
   session, a session that already existed is never adopted. Ticket 22's
   `autoStart` now closes this from the TUI side, so the answer is moot for the
   defect; it still matters for whether a goal can re-arm itself after a restart
   with no human action, which is **still unobserved**.
2. **The gate on the spec's acceptance scenario is still closed.** The run reached
   no natural stop — it ran eleven rounds and was cleared. Ticket 23 still needs
   one that stops on its own.
3. **`session.idle` was not observed directly.** No event recording of the TUI run
   exists. What the run *does* rule out is that `session.idle` starts a goal in
   the TUI: the goal stayed silent until a turn actually completed. The legacy
   path stays, as a supplementary trigger.

An event recording of a TUI run would settle the remaining question and would also
settle the eleven-rounds-in-20ms anomaly recorded in ticket 22. If that is ever
wanted, the same spy plugin captures it — it only has to be installed as a global
plugin, because the TUI does not load project-local ones.

---

# Observed — the server path, from a live run against the new plugin

The plugin was installed into `~/.config/opencode/plugins/opencode-goal/` and
driven against a real `opencode serve` on v2.0.14, with the read-only event spy
recording everything. Three questions this ticket was waiting on now have answers,
and they were not available from the TUI.

## 1. `session.created` fires, and it carries a location

Three sessions created through the API each produced exactly one:

```json
{
  "type": "session.created",
  "durable": { "aggregateID": "ses_f2d136...", "seq": 0, "version": 1 },
  "location": { "directory": "C:\...\trial-rework" },
  "data": { "sessionID": "ses_f2d136...", "projectID": "...", "subpath": "", "slug": "kind-pixel", "version": "2.0.14" }
}
```

It is `durable` with `seq: 0`, and it carries the project directory both on the
envelope and in `data`. The plugin reacted to it within 4 ms — the spy's wrapped
`ctx.session.get` was called immediately after. **The adoption trigger is real.**

## 2. It is one-shot per session, and that is the whole defect

A goal created **after** its session already existed ran nothing at all for 20
seconds: `create rev=1 rounds=0 phase=active` and nothing more. A goal created
**before** a session was created started on its own, ran its round, and stopped on
a completion claim. The two are the same code differing only in order:

| order | outcome |
| --- | --- |
| session created **after** the goal | starts immediately, no prompt needed |
| session already present when the goal appears | **nothing happens** |

So `session.created` is not an adoption trigger in general — it is a
session-side trigger. A goal appearing beside a live session has no trigger at
all, which is exactly what the human reported in the TUI, and it is why
[ticket 22](./22-decide-the-legacy-idle-paths-fate-once-the-tui-has-been-observed.md)'s
`autoStart` matters rather than being a belt-and-braces extra.

## 3. The TUI's event stream is still unobserved — and no longer the gate

Everything above came from `opencode serve`, not the TUI. What the TUI does with
`session.idle`, and whether opening an *existing* session there fires anything,
is still unseen, because the TUI is interactive and this run was not.

**It is no longer the gate.** The defect is now understood as an ordering gap
that exists on both planes, and the server-side half of it is reproducible
without a TUI. That makes it a code question rather than an observation question.

## Two corrections to what this file previously claimed

**A.** The note that project-local plugins are loaded only by
`opencode run --standalone` is **wrong for `opencode serve`**: the event spy is a
project-local plugin at `<project>/.opencode/plugins/event-spy/index.js` and it
loaded and recorded. What is true is narrower: `opencode run` without
`--standalone` did not load them.

**B.** The event spy **truncates its own output on every plugin re-init**
(`writeFileSync(OUT, '')`, "one run per file"), and opencode re-inits plugins
mid-session. Two readings taken across a truncation disagreed about whether
`session.created` had fired, and the earlier one was wrong. Counts read from this
file are only valid within one truncation window.

## What the run also produced

A defect the tests had never caught, because the tests had never met a real
server: the step a goal completes in spends tokens that are never folded, so a
one-round goal records 0/0. Recorded as
[ticket 24](./24-the-step-a-goal-completes-in-spends-tokens-that-are-never-folded.md)
with the live numbers and a failing test.
---

# Closed — with one answer, one deferral, and one honest gap

Ticket 09's remaining questions, answered from the work done since: the inbox
location discrepancy (ticket 25), the arming rule (ticket 26), and a sixth live
observation.

## 1. Whether a goal can re-arm itself after a restart with no human action

**Answered: no, and it is now deliberate, tested, and documented.**

Every re-arm in the server half requires a human or a session creation:

| re-arm | requires |
| --- | --- |
| `onSessionCreated` | a session being created, once per session |
| `adoptOnHumanTurn` (ticket 26) | a finished **human** turn |
| the inbox wake path | a human sending a message during a wait |

A goal that predates the process is disarmed, because `GoalStore.applyActivation`
arms only a goal mutated after the store came alive. Nothing else arms one, so with
no human action at all the goal stays quiet indefinitely — which is the DSH posture
that a goal surviving a restart waits for an explicit resume.

This is not an oversight. Jev was asked directly whether the arm should happen on
something cheaper than a human turn and chose the human turn at 0.96. The behaviour
is pinned by a test that drives the exact shape: a goal and a session that both
predate the process, then a human turn, then a round.

The consequence, stated plainly: **`opencode run --standalone` with a goal created
before the run will never drive it**, because the session is created before the
plugin subscribes and no `session.created` ever fires. The model can still complete
the goal from the human turn, which is what the four run-mode observations showed.

## 2. The TUI event stream

**Still unobserved. The reason is now precise rather than unknown.**

`opencode mini` answers `opencode mini requires a TTY stdout`, and stdout becomes a
pipe under every redirection tried, including `Start-Process -RedirectStandardOutput`.
A bare `Start-Process` console does run but produced no plugin output at all, so it
cannot be driven blind. The background service will not reload a newly installed
plugin, so a global spy needs a service restart.

**What it does not matter for**, which is the interesting half: `session.idle` is a
*server* event. The plugin's subscription is server-side and the TUI is a client, so
a client cannot make the server publish something it does not publish. Every client
tried — the CLI, `run`, `run --standalone` and raw HTTP — saw zero. The residual is
one specific thing: a server condition only the TUI triggers that no API path has
reproduced.

The sixth observation is recorded below, and it is the one that matters: the same
server, the same plugin, driven through a different client, with the same zero.

## 3. The sixth live observation (trial 17)

`opencode run --standalone "say hello"` in a fresh directory, 130 events, 27
distinct types:

```
session.execution.started     1      session.step.streamed    1
session.execution.succeeded   1      session.text.delta       1
session.inbox.delivered       1      session.text.ended       1
session.inbox.enqueued        1      session.text.started     1
session.instructions.updated  1      session.usage.updated    2
session.reasoning.delta       5      session.idle             0
session.reasoning.ended       1      session.viewed           0
session.reasoning.started     1      session.created          0
session.step.ended            1
session.renamed               1
```

`session.created` is zero here, which reproduces the run-mode finding — the session
is created before the plugin's subscription is live. So a goal present before an
`opencode run` is never adopted, exactly as ticket 26 records.

Across all six observations: **over 4700 events, zero `session.idle`.**

## Two deferrals that this ticket leaves behind, deliberately

- **Spec decision 10's `session.idle` path stays.** Jev was re-asked twice and
  returned below the 0.6 floor both times — 0.52 then 0.16, the narrower question
  answering *worse*. The evidence favours deletion and the verdict does not exist.
  The decision to keep was made on the discipline, not on Jev's probability, and it
  is recorded in [ticket 03](./03-which-events-drive-continuation-and-does-directory-attribution-get-deleted.md).
  A deletion ticket gated on the TUI observation does not exist yet.
- **The eleven-continues-in-20ms anomaly** (ticket 22) is still unexplained and is a
  different mechanism from ticket 24's usage loss. It needs a run that produces
  eleven rounds, which no observation has.

## What this ticket unblocked

The server-side half of both the acceptance scenario and the adoption question is
now reproducible without a TUI, and the defect the human reported is fixed on both
planes: `autoStart` in `tui.tsx` for the TUI, `adoptOnHumanTurn` in the driver for
the server. The remaining gate on the acceptance run is ticket 10's red line, not an
observation.

---

# The home-route defect is fixed, and the reason was in the binary, not the code

Reported again by the human after everything above: `<leader>n` (ctrl+x n) opens a
new conversation, `/goal <objective>` prints *"No session is open in this project,
so the goal has nothing to run in yet"*, and nothing runs until a message is sent.

`autoStart` was not broken. Its trigger does not exist. Measured in
`opencode.exe` — the navigation to a session route sits inside the prompt-submit
handler:

```js
if (!i.sessionID) {
  if (Me) z.preserveSelectionFromNewSession();
  if (!qt && !l.isDestroyed && Ee.prompt.text) no(Br, {...}), dr();
  V.navigate({ type: "session", sessionID: Br })      // <-- here
}
```

Route types are `home`, `session` and `plugin` (also from the binary, and
`sessionID` is the field a session route carries, so the plugin's read of it was
right). A session created by `<leader>n` therefore leaves the router on `home`
until the human submits something. Waiting for the route was waiting for the very
act the goal exists to remove.

## The fix

`ensureSession()` in `src/tui.tsx`: when the command plane has no session, it makes
one through the client (`SessionDomain` carries `create` — confirmed in
`@opencode/plugin`'s `promise/session.d.ts`), navigates the router to it, and kicks
the round there. The session is made **before** the goal is, so the server driver's
`session.created` handler fires while no goal exists and does nothing; the other
order would have both the driver and this plane admit round 1.

A client without `create` still gets the old hint rather than silence.

## Two things this surfaced that were already wrong

**A double kick.** `/goal create` from an open session ran round 1 through the
command plane, and then the sidebar poll's `autoStart` ran round 2 — the two did not
share the goal-and-session set. An existing test asserted the *second* round as
correct behaviour (`toBe(1)` after clearing the prompts measured the auto-start
firing again), so it was passing for the wrong reason. `kickRound` now claims the
pair in the set the poll reads.

**Two tests encoded the defect as the contract.** "a goal created with no session
open stays armed but idle, and says why" asserted `roundsStarted === 0`, zero
prompts, and the hint — which is the reported defect, written down as expected.
Both were rewritten rather than worked around, with the reason recorded at each.
