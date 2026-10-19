# 28 — A goal remembers the session it works in, and recovers when that session is gone

**Type:** defect
**Status:** implemented — `36e712e`, `cc9105f`, `96db7d0`

**What it delivers:** the goal's rounds run in a room the human is in, so the model
the human chose applies to the goal's work; and when that room is closed, the goal
opens a new one with the same model instead of falling back to a model the account
cannot use.

**Blocked by:** nothing. Reported by the human immediately after 3762c68.

**Reported twice, and the second report is what found the real defects.** The first
fix did not work: `session.model` is what was explicitly set on a session, not what
the server resolves, so a plugin-created session has none to read. The second report
was checked for staleness first — both processes postdated the commit — and then
turned out to be three real bugs: an unwrapped `{data}` envelope, a directory
comparison across two spellings of the same path, and no way to repair a room that
predates the read. All three are recorded in the implementation notes below.

## The report

> 我的 opencode 是已经选择了可以执行的 model 的，但是 goal resume 后还是之前报错。
> 我发送一个 1 之后又正常了。

`/goal resume` reproduced the same 403 (`An active OpenCode Go subscription is
required to use Go models`); sending `1` by hand worked.

## What is measured

| Fact | How |
| --- | --- |
| the continuation prompt carries **no model** | `PromptInput.Prompt` is `text/files/agents/skills` only; the TUI's own call in `opencode.exe` is `{sessionID, text, files, agents, skills, delivery, gate, prepare}` |
| the model is resolved **per session** by the server | the above, plus the `session.model` column in `opencode.db` |
| `session.create` **accepts** `model` (and `agent`, `title`) | `@opencode/protocol`'s `session.create` input |
| `session.update` does **not** accept `model` | the same file: its body is `title`/`permissions`/… only |
| a session created with no model resolves to a Go model | A/B on a live server, same prompt both arms: no model → `claude-haiku-5-5` → 403; with model → `mimo-v2.6-flash-free` → `finish=stop`. `assets/model-ab.py` |
| the plugin cannot learn the human's chosen model with no session open | `context.data.session.get` requires an id; there is no current-model accessor on the plugin context |

So the human's chosen model is **per-session, not the global default** — otherwise a
fresh session would inherit it. The goal runs in a session `ensureSession()` created
with no model, so it falls back to the global default, which is a Go model this
account cannot use. The human's `1` worked because they were typing in the goal's
own session through the TUI's path.

**The goal is working in a room the human is not in.** Every fix that guesses a model
treats that symptom: hardcoding one overrides the human, reading the global config is
not available to the plugin context, and passing a model on the prompt is a dead end
because the payload has no such field.

## Design

A durable coordinate, not a state verb — the same shape and for the same reasons as
the round lease (ADR 0005) and the usage delta (ADR 0002):

```json
{ "kind": "goal/session", "version": 1, "id": "<goal id>", "sessionID": "<ses_…>",
  "model": { "providerID": "…", "id": "…" }, "at": <epoch-ms> }
```

- The fold gives it its own slot, never lets it reach the goal accumulator, the
  revision or `lastRef`, drops one naming another goal, and clears it on a `clear`.
  A session line read as a round would make every round look like two.
- It does **not** bump the revision, so remembering a session cannot re-arm or
  disarm a store — the same trap that made the `sync()` fix in `e35de17` necessary,
  and `unchangedFold` has to learn about this third coordinate for the same reason.
- Both entry points remember the session and its model after driving a round. The
  server driver already receives a session id from the event it is handling; the TUI
  command plane has the one it just used.

`ensureSession()` in `src/tui.tsx` becomes:

1. read the remembered session;
2. if it still exists, reuse it — it already carries the model the human chose, because
   they chose it while watching the goal work there;
3. if it is gone, create a new one **with the remembered model**;
4. if there is no remembered model either — a genuinely first goal — create one with
   nothing, and let the goal fail with `usage-limited` as it does today, which is now
   announced in the TUI (`84036aa`).

## The judgment call, made under the standing authorisation

**A closed session is the human tidying a tab, not withdrawing consent.** The human
has `/goal pause` and `/goal clear` for explicit stops; stopping the goal for a closed
tab would be the plugin guessing intent in the opposite direction. So the goal
recovers rather than waiting.

