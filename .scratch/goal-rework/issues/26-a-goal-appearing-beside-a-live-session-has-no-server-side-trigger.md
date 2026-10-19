# 26 — A goal appearing beside a live session has no server-side trigger

**Type:** defect
**Status:** resolved — implemented in `dedc1e6` (`adoptOnHumanTurn`), and its recorded
follow-up (the `sync()` early return) is fixed in `e35de17`.

**Blocked by:** 22 — decide the legacy idle path's fate once the TUI has been observed

## What was reproduced

The server half of the defect the user reported in the TUI. Goal created, no
message sent, nothing happens:

```
1  create   rev=1 rounds=0 phase=active     ← goal written, session already open
   (20 seconds pass)
   ...nothing
```

Then a **new** session was created, and the same goal started on its own, ran its
round and stopped on a completion claim. The two runs differed only in the order:

| order | outcome |
| --- | --- |
| session created after the goal | starts immediately, no prompt |
| goal created after the session | **nothing, indefinitely** |

## Why

The server driver has exactly one adoption trigger: `session.created`. It is
one-shot per session, so a session that already existed when the goal appeared is
never adopted by it. Nothing else in the server half reacts to a goal existing.

Ticket 22 fixed this for the TUI — `autoStart` rides the sidebar poll and starts
the goal when a session is open — and that fix covers the case the user actually
hit. It does not cover the server half.

## Where the gap actually bites

- **`opencode run` / `opencode run --standalone`.** Across four runs, the spy
  recorded **zero `session.created` events**. The session is created before the
  plugin's event subscription is live, so the one event that would adopt the goal
  has already been and gone. A goal created before an `opencode run` is never
  driven by the driver at all; the model can still complete it from the human
  turn, which is what was observed, but no round is ever admitted for it.
- **`opencode serve` with a goal created from elsewhere.** The TUI command plane
  writes to the same durable log. If a session is already open in that project,
  the server driver does not notice the goal — only the TUI's `autoStart` does,
  and only if the TUI is mounted.

The second case is the more interesting one, because it is the shape this plugin
is supposed to be good at: a durable goal, a server that keeps running, and a
human who creates the goal and walks away.

## What the driver would have to do

React to a goal existing beside a session it is already serving. The durable log
is the only signal, and the store already re-folds on every read, so the
information is there — what is missing is a trigger to look.

Three shapes, and they differ in what they promise:

1. **Poll the store from the server half.** A timer that re-reads the log and
   adopts a goal that appeared beside a live session. Same shape as ticket 22's
   `autoStart`, on the plane that has no human to poll for it. Costs a fold per
   interval.
2. **Hook the goal log.** A file watch on `<dir>/.opencode/goal-log.jsonl`. Reacts
   exactly once per external mutation, at the cost of depending on a watch API
   that opencode already provides for its own config (`opencode.config.location-watcher`)
   but has not promised for arbitrary paths.
3. **Do nothing in the server half and require the TUI.** Correct only while a
   TUI is mounted, which is not the autonomous case this plugin exists for.

Not chosen. 1 and 2 both need a Jev call on whether a server plugin should hold a
timer, and the answer changes what the plugin is.

## Two facts the fix has to survive

Recorded here because both cost a wrong conclusion during this investigation:

- **`opencode serve` loads project-local plugins, asynchronously.** A server
  started and queried within a second reports no non-builtin plugins at all, and
  only later reports them. A trial that checks before waiting draws the wrong
  conclusion. `assets/start-trial.py` now waits.
- **The event spy truncates its own output on every plugin re-init**
  (`writeFileSync(OUT, '')`, "one run per file"), and opencode re-inits plugins
  mid-session. Counts read across a truncation window disagree with each other,
  and the earlier count is the wrong one.

---

## Correction: the diagnosis above is wrong, and so is the option list

Measured on a live server (`.scratch/goal-rework/assets/probe-viewed.py`, trial 12),
plus the protocol and plugin typings read directly. Four facts.

### 1. `session.viewed` is declared and never published

`@opencode/protocol` declares a durable `session.viewed` event
(`data: { sessionID, idle }`) behind `POST /api/session/:sessionID/view`. It looked
like the answer this ticket wanted: a human-presence signal that, unlike
`session.created`, is not one-shot per session.

Three successful view calls returned 200 and produced **zero** `session.viewed`
events. The full recorded stream was 563 events, of which the `session.*` family
was two `session.created` and nothing else. Scanning all 563 distinct types for any
presence word — view, focus, open, active, select, enter, resume, load — returns
**none**.

