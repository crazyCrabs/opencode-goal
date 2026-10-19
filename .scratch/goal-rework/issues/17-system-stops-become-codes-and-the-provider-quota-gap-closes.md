# 17 — System stops become codes, and the provider-quota gap closes

**Type:** implementation
**Status:** resolved

**What it delivers:** every stop the system makes to a goal is a routable code
inside a blocked phase, rather than a mixture of codes and process-local flags. A
provider quota or rate-limit refusal currently leaves a goal alive in durable state
and dead in practice, with nothing recording that the provider was the reason; it
becomes a durable stop that says so.

**Blocked by:** 15 — One admission policy behind one seam, taken by both entry points

## Acceptance criteria

- [x] The phase set stays four: active, paused, blocked, complete. A test asserts it,
      so growing it becomes a deliberate act.
- [x] Every system stop is a block code: the round limit, the token budget, the
      no-progress guard, the provider quota, and the wait expiry. `paused` remains the
      human stop and `complete` the model's.
- [x] A new code names the provider-quota stop.
- [x] A provider refusal reported on the turn — the failure event carries a structured
      error with a type, a message and a status — becomes a durable blocked goal
      carrying that code, not a process-local disarm on a goal that still reads active.
- [x] A goal stopped this way is distinguishable from a goal stopped by an impasse, from
      one stopped by a budget, and from one that finished, each by one field.
- [x] `unmet` — "tried and failed" as a terminal phase — is not added, and the ticket
      records why: it appeared in one source of five, and the model-facing minimum
      gives the model exactly two verbs with no way to say it.
- [x] The human command plane and the autonomous driver report a provider stop the same
      way, because they read the same code.

## Outcome

**137 tests pass, 0 fail. `tsc --noEmit` clean. `bun run build` clean.**

New code `usage-limited`, new classifier `providerStopReason` in
`src/round-policy.ts`, new shared `stopGoal` in `src/admission.ts`. Both entry points
now route a provider refusal through the same classification and the same durable
block. `test/stops.test.ts` holds 13 tests; `test/integration.test.ts` holds three
end-to-end ones.

### The refusal shape came from a recording, and the types agree

The recorded 403 is
`{ type: "provider.auth", message: "Upstream request failed: An active OpenCode Go
subscription is required to use Go models.", status: 403 }`, present on both
`session.step.failed` and `session.execution.failed`. `@opencode/protocol` declares
exactly this shape with `status` optional — the first time a recorded payload and the
type definitions have agreed without a discrepancy.

### What stops and what does not

`401`, `402`, `403`, `408` and `429` stop the goal. A `provider.*` error with no
status stops it too, because nobody can retry past it. A `500`, a dropped
connection, an untyped error with no status, and a bare string do not — those are
transient or unclassifiable, and stopping a goal for one would lose work the next
attempt would have finished.

### The gap that closed

Before this ticket a provider refusal reached the driver's prompt-submission catch,
which set the process-local `activation` to `disarmed`. The goal still read `active`
in the durable log, nothing recorded that the provider was the reason, and a restart
re-armed it straight back into the same refusal. Now the turn-completion event's
error is classified and the goal is blocked durably with `usage-limited`, and a
fresh process reads that block and stays stopped. The integration test runs exactly
that restart.

## A correction to tickets 14 and 16

Both those tickets recorded a claim that is **wrong**, and it is corrected here
rather than left standing:

> "the installed SDK type declarations do not declare these event names at all"

They do. `@opencode/protocol` — the project's own dependency under the root
`node_modules` — declares `session.execution.started/succeeded/failed/interrupted`,
`session.step.started/ended/failed`, `session.text.ended`, `session.tool.called`,
`session.tool.success` and `session.usage.updated`, with the payload shapes matching
the recordings.

The error was mine: I read `@opencode-ai/sdk` under `.opencode/node_modules`, which
is a different and older package that describes only `session.next.*`. Two tickets
and two code comments carried the wrong conclusion forward, including a
runtime invariant check in `index.ts` that was justified by it.

The invariant check itself is still worth keeping — a server that changes which
events carry a location should produce a log line rather than a silent fall back to
a per-turn lookup — but its justification is now stated correctly. The comment in
`src/accounting.ts` names both packages so the next reader does not repeat the
mistake.

What remains true from those tickets, and is unaffected: the *location-less set* was
measured from recordings and is correct, and the dead flat-`directory` branch was
verified absent in eight live `session.get` results.