The cost, stated: **the goal changes rooms and the human may not notice.** The
mitigation is that `ensureSession()` already navigates the router to the session it
makes, so the human is put in the new room, and a stop is announced (`84036aa`).

## Out of scope

- The server driver recovering from a deleted session. It always holds a session id
  from the event it is handling, so it has nothing to recover from.
- Changing the global default model. That is the human's configuration, and a pin in
  `~/.config/opencode/opencode.json` fixes this environment outright — measured in the
  first arm of the A/B, where a pinned model made both arms succeed.

---

# Implemented

## What changed

- **`src/types.ts`** — `GoalSessionChangeMeta`, a line kind of its own:
  `{kind:'goal/session', version, id, sessionID, model?, at}`.
- **`src/state.ts`** — the fold reads it into its own slot, drops one naming another
  goal, clears it on a `clear`, and never lets it reach the goal accumulator, the
  revision or `lastRef`. `rememberSession(ref, sessionID, model)` and the `session`
  getter. `unchangedFold` learned about this third coordinate for the same reason it
  learned about the usage delta and the lease: without it, another process's session
  line is invisible until a snapshot mutation lands.
- **`src/tui.tsx`** — `ensureSession(store)` reuses the remembered session when it
  still exists, and replaces a gone one with a session created **carrying the
  remembered model**. `readSessionModel` reads the model off the session through
  `context.data.session.get`, which is the only place the plugin can learn it —
  `Session.Info` carries an optional `model` and the continuation prompt carries
  none. `kickRound` remembers the room **before** submitting, so a goal that stops
  there — a provider refusal is exactly that case — still knows where it worked.

## Tests — six in `test/tui.test.ts`

| Test | on HEAD | with the fix |
| --- | --- | --- |
| a round records the session it ran in and the model | **fails** | passes |
| a session coordinate is not a state verb | **fails** | passes |
| the goal log carries the room as its own line kind | **fails** | passes |
| a remembered session that still exists is reused | **fails** | passes |
| a remembered session that is gone is replaced, carrying its model | **fails** | passes |
| a goal with no remembered model still runs | passes | passes |

The one that passes on `HEAD` is the honest-case guard: with no model anywhere the
goal still runs, on whatever the server picks, and fails with `usage-limited` as it
does today rather than being silently guessed at.

## Two tests were wrong before they were right

Both are recorded because each failed for a reason that was the test's own, and a
test that fails on its own mistake is easy to "fix" by weakening it.

1. **The reuse test never reached the recovery path.** After the first round,
   `ensureSession` has navigated to the session it made, so the next `/goal` finds a
   session open and reuses it — correct behaviour, and not what the test was about.
   The router has to be put back on `home` first, which is the state a recovery is
   reachable from: the human navigated away, or the process restarted.
2. **The replacement test set the model on a session the goal never used.** It
   started from the home route and set the model on `ses-goal`, but a first run from
   home creates its own session, so the goal correctly remembered no model and the
   test proved nothing. It now starts from an open session, so the model is read
   from a room the human actually chose it in.

---

# The human's report, and what it proved

> 我选的模型是step5 为什么goal命令的还是haiku，这里有其他方式可以避免吗比如goal命令时可以指定运行的模型，最好的方式还是根据opencode中已选择的model来运作

The first fix did not work, and the reason is a distinction that had been missed:
**`session.model` is what was explicitly set on a session, not what the server
resolves.** A session `ensureSession` created with no model has no model stored, so
reading it back yields `undefined` and the goal correctly remembered nothing. The
default resolution happens at prompt time and is never written back.

Measured in `opencode.db`: 24 of the 25 most recent sessions carry a model, so the
TUI's `/model` **does** persist it — the gap is only that a plugin-created session
has none to read.

## The capability that was wrongly ruled out

An earlier finding — *"the plugin cannot enumerate sessions; `session.list` is not
in `SessionDomain`'s Pick"* — is true of the **server** plugin context and false of
the **TUI** one. They are different types:

| | server (`Plugin.Plugin`) | TUI (`@opencode/plugin/tui`) |
| --- | --- | --- |
| context | `{app, location, options, agent, …, session: SessionDomain, …}` | `{options, location, app, renderer, client, data, attention, theme, …, keymap, ui}` |
| sessions | the Pick: `create, get, switchAgent, …` | **`data.session.list(): SessionInfo[]`** and `client: OpenCodeClient` |

