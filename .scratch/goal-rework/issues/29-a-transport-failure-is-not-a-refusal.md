# 29 — A transport failure is not a refusal, and a stop that names it says so

**Type:** defect
**Status:** implemented — `HEAD`

**What it delivers:** a goal whose provider cannot be reached stops with a code that
names the network, not the subscription; and a single dropped connection does not
stop it at all.

**Blocked by:** nothing. Found in the human's own run of ticket 28's fix.

## The report

> 看上去正常了，这个报错是尝试了2次之后停止了吗
> `←Write ECONNRESET: The socket connection was closed unexpectedly` / `⚠ Retry due · attempt 2 · ECONNRESET` / `Build · Step 5 Preview ~ · 14m 4s · 65.3 tok/s` / `Error: getaddrinfo ENOTFOUND api.stepfun.com`

Ticket 28's fix worked — the human's own goal log now carries
`model={'providerID':'stepfun','id':'step-5-preview','variant':'high'}`. What the run
exposed is a second defect, in the stop classification.

## What the log actually says

```
17:10:14  SESSION  ses_ee012ebd0ffeo7oo3F2PHgy4hG  model={stepfun/step-5-preview, high}
          block rev=3 rounds=1  code=usage-limited
                 "Goal stopped: the provider refused the request (provider.transport):
                  getaddrinfo ENOTFOUND api.stepfun.com"
          resume rev=4            ← the human's own /goal resume
          continue rev=5 rounds=2
```

So `rounds=2` is **one block plus one human resume**, not two automatic attempts.
The `⚠ Retry due · attempt 2` in the screenshot is opencode's own fetch retry; the
goal saw exactly one failed turn.

## The defect, in the classifier's own words

`providerStopReason` in `src/round-policy.ts` documents the opposite of what its
fallback branch does:

> A status outside the refusal set is left alone — a 500 or a dropped connection is
> transient, and stopping a goal for one would lose work the next attempt would have
> finished.

But the branch below it:

```ts
if (status === undefined && !type.startsWith('provider.')) return undefined
```

sends **every** status-less `provider.*` error down the stop path, and
`provider.transport` is a status-less `provider.*` error. A DNS failure therefore
becomes `usage-limited`, which is wrong three ways:

1. **the wrong tier** — `usage-limited` is arithmetic, so it stops on the first
   breach with no challenge, exactly the behaviour reserved for a cap that has been
   reached;
2. **the wrong message** — "the provider refused the request" describes a provider
   that answered. This one was never reached;
3. **the wrong diagnosis** — it sends the human to their subscription when the truth
   is their network.

Measured, the two error shapes are distinct: `provider.auth` with `status: 403` ("An
active OpenCode Go subscription is required") is a refusal; `provider.transport` with
no status and `getaddrinfo ENOTFOUND` is a connection that never opened.

## A second, smaller category error

`GoalAccounting.onTurnEnded` increments `turnsWithoutToolCall` for **any** turn that
made no tool call, including one that never ran. "The goal is talking without acting"
is a claim about the model's behaviour, and a turn that failed to connect says
nothing about the model's behaviour. Counting it means a network outage eventually
stops the goal as `no-tool-call` — a second wrong code for the same cause.

## Design

1. **A transport failure is not a refusal.** `providerStopReason` returns `undefined`
   for one, so the goal carries on — which is the function's own documented policy,
   finally applied to the branch that contradicted it. Recognised by type
   (`provider.transport`) or, when the type is absent or generic, by a message that
   names the connection.
2. **A failed turn is not a tool-less turn.** The stall counter stops counting turns
   that never ran, so the `no-tool-call` guard keeps meaning what it says.
3. **Consecutive transport failures stop the goal with a code that names them.** A
   new arithmetic code `provider-unavailable`, after a limit of consecutive
   transport failures. A one-off blip is ridden out; a sustained outage stops
   durably and says why.

## What this costs

The block-code set grows by one, so decision 28 in the spec is amended rather than
left stale. A goal on a flaky network now burns up to the transport-failure limit
before stopping, where before it stopped on the first blip — which is the point, and
is bounded.

## Out of scope

- Distinguishing "the provider is down" from "this machine is offline". Both are
  transport failures and both need the same human action.
- Backoff. The goal re-admits immediately after a failure, which is the existing
  behaviour for every non-stop outcome.

---

# Implemented

## What changed

- **`src/round-policy.ts`** — `providerStopReason` no longer classifies a transport
  failure as a refusal. A connection that never opened is recognised by type
  (`provider.transport`) or, when the type is absent or generic, by a message that
  names the connection. New `TRANSPORT_FAILURE_LIMIT = 3`, `transportFailureReason`,
  `isTransportFailure` and `transportMessage`, so the classifier and the counter
  answer the same question by the same rule.
- **`src/state.ts`** — `transportFailures` in the runtime state, with
  `noteTransportFailure` / `noteTransportSuccess` / `transportFailureCount`. Its own
  counter rather than a reuse of `turnsWithoutToolCall`, because the two count
  different things.
- **`src/driver.ts`** — `finish()` rides out a transport failure and re-admits;
  three consecutive ones stop the goal with `provider-unavailable`.
- **`src/accounting.ts`** — `onTurnEnded` takes a `failed` flag and skips the stall
  increment for a turn that never ran.
- **`src/types.ts`** — `GoalBlockCode` gains `provider-unavailable`.
- **`SPEC.md` decision 28** — amended rather than left stale.

## Tests — fourteen, five of which fail on HEAD

The four driver tests fail on HEAD for the right reason: `one failure is ridden out`
receives `blocked` where it should read `active`, which is the defect itself.

**The ten stops tests are not counted that way, and the reason is recorded.**
`test/stops.test.ts` imports `transportFailureReason` and
`TRANSPORT_FAILURE_LIMIT`, neither of which exists on HEAD, so the whole file fails
to *load* there rather than failing individual assertions. That is not the same
evidence, and it is not claimed as such. What is claimed is the live evidence: the
human's own goal log recorded `usage-limited` with `provider.transport` and
`getaddrinfo ENOTFOUND`, which is HEAD's behaviour on a real failure.

## One assertion corrected rather than weakened

The outage test asserted `promptCalls.length === before + 2`, on the reading that
the third admission would be refused. It is `before + 3`: the limit is *three*
consecutive failures, so the third round is the third attempt and its prompt is
submitted before its turn fails. Stopping on the first failure is exactly the
behaviour this change removes, and the test now says so.
