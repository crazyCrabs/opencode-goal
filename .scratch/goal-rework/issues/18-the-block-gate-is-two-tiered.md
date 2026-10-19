# 18 — The block gate is two-tiered

**Type:** implementation
**Status:** resolved

**What to build:** a goal never stops on the first observation of a condition that
might be wrong, and never re-litigates arithmetic that has already happened. Judgment
about the agent's own claims is challenged for three consecutive rounds; a limit that
has actually been reached stops the goal immediately.

**Blocked by:** 17 — System stops become codes, and the provider-quota gap closes

## Acceptance criteria

- [x] The gate is by tier, not per code, and the two tiers are:

      | Tier | Members | Behaviour |
      | --- | --- | --- |
      | Judgment | model-reported impasse, no-progress | Rejected until the same condition persists 3 consecutive rounds |
      | Arithmetic | round limit, token budget, provider quota, wait expiry | Stops immediately |
- [x] A new code joining the arithmetic tier takes the immediate behaviour, and joining
      the judgment tier takes the three-round behaviour. Where a new code belongs is
      decided by its nature, and the ticket says which tier a given code is in.
- [x] The three-round gate counts consecutive rounds with the *same* condition, not
      three rounds with any judgment block.
- [x] A model-reported impasse that clears on the next round resets the count rather
      than accumulating.
- [x] There is a test per tier, not per code: one showing a judgment block surviving
      three identical rounds before it is accepted, one showing an arithmetic limit
      stopping on the first breach.
- [x] Gating an arithmetic limit is not implemented anywhere, and there is a comment
      saying why it would be wrong rather than merely unnecessary.

## Outcome

**153 tests pass, 0 fail. `tsc --noEmit` clean. `bun run build` clean.**

The tier is a table, `BLOCK_TIERS` in `src/round-policy.ts`, keyed by a new closed
`GoalBlockCode` union in `src/types.ts`. `gateBlock(store, reason)` applies it. The
streak lives in `GoalStore` beside the no-progress fingerprint it mirrors, and the
round boundary is crossed in `admitRound`, which both entry points go through.

### The tier table

| Code | Tier | Why |
| --- | --- | --- |
| `model-reported` | judgment | the model's own claim about a situation it may be wrong about |
| `no-progress` | judgment | three identical rounds is already a three-round observation |
| `round-limit` | arithmetic | a cap that has been reached |
| `budget-limited` | arithmetic | a bill that has been spent |
| `usage-limited` | arithmetic | a refusal that has been returned |
| `wait-expired` | arithmetic | a deadline that has passed |

`usage-limited` joined the arithmetic tier in ticket 17 and took the immediate
behaviour; `model-reported` joined the judgment tier and took the three-round
behaviour. Both are asserted against the table rather than against their own
behaviour, so moving a code between tiers is a one-line change with a visible test
failure.

### The streak, and where the boundary is

`recentJudgments` mirrors `recentOutputs`: a different reason resets the run rather
than adding to it, so a model naming a new obstacle each round never accumulates
toward a stop. `endJudgmentRound()` clears the streak when the round that just ended
carried no impasse.

The boundary sits in `admitRound` for two reasons, both of which the ticket implies
without stating: both entry points cross it, so neither can reset a streak the other
is counting; and it sits *after* the waiting check, because a goal that is waiting has
run no round and so must not cross one.

### One correction made while building it

`judgment-pending` was added to `AdmissionVerdict` and then removed. It was
unreachable — the only judgment code `goalBlockReason` raises is `no-progress`, which
is already a three-round observation — and worse, it encoded the wrong behaviour: it
would have told the caller to do nothing, which would have stopped a goal whose
impasse was merely unconfirmed. An unpersisted judgment is not a verdict. It falls
through to admit, and `round-policy.ts` records that the branch is defensive for a
future judgment code rather than live today.

### A latent bug this surfaced

`goalTools` called its store factory on every tool call, so each `get_goal` or
`update_goal` built a **fresh** `GoalStore`. Every piece of process-local state —
activation, the external-wait deadline, the no-progress fingerprint, and now the
judgment streak — was reset between two calls in the same round. In production this
was masked: `index.ts` passes a memoizing `getStore`, and the driver caches its own.
But the masking is what hid it, and a judgment streak could never have reached three
through a non-memoizing caller. `goalTools` now memoizes, with the reason written into
its doc comment.

## Related

- Ticket 17 added `usage-limited` and this ticket gave it a tier.
- Ticket 19 adds `wait-expired`, which this ticket already placed in the arithmetic
  tier; the code is in `BLOCK_TIERS` and tested there, so 19 only has to make the wait
  durable.
