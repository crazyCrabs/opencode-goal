# 14 — Usage accounting moves off the transcript onto durable native events

**Type:** implementation
**Status:** resolved

**What it delivers:** a goal's token and cost counters, and the text its
no-progress guard reads, come from the durable native event stream instead of a
whole-session transcript read per finished turn. A restart can no longer make the
goal believe it has spent less than it has, and an agent that is working but
repeats its phrasing is no longer blocked as making no progress.

**Blocked by:** 13 — Extract the round prompt and guardrail verdict from the driver module

## Acceptance criteria

- [x] **Fix the overlay first.** `addUsage` must read the visible usage
      (`currentUsage()`, overlay-or-durable) rather than the durable `goal.usage`,
      so successive calls accumulate. One line.
- [x] A test asserts two successive `addUsage` calls sum rather than replace, and
      that a durable mutation in between still carries the accumulated forward.
- [x] Usage folds from the per-step usage event, whose `tokens` and `cost` are a
      step's delta. The fold **sums** deltas; it does not diff a cumulative.
- [x] The multi-step recording in `assets/` — a two-step turn — folds to exactly
      the cumulative totals the turn reported. Successive cumulative differences
      equal the step deltas, both exact.
- [x] The no-progress guard's assistant text comes from the durable text-ended
      event, collecting every ordinal part of an assistant message before folding.
- [x] Any tool call resets the no-progress streak, so a repeated sentence while
      tools are being called is not a stall.
- [x] The whole-transcript read per turn, the per-session accounted cursor, and
      the retry-a-failed-read-at-the-next-idle path are all gone. No failed read
      is silently swallowed.
- [x] Accounting lives in its own module, not inside the driver and not inside
      the event adapter.
- [x] A step event that never arrives under-counts rather than double-counts, and
      there is a test proving it.
- [x] This ticket closes ticket 12's second drift.

## Outcome

**98 tests pass, 0 fail. `tsc --noEmit` clean. `bun run build` clean.**

New module `src/accounting.ts` (228 lines); `src/driver.ts` shrank from 418 to
287 lines and no longer has a `context` method on its session API at all.
`test/accounting.test.ts` holds 16 tests whose fixtures are the recorded live
payloads, not invented shapes.

### The fold

`session.step.ended` carries the step's **delta**: `tokens.input`,
`tokens.output`, `tokens.reasoning`, `tokens.cache.read`, and `cost`. All four
token fields are folded, because a goal's token budget is a statement about what
the provider billed, not about which field of the bill it landed in. The
two-step recording folds to exactly what the turn reported.

Durable-sequence dedupe: durable events are delivered at least once, so a
redelivery must not fold twice. The envelope's `durable.seq` is monotonic per
aggregate, so tracking the highest folded sequence per session is O(1) rather
than remembering every event id. An event with no sequence is folded anyway —
dropping it would be an under-count of our own making.

### What was removed

The transcript read, the per-session accounted cursor, and the
`catch { return }` that swallowed a failed read and "retried it at the next
idle" — which meant a turn's usage was silently lost whenever the read failed.
No read, so no read to fail.

### Two defects found and fixed while landing this

**1. `addUsage` replaced rather than accumulated** (found by ticket 13, fixed
here). `addUsage` read the durable usage, which stays put between calls, so
every call after the first threw away the first's delta. Now reads the visible
usage. Covered by two tests.

**2. `normalizeOutput` strips newlines, so multi-part messages lost their word
boundaries.** `GoalStore.normalizeOutput` removes control characters before it
collapses whitespace, so joining an assistant message's ordinal parts with `\n`
fingerprinted `"first part second part"` as `"first partsecond part"`. The guard
still worked — same parts gave the same fingerprint — but it fingerprinted a
message that does not read the way the model wrote it. Parts now join with a
space, which survives normalization, and there is a test asserting the joined
fingerprint matches the equivalent single-part message.

### Deliberately not read: `session.usage.updated`

The convenient usage event is **ephemeral** — confirmed in the schema and by a
live envelope carrying no `durable` block — and carries no location. Folding it
into a durable counter under-counts silently after a restart, which is the one
failure a budget guard cannot have. `session.step.ended` is durable, carries the
directory, and carries the assistant message id beside the usage.

## A caveat worth carrying forward

The installed SDK type declarations do **not** declare any of the event names
this plugin now depends on — `session.step.ended`, `session.text.ended`,
`session.tool.called`, `session.tool.success`, `session.execution.succeeded`.
They describe `session.next.*` and `session.idle`. The live 2.0.14 server emits
the un-suffixed forms. `src/accounting.ts` therefore declares its own narrow
payload interfaces taken from the recorded envelopes and reads every field
optionally, so an unmet shape degrades to "ignore" rather than throwing.

This is the same gap that made the original `session.idle` driver stall, and it
will bite again: the plugin is one server upgrade away from the events it reads
being renamed, with nothing in the types to catch it.

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