So the endpoint exists and accepts calls; the event does not exist at runtime. This
is the third time a type has been contradicted by the server in this effort
(`session.inbox.enqueued`, ticket 25; the flat `SessionInfo.directory`, ticket 16),
and it is the same lesson: types are a claim about the server, not a fact.

### 2. A poll could not adopt into a session even if it wanted to

`SessionDomain` in `@opencode/plugin/dist/promise/session.d.ts` is

```
Pick<SessionApi, "create" | "get" | "switchAgent" | "switchModel" | "prompt" |
  "generate" | "command" | "synthetic" | "interrupt" | "update" | "move" | "wait" |
  "context">
```

`session.list` and `session.active` both exist on the HTTP client. Neither is in the
Pick. The plugin therefore cannot enumerate the sessions it would have to adopt a
goal into, and a poll that reads the goal log learns only the half it cannot act on.

There is also **no file-watch API** anywhere in the plugin surface — the mention of
`opencode.config.location-watcher` in the option list was a guess and is retired.
Option 2 would be `node:fs.watch` from inside the plugin: available in Bun, outside
the SDK's contract.

### 3. The arming rule already answers most of this ticket, and was never read here

`GoalStore.applyActivation` (`src/state.ts:168`):

```ts
this.runtime.activation =
  goal !== undefined && goal.phase === 'active' && mutatedWhileAlive ? 'armed' : 'disarmed'
```

`mutatedWhileAlive` is true when the goal did not exist when this store was born, or
was mutated after. **A goal created after the plugin's store came alive is already
armed**, so the `opencode serve` case this ticket is about is not stuck on arming at
all — and it has a trigger it already has: the next `session.execution.succeeded` in
that project resolves the directory from `session.step.started`, and admission
admits. The 20 seconds of nothing in the reproduction was nothing because no turn
finished in those 20 seconds, not because nothing was listening.

### 4. What is actually broken

A goal that **predates the process**, in a session that **also predates the
process**. The store is born with the goal, so it is `disarmed`, and the only thing
that re-arms a survived goal is `session.created` — which cannot fire for a session
that already existed before the plugin subscribed.

That is exactly `opencode run --standalone`: four runs, **zero** `session.created`.
The human's prompt turn runs, the model can complete the goal from it (which is what
was observed), but no round is ever admitted for it.

So the defect is narrower than this ticket claimed, and it is an **arming** defect,
not a trigger defect. The human's turn arriving is already a go-ahead of exactly the
kind `onSessionCreated` already treats as one:

> *"opening a session in a project with an active goal arms it and admits the next
> round, so a goal that merely survived a restart keeps running without a human
> resuming it by hand."*

A finished human turn is at least as strong a signal as an opened session, and unlike
`session.created` it is not one-shot per session.

### The live server reports its own version as 2.0.24

The `session.created` payload carries `version: "2.0.24"`, where the effort's notes
say 2.0.14. The server was upgraded under us at some point, which is worth knowing
before the recordings are trusted about anything.

## Jev's verdicts (`jev-26.mjs`, one POST; `jev-26-r2.mjs`, a re-ask)

| question | verdict | confidence |
| --- | --- | --- |
| arm a disarmed active goal when a human turn in that project finishes | **yes** | 0.96 |
| is a timer ever justified, given the plugin cannot enumerate sessions | **no** (noul 0.16 yes) | — |
| where the arm lives | **a new driver method, called from the event handler beside `onSessionCreated`** | 0.81 |
| is the gap a defect worth fixing, or an honest limitation | **defect worth fixing** | 0.74 |

The third answer came back **0.59 on the first pass, below the 0.6 floor**, so it was
not acted on. Re-asked as one narrowed placement question (`jev-26-r2.mjs`) it
returned 0.81 for the driver. The first answer is recorded here rather than dropped,
because a below-floor verdict that is quietly re-asked until it clears is the same
move as not recording it.

The second answer is the reason the option list above is retired rather than
converted: with no `session.list` in the plugin context and no file-watch API, a
timer could detect a goal and never the session to run it in, and every adoption
trigger has to come from an event.

## What was done

`GoalDriver.adoptOnHumanTurn(sessionID, directory)` in `src/driver.ts`, called
from the `session.execution.*` branch in `src/index.ts` immediately before
`driver.onTurnFinished`. It arms a disarmed active goal and nothing else — whether
the goal runs is admission's decision, through the same seam as every other
trigger, so a paused, blocked, completed or waiting goal is rejected there rather
than armed into running.

Two details that are the whole design:

**The gate on `isGoalTurn`.** `roundsInFlight` still holds the session at this
point, because `finish` is what releases it and it runs afterwards. So the turn
being reported is recognised as the goal's own, and a goal cannot re-arm itself by
completing a round. This is also why the method is on the driver and not in the
event handler: the driver is the only one that knows whose turn it was.

