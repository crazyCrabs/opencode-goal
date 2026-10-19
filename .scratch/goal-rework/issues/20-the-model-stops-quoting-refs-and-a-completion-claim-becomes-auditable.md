# 20 — The model stops quoting refs, and a completion claim becomes auditable

**Type:** implementation
**Status:** resolved

**What to build:** the model no longer copies back an id and a revision to make a
mutation, and when it declares a goal achieved it declares what it did rather than
summarising it. A typo can no longer reject a mutation, and a claim of completion can
be checked against what actually ran.

**Blocked by:** 15 — One admission policy behind one seam, taken by both entry points

## Acceptance criteria

- [x] `update_goal` takes an action and its payload. The id and revision leave the
      model's vocabulary; the server resolves which goal the session is working on.
- [x] The whole failure class of "call get_goal first, copy two fields, be rejected on a
      typo" is gone, and there is no test that requires a model to echo a ref.
- [x] The tool bundle stays at four. Only arguments and descriptions change. Splitting
      the completion and impasse actions into their own tools is not done — the action
      already names the operation once the ref is gone.
- [x] A completion claim is structured: `summary`, `criteria[{criterion, evidence[]}]`,
      `checks[{command?, result, exitCode?, explanation?}]`. This shape encodes a
      decision; it is not an implementation.
- [x] A claim with no criteria is rejected, so a partially-met objective cannot be
      recorded as a success.
- [x] The model still owns the lifecycle verbs it owns today — pause, resume, edit,
      wait. Restricting it to complete-and-impasse is explicitly not done here.
- [x] A claimed exit code is cross-checkable against the event stream rather than
      trusted: the tool-success event carries metadata including the exit code of a
      command that actually ran. Where the claim and the events disagree, the
      disagreement is visible.
- [x] The marker-in-prose alternative is not implemented, and the ticket records that
      its own authors call it fragile and model-dependent.
- [x] The round prompt and the system-prompt block no longer quote a ref, because there
      is none to quote.
- [x] The wait's deadline requirement is a required argument on the wait tool, and this
      ticket does not implement it — ticket 19 does. The two tool schemas change in
      separate tickets and do not conflict.

**Recorded as a synthesis:** the structured claim itself was a near-0.5 verdict (0.60)
tipped by the reasoning that the three-round gate on a model-reported impasse only
works if the model's own claims can be compared across rounds, and a free-text summary
is not comparable. The evidence bar — criteria plus checks — was unanimous at 0.97.

## Outcome

**189 tests pass, 0 fail. `tsc --noEmit` clean. `bun run build` clean.**

`goal_id` and `revision` appear nowhere in any tool schema, descriptor or required
list. Each mutation resolves the goal itself from the store at the moment it runs.
`goalRef` and `requirePositiveInteger` were deleted rather than left unused.

### The failure class, and what replaced it

The model used to read `get_goal`, copy two fields into every mutation, and be rejected
on a typo. Nothing was bought by that: the compare-and-set those fields feed is exactly
as strong when the server reads the current goal itself, and reading it at mutation
time is *fresher* than the model reading it at the start of its turn. `get_goal` still
reports the id and revision — a human reading the log wants them — it just no longer
tells the model to echo them.

No test requires a model to echo a ref, and one test asserts that no schema asks for
one, so the class cannot come back without a visible failure.

### The claim

`update_goal(action="complete")` takes `claim: { summary, criteria[], checks[] }`.
`validateCompletionClaim` in `types.ts` refuses a claim with no criteria, a criterion
with no evidence, an unparseable check result, or a summary that contradicts itself.
The claim is **recorded on the goal** and written to the log, because auditable means it
can still be read after the round that made it — a claim that only ever reached the tool
result was a message, not a record.

### The cross-check

`session.tool.success` carries `metadata.exit` when a command actually ran. The two
live examples were `{ truncated: false }` for a `read` and
`{ status: "completed", truncated: false, exit: 0 }` for a `bash` — so a read records
nothing rather than a guessed zero.

`GoalAccounting` folds those exit codes per goal, and the tool compares the claim's
`checks` against them, returning for each check `agrees: true | false | null` plus a
whole-result `warning` when nothing ran at all. A check with no claimed exit code is
`null` — it is not a claim the event stream can contradict, and reporting it as a
disagreement would be a lie.

The three integration tests run this end to end: a command that ran and backed the
claim, nothing having run, and a command that ran with a different exit code.

### Why the marker approach was rejected

The ticket records that its own authors call marker-in-prose fragile and
model-dependent: a model that phrases its summary differently breaks the marker, and
then the claim is silently unparseable. A structured field cannot be mis-parsed into
nothing — it is either absent, which is an error the model can act on, or present.

### One thing worth flagging

`get_goal` still returns the goal's `id` and `revision` in its JSON. That is deliberate
and is not a leftover: the criterion is that the *model stops quoting refs*, not that
the refs stop existing. The human inspection surface and the log both want them.

## Related

- Ticket 18's three-round gate on a model-reported impasse is what the structured claim
  was carried by: two rounds' claims can now be compared, because `criteria` and
  `checks` are comparable where a summary is not.
- Ticket 19 changed `goal_wait`'s schema in the same shape (required deadline, no ref)
  from the other side; the two schemas do not conflict, as the ticket predicted.