The `/goal` command plane is a **TUI** plugin. The hand-written `TuiGoalContext` in
`src/tui.tsx` declared a `data.session` narrower than the shipped one, and that
narrower type is what made the capability look absent.

`GET /api/session` was then measured on a live server: **200**, ordered by
`time.updated` descending, carrying `model` per session. That is the route behind
`context.client.session.list()`.

## The fix — three layers, and the first that answers wins

1. **the session open on the router** — the most immediate expression of the human's
   choice, since they are standing in it;
2. **`data.session.list()`** — the TUI's own collection, newest session carrying a
   model, restricted to this project's location;
3. **`context.client.session.list()`** — the same fact over HTTP.

Then the remembered model, which is the recovery case. `variant` is carried through
because it is part of `ModelRef` and it changes which model runs.

## Tests — five, four of which fail on HEAD

The fifth passes on `HEAD` on purpose: with no model anywhere the goal still runs,
on whatever the server picks, and fails with `usage-limited` rather than being
silently guessed at.

## A test bug that a swallowed error disguised

The first attempt at these tests failed with `madeWith[0] === undefined`. The cause
was in the test, not the plugin: the mock's `list()` closed over an **undeclared
free variable**, so it threw `ReferenceError`, and the plugin's own `try/catch` —
correctly there so a missing surface cannot break `/goal` — swallowed it and fell
through to the next layer. A broken test looked exactly like a missing capability.

Recorded because it is the standing cost of the defensive layering this fix is built
on: **every layer that fails silently makes the layer below it the only evidence.**
The mock now reads the collections from a mutable box a test can refill, because a
reference replaced after the context was built is stale.

---

# The second report, and the two real bugs behind it

> 还是有这个报错，你有更新全局的插件吗

Both processes were checked before anything was changed: `serve --service` and the
TUI both started at **16:18**, and the commit they were suspected of missing landed
at **16:11** — so the code was current and `model=None` in the human's own
`goal-log.jsonl` was a real defect, not staleness. The install was re-verified
afterwards by md5, which matched.

`C:\Users\Jerome T Liu\.opencode\goal-log.jsonl`, last 14 lines:

```
CHANGE   op=continue rev=3 rounds=2 phase=active
SESSION  id=goal-26f9295 sessionID=ses_ee03b6359ffeobb1spXc4ILzrK model=None
CHANGE   op=block rev=4 rounds=2 phase=blocked
CHANGE   op=resume rev=5 rounds=2 phase=active
CHANGE   op=continue rev=6 rounds=3 phase=active
SESSION  id=goal-26f9295 sessionID=ses_ee03b6359ffeobb1spXc4ILzrK model=None
CHANGE   op=block rev=7 rounds=3 phase=blocked
```

## Bug 1 — `session.list()` returns an envelope, not an array

`client.session.list` is typed `(input?) => Promise<SessionsResponse>`, and
`SessionsResponse` is `{data: SessionInfo[], cursor}`. The first version pushed the
**envelope** as a single row, so `row.model` was `undefined` on the wrapper, every
session looked model-less, and the goal remembered nothing. The human's step5 choice
was sitting in `opencode.db` the whole time, three rows deep in the same project.

## Bug 2 — a remembered room with no model can only be replaced, not repaired

`session.update` does not accept a model — measured — but **`session.switchModel`
does**. Without it, a goal whose room predates this read is stuck: reusing the room
reproduces the 403, and the only escape was to abandon the room. The human's goal
`goal-26f9295` is exactly that case, and this is what unblocks it.

## Bug 3 — the directory comparison compared two different spellings

The session rows carry a location with **backslashes**; the plugin's own
`context.location.directory` uses **forward slashes**. Comparing them raw drops
every row, which is the other way this read can answer nothing. Normalised now, and
when this project has no model at all the literal reading of "the model opencode is
using" is preferred over falling back to the server default.

## Tests — five, four of which fail on HEAD

The fifth passes on `HEAD` on purpose: a remembered room that already carries the
right model is left alone, and no `switchModel` is issued.

## Two test premises that were wrong before they were right

1. `run!('resume in the old room')` is **not** a resume — the argument is the
   objective, and the verb is a bare `resume`. The command silently did nothing.
2. To prove a room *survives without a model*, the room must exist and carry none.
   Leaving it out of the live map means the room is **gone**, which is the other
   case and correctly makes a new room. The test had asserted the wrong one of the
   two and read as a plugin bug.
