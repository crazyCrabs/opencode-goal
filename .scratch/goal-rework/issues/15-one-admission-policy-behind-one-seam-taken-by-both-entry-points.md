# 15 — One admission policy behind one seam, taken by both entry points

**Type:** implementation
**Status:** resolved

**What it delivers:** a single module decides whether a goal round may be admitted
and commits that decision, and both the autonomous driver and the human command
plane cross that one seam. The two entry points can no longer disagree about a
policy, because there is one.

**Blocked by:** 13 — Extract the round prompt and guardrail verdict from the driver
module; 14 — Usage accounting moves off the transcript onto durable native events

## Acceptance criteria

- [x] The admission decision sits behind one function with no parameter naming the
      caller, because both entry points run identical policy:

      ```ts
      function admitRound(store: GoalStore): AdmissionVerdict

      type AdmissionVerdict =
        | { kind: 'admitted'; round: number }
        | { kind: 'blocked'; reason: GoalBlockReason }
        | { kind: 'rejected'; code: 'not-active' | 'disarmed' | 'stale-ref' | 'waiting' }
      ```

      This shape encodes a decision; it is not an implementation.
- [x] The module takes an already-resolved store, not a session. The adapter resolves
      the directory before calling — a consequence of the completion events carrying
      no location.
- [x] Inside the module: the guardrails, compare-and-set admission, external-wait
      deadline expiry, and block-on-guardrail-breach tolerating a lost race.
- [x] Left at the adapter: directory resolution, per-session in-flight tracking, usage
      accounting, prompt submission, and reporting.
- [x] Both entry points call it. The human command plane's first-round kick and the
      autonomous driver's post-turn admission are the same policy.
- [x] An expired external wait is cleared once, by one policy.
- [x] A lost compare-and-set race is tolerated once — no entry point can produce an
      unhandled rejection on a lost race. This closes the first half of ticket 12.
- [x] The round prompt is rendered in one place, so rewording a round does not touch
      admission.
- [x] Admission is single-phase. The durable write is a synchronous append, durable on
      return, and every read re-folds the log before answering — so the reference
      architecture's two-phase reserve/await/re-check/race-fence protocol is not
      reproduced.
- [x] The one-round-at-a-time invariant stays enforced by two mechanisms, on purpose:
      the server knows from its event stream whether a round is in flight, the human
      command plane asks the UI whether a turn is active. There is a comment saying why
      these are not unified.
- [x] Tests cross the admission interface only. If a test needs to reach past it, the
      module is the wrong shape and that is a bug in this ticket, not a reason to test
      past it.

## Outcome

**118 tests pass, 0 fail. `tsc --noEmit` clean. `bun run build` clean.**

New module `src/admission.ts` (106 lines). `src/driver.ts` is down to 269 lines and
no longer contains any admission policy at all — its `drive()` method is now only
the adapter work: claim the session, render the prompt, submit it, disarm on a
provider error, report. `src/tui.tsx` lost its copy of the policy too, and neither
entry point imports `goalBlockReason` any more.

`test/admission.test.ts` holds 20 tests, all crossing `admitRound` and nothing else.

### The check order is policy, and it is documented as such

`not-active` → `disarmed` → `waiting` (clearing an expired wait) → guardrails →
compare-and-set. A test pins each ordering decision that could plausibly go the
other way: a paused-but-also-disarmed goal is `not-active`, a waiting goal is
rejected before its guardrails are evaluated, and a disarmed goal is rejected
*before* an expired wait is cleared — because nothing ran, so there is nothing to
clear for.

### What the seam actually bought, beyond removing duplication

`GoalStore.sync()` re-folds the whole log on every read, and `sameGoal` compares
revision as well as id and phase. So a store cannot hold a stale view across two
of its own reads: **the seam's read is always fresh.** That is what makes the
`stale-ref` branch narrow rather than load-bearing — it covers the window where a
*writer in another process* moves the goal between the seam's read and its commit,
which is real (the TUI and the server are separate processes on one log) but is
narrower than a synchronous test can open.

The test therefore proves the fix rather than simulating the race: it runs the old
command-plane pattern — read a view, let another writer move the goal, then act on
the stale ref — and shows it throws, then shows `admitRound` on the same goal
answers `admitted` round 2 by judging the goal's real state. A second test shows a
goal another writer advanced to its cap is blocked on its real state rather than
admitted from a stale view that thought the cap was unreached.

### One-round-at-a-time stays two mechanisms, with the reason written down

The comment in `drive()` and in `kickRound` says why they are not unified: the
server knows from its event stream whether a round is in flight because it
submitted the prompt that started it, and the command plane asks the UI whether a
turn is active because it holds the UI. Neither can answer the other's question,
and unifying them would need a shared turn registry that neither entry point has
a reason to own.

### Closes

Ticket 12, both drifts. The unhandled rejection is gone because the command plane
never touches `store.continue` or `store.block`; the silent goal after an expired
wait is gone because one policy clears it.

## A note on what did not change

`waitUntil` is still process-local, so clearing an expired wait survives only while
the clearing process lives. Making the wait durable is ticket 19's job and this
ticket deliberately left it alone — the clearing moved, the storage did not.
