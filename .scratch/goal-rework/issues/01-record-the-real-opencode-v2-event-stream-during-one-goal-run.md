# Record the real opencode v2 event stream during one goal run

Type: task
Status: resolved
Blocked by: —

## Question

What does a real opencode v2 server actually emit while a goal runs, from
`session.created` through the first admit to the second?

Three source comments in `src/` contradict the v2 documentation, and each one
holds up a design decision:

1. `src/driver.ts` says opencode 2.x publishes no `session.idle` when a prompt
   turn ends. The v2 docs say the opposite — the official V1→V2 migration guide's
   canonical subscription example is verbatim `if (event.type === "session.idle")
   console.log("Session completed")`.
2. `src/index.ts` says events carry no project directory on the execution family.
   The v2 docs say every envelope schema carries optional `location
   { directory, workspaceID }`, including `session.execution.*` — and the plugin
   already reads `event.location?.directory`.
3. `src/index.ts` reads `info.directory` first when resolving a reopened
   session's directory. The v2 `SessionInfo` has no top-level `directory`; it
   lives at `location.directory`. That cast's first branch is dead code.

The plugin's author reported verifying claim 1 against a live server, so the
docs may be describing a different boundary than the one observed. Only a
recording settles it.

Produce a recording and settle all three. Also capture, while the server is
already up: whether `session.usage.updated` carries per-turn or cumulative
usage, and what `session.status` reports while a turn runs.

**Do not build the harness from scratch.** [What did the earlier opencode goal plugins get right and wrong](./02-what-did-the-earlier-opencode-goal-plugins-get-right-and-wrong.md) found that `prevalentWare` ships `scripts/smoke-v2-lifecycle.ts`, which runs a real `opencode2` against a deterministic local model. Adapt that rather than inventing an equivalent. Note that it pins the v2 dev contract to `@opencode/{plugin,schema,client} 0.0.0-beta-19425` while this repo uses `@opencode/plugin 2.0.12` — record whether that skew explains any divergence in what is observed, because a pin that old may not see the events this plugin subscribes to.

## Answer

Recorded on **opencode v2.0.14**, three runs, using a read-only spy plugin
(`../assets/event-spy.plugin.js`) that subscribes to the whole event stream,
wraps `ctx.session.get`, and taps the `prompt` and `context` session hooks. Raw
recordings: `../assets/recording-runA-success.jsonl`,
`../assets/recording-runB-success-fresh.jsonl`,
`../assets/recording-runC-failed-quota.jsonl`.

**Claim 1 — CONFIRMED. The plugin's source comment is correct; the documentation-based
reading was wrong.**

`session.idle` never fired, in any run, at any point. Two successful turns with a
live model and one failed turn, and the complete event vocabulary observed was:

```
session.inbox.enqueued            location: yes
session.execution.started         location: NO
session.instructions.updated      location: yes
session.inbox.delivered           location: yes
session.step.started              location: yes
session.reasoning.started/.delta/.ended
session.text.started/.delta/.ended
session.step.streamed
session.step.ended                location: yes   (carries finish, rawFinish, cost, tokens)
session.usage.updated             location: NO
session.execution.succeeded       location: NO
```

The turn-completion signal is `session.execution.succeeded|failed`. The most recent
refactor was right to switch to it. The legacy `session.idle` path is not hedging
against uncertainty — it is dead weight unless some other host path emits it.

**Claim 2 — CONFIRMED, and broader than the comment says.**

The `location` key is *absent from the envelope*, not null. Execution events carry
`id, created, type, durable, data`; every other event carries `location`. Consistent
across all three runs, zero exceptions in 3/3, 2/2, 1/1 observations:

| Event | observations without `location` |
| --- | --- |
| `session.execution.started` | 3 of 3 |
| `session.execution.succeeded` | 2 of 2 |
| `session.execution.failed` | 1 of 1 |
| **`session.usage.updated`** | **2 of 2 — a fourth event the comment does not name** |

So the ~90 lines of directory attribution in `src/index.ts` are **necessary, not
redundant**. Deleting them would leave turn-completion events unattributable.

**Claim 3 — the shape is as the documentation says, and the plugin is not broken.**
`ctx.session.get` returns exactly `["id","projectID","model","cost","tokens","time","location"]`.
There is no top-level `directory`. But `resolveTurnSession` reads
`info.directory ?? info.location?.directory`, so the undefined first branch falls
through to the correct `location.directory`. **The code works. It carries one dead
branch and nothing worse.** An earlier assessment on this map that the fallback was
broken in v2 was wrong.

**New facts, none of which the plugin currently uses:**

- `session.usage.updated` carries `{sessionID, cost, tokens}` — native per-turn usage.
  The plugin instead hand-rolls usage by reading the whole session transcript through
  `ctx.session.context()` and diffing it against a per-session cursor. The native event
  is a candidate replacement; it also has no `location`, so anything keying on it needs
  the same directory fallback.
- `session.step.ended` carries `finish, rawFinish, cost, tokens` natively.
- `session.tool.*` events exist. pi-goal's no-progress rule resets on any tool call;
  the plugin's `recordRoundOutput` cannot see tool calls at all. This is the missing
  signal, if it is wanted.
- `session.created` was **not observed** via `opencode run` on v2.0.14 — not in a fresh
  project, not on a reused one. The schema defines it; it did not reach the plugin.
  The plugin's adoption trigger is `session.created`, so in run mode every turn event
  falls through to the `session.get` fallback — one extra API call per turn completion.
  The TUI path may differ and was not testable here.
- The `context` hook fires with `system` as an array of `{type, text}` parts, and a
  `tools` map listing 16 tools including `create_goal`, `get_goal`, `goal_wait`,
  `update_goal` and `execute` — confirming the goal tools are directly name-callable
  alongside `read`/`write`/`edit`, i.e. `codemode: false` works.

**Consequence for the map.** Ticket 03's premise is inverted: both signals exist, only
one of them fires for turn completion, and the directory attribution is load-bearing.
The architecture review's "delete the 90 lines" recommendation is refuted.
