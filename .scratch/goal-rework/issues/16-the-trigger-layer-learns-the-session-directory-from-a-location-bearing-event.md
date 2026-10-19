# 16 — The trigger layer learns the session directory from a location-bearing event

**Type:** implementation
**Status:** resolved

**What it delivers:** the adapter stops looking up a session's project directory
through an API call, because a durable event beside every turn already carries it.
The lookup survives for exactly one remaining job it can do that no event can:
telling a subagent session from a root one.

**Blocked by:** 15 — One admission policy behind one seam, taken by both entry points

## Acceptance criteria

- [x] The session directory is learned from the step-started event's location, which
      fires at the start of every step and always precedes the completion event of the
      same session. No lookup is needed to attribute a location-less completion event.
- [x] The location-less set is enumerated in one place, and it is exactly four events:
      execution started, succeeded, failed, and the usage update. Everything else in the
      session family carries a directory.
- [x] The lookup is narrowed to learning whether a session is a subagent, for a session
      never seen created. It stops being the directory source.
- [x] Its dead first branch goes — the shape carries only a nested directory, and the
      code reads an older flat one that always misses.
- [x] The session directory map keeps two entries, both load-bearing: directory
      attribution for the location-less events, and subagent exclusion.
- [x] Subagent sessions stay excluded at the adapter, and the admission module never
      learns that a subagent exists.
- [x] A directory resolution for a session this process never saw created still works,
      through the narrowed lookup.
- [x] No per-turn API call is added or removed relative to ticket 15's behaviour except
      the one this ticket deletes.

## Outcome

**121 tests pass, 0 fail. `tsc --noEmit` clean. `bun run build` clean.**

`src/index.ts` gains a `session.step.started` branch that records the directory from
the event's location, and `resolveTurnSession` loses its flat-`directory` read. Three
integration tests cover the new behaviour.

### The location-less set, verified before it was trusted

The set was not assumed — it was measured across all four live recordings, per event
type, counting occurrences with and without a location:

```
session.execution.started    0 with    4 WITHOUT
session.execution.succeeded  0 with    3 WITHOUT
session.execution.failed     0 with    1 WITHOUT
session.usage.updated        0 with    5 WITHOUT
session.step.started         5 with    0 WITHOUT
session.step.ended           4 with    0 WITHOUT
session.text.ended           3 with    0 WITHOUT
session.tool.called          2 with    0 WITHOUT
... every other session.* event: with location, never without
```

Exactly four events never carry a location, and no event is mixed. The ticket's claim
held. `session.execution.interrupted` is in the set **by family rather than by
observation** — it never appeared in a recording — and the code comment says so,
because guessing the other way would be the more dangerous error.

### The dead branch, verified before it was deleted

The adapter read `info.directory ?? info.location?.directory`, on the comment that
"the directory has been seen both at the top level and under `location`". All eight
`session.get` results across the four recordings report
`hasTopLevelDirectory: false` and `topLevelDirectory: null`, with `location.directory`
always populated. The flat shape does not exist; the comment was stale. The branch is
gone, and the test harness that had been returning it was fixed too — it was the
fixture that let the dead branch survive.

### The set is checked, not just documented

`LOCATION_LESS_EVENTS` is load-bearing in one way: the subscribe loop compares every
`session.*` event's real location-bearing-ness against the set and logs when they
disagree. This is the second time this codebase has been bitten by the installed SDK
type declarations not describing the events the server emits — the first time it
cost a stalled continuation loop — so the enumeration is now an assertion rather than
a comment. A server that renames or re-shapes these events produces a log line
instead of a silent fall back to a per-turn lookup.

### What the map still does

`sessionDirectories` keeps exactly two jobs, both load-bearing: attributing the four
location-less events, and answering the subagent question. The `session.step.started`
branch records only the directory — a step-started carries no `parentID`, so the
subagent answer stays with `session.created` and the narrowed lookup.

### Not done here

Subagent sessions are still excluded at the adapter, and `admitRound` still never
learns one exists. A `parentID` of `null` was observed in all four recordings, so
whether subagent sessions report one at all remains unverified — ticket 22's
observation would settle it.

## Correction, recorded by ticket 17

The "caveat on shapes" / "the set is checked, not just documented" sections above
claim that the installed SDK type declarations do not declare these event names.
**That claim is wrong and is retracted here.** `@opencode/protocol`, the project's
own dependency under the root `node_modules`, declares every one of these events
with payload shapes matching the recordings. The error came from reading
`@opencode-ai/sdk` under `.opencode/node_modules`, a different and older package
that describes only `session.next.*`.

The measurements in those sections — the location-less set from four recordings,
and the dead flat-`directory` branch from eight live `session.get` results — are
unaffected and still stand.