**Only the arm, not the drive.** `onSessionCreated` both arms and drives, because
opening a session is a trigger to run. A finished turn already has its own
trigger — `onTurnFinished` — so the arm only removes the reason that trigger would
reject it. Two triggers, one seam, no second admission policy.

## Proof the main test catches the defect

Run against `HEAD` with this commit reverted:

```
the opencode run case: goal and session both predate the process
  expect(server.prompts.length).toBe(1)  ->  Received: 0   (fail)
```

Zero: the goal never started, which is the `opencode run --standalone` case exactly.

## Two mistakes of mine, recorded because a reader of the tests will hit them

- `a goal created while this store was alive is armed`. A store that *creates* a
  goal mutates it after its own birth, so `mutatedWhileAlive` is true and it is
  armed. A disarmed store is one that came **alive beside** a goal. Writing a
  "restarted process" test with a `create` on the new store silently tests the
  opposite of what it says.
- `update_goal(action: "complete")` requires a structured claim, from ticket 20.
  Calling it with none throws `GOAL_INVALID_CLAIM` rather than completing.

## One answer that changed nothing and is kept anyway

The first Jev pass on placement returned **0.59**, below the 0.6 floor. It was
re-asked as one narrowed question and returned 0.81 for the driver. The first
answer is in the table above rather than replaced, because a below-floor verdict
that is re-asked until it clears is the same move as not recording it.

## State

`bun test` 215 pass / 0 fail (was 208; three driver tests, four integration tests),
`tsc --noEmit` clean, `bun run build` clean. The option list at the top of this
ticket — poll the store, hook the goal log, require the TUI — is retired: the
first cannot enumerate sessions, the second has no API to hook, and the third is
what the TUI's `autoStart` already does.

---

# The follow-up this ticket recorded — fixed

> *"`sameGoal` does not compare usage, so `sync()` early-returns and a process will
> not notice another process's usage lines until a snapshot mutation lands. Noted in
> ticket 24 rather than fixed, because fixing it is a drive-by change to `sync()`'s
> early-return."*

It is no longer a drive-by, because ticket 27 made it load-bearing. The same
early return also hid the **lease**, and a lease a process cannot read is a lease
that does not exist: measured on `HEAD`, a process that learned of another
process's lease only by folding the log admitted a round anyway — `rounds before
1, after 2`.

## What was wrong

`sync()` compared `id`, `revision` and `phase`. Two readers depend on more:

- `view()` reads the goal's **usage**, and a usage delta does not bump the
  revision (ADR 0002), so a foreign delta left the goal's identity identical and
  the usage stale indefinitely;
- `lease` reads the **lease**, which no snapshot mutation carries at all.

## The trap in fixing it

Adding usage to the comparison is not enough, and the obvious version is a
regression. `applyExternalChange` ends in `applyActivation(next)`, which computes
`mutatedWhileAlive` from the revision. A usage delta leaves the revision alone, so
an armed store that adopted a foreign delta would read as "not mutated while
alive" and **disarm itself**.

So detecting a change and deciding what kind of change it is have to be two
questions:

```ts
if (unchangedFold(this.state, folded)) return          // goal, usage AND lease
const stateVerb = !sameGoal(previous, folded.goal)     // id, revision or phase
this.state = folded
this.applyExternalChange(previous, folded.goal, stateVerb)
```

`applyExternalChange` now takes that flag and returns early for a coordinate. A
usage delta and a lease re-arm nothing, disarm nothing, reset no no-progress
history, and clear no in-process overlay — those all belong to a state verb.

## Tests — `test/sync.test.ts`, eight tests

Four of them are the defect and were run against `HEAD`:

| Test | on HEAD | with the fix |
| --- | --- | --- |
| a foreign usage delta is visible | **fails** — expected 4096, received 0 | passes |
| a foreign usage delta does not disarm an armed store | passes | passes |
| a foreign lease is visible | **fails** — expected `some-other-process`, received `undefined` | passes |
| an expired foreign lease stops being visible | passes | passes |
| a lease naming another goal is not this goal's lease | passes | passes |
| an unchanged log still short-circuits | passes | passes |
| a real state verb still resets and re-arms | passes | passes |
| the log on disk is what a fold reads back | passes | passes |

The four that pass on `HEAD` are the guards against the fix's own regression: the
early return is still there, a real state verb still does its work, and nothing
rewrites the log.

Plus one consequence test in `test/lease.test.ts`: a process defers to a lease it
learned only by folding the log. On `HEAD` it admitted a round anyway
(`rounds before 1, after 2`); with the fix the round count does not move and the
driver logs the holder it read.
