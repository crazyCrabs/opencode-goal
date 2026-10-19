# 19 — The external wait becomes durable, bounded, and woken by a human

**Type:** implementation
**Status:** resolved

**What to build:** waiting on an external event no longer means the goal sleeps
forever with no record of why. A wait survives a restart, always carries a bound, ends
the moment a human arrives, and — if nothing arrives — stops the goal with a reason
instead of resuming it blind.

**Blocked by:** 15 — One admission policy behind one seam, taken by both entry points;
17 — System stops become codes, and the provider-quota gap closes

## Acceptance criteria

- [x] The wait's deadline and reason are durable. A goal that was waiting before a
      restart is still waiting after it.
- [x] The deadline is a required argument. A wait with no bound cannot be expressed.
- [x] This removes the sentinel collision where one value meant both "not waiting" and
      "waiting with no deadline" — which is why a wait without a deadline used to not
      wait at all.
- [x] A user item arriving at the inbox event ends the wait. The signal carries the
      directory and the item, and it arrives before the turn is submitted rather than
      after it finished.
- [x] Distinguishing a human's item from the goal's own continuation prompt is free: the
      plugin only submits a prompt when admission is not suppressed, so while a goal is
      waiting no goal-originated inbox item can arrive. There is a comment saying so.
- [x] A wait whose deadline passes with nothing having arrived stops the goal with the
      wait-expiry code, rather than clearing and admitting the next round.
- [x] That stop is arithmetic-tier, so it stops immediately and is not gated three
      rounds.
- [x] The tool's description now says what is true — a required deadline, ended by a
      human arriving or by the deadline — and nothing it does not do.
- [x] An expired wait is cleared by one policy, because both entry points cross the
      admission seam.

**Recorded with its margin:** the verdict behind "expiry blocks rather than resumes"
was a coin flip, 0.52 against 0.46 at confidence 0.29. It is the weakest decision in
the spec and the first one to revisit if the behaviour feels wrong in use.

## Outcome

**171 tests pass, 0 fail. `tsc --noEmit` clean. `bun run build` clean.**

The wait moved off `RuntimeState` and onto `GoalSnapshot`. `GoalStore.wait()` now takes
a required deadline and writes `waitUntil` / `waitReason` into the log; `endWait()`
clears them durably and is safe on a goal that is not waiting. The setters are gone —
the wait is written only by `wait()` and cleared only by the admission seam and by a
phase transition, so there is no second writer to disagree with.

### The sentinel collision

`waitUntil === 0` used to mean both "not waiting" and "waiting with no deadline",
because an absent `resume_after_ms` was folded to 0 — the same value that meant not
waiting. So a wait with no deadline did not wait at all: admission saw 0, read the
goal as not waiting, and ran the next round immediately. Zero now names exactly one
state, and `wait()` validates that a deadline is present and positive.

### What ends a wait

| What | Effect |
| --- | --- |
| a human's inbox item | `endWait()` + arm, so the arriving turn drives the next round |
| the deadline passing | `wait-expired`, an arithmetic-tier stop |
| pause / resume / complete / block | cleared; only `wait()` sets it |
| edit | left alone — a human editing the objective has not resolved what was awaited |

The deadline stop carries the wait's own reason, so the record says what was waited
for. It is arithmetic-tier and stops immediately, which ticket 18 already places it in:
the tier table names `wait-expired` and the test for that tier asserts its behaviour,
so 19 only had to make the wait durable enough to reach it.

### The wake event

`session.inbox.enqueued` carries a `location` and an `item` tagged `user` — both
confirmed in all four recordings, where every occurrence was
`(hasLocation: true, item.type: 'user', delivery: 'steer')`. It is an *enqueued*
event, so it arrives before the turn is submitted rather than after it finished.

The free distinction the ticket asks for is recorded in `index.ts`: `item.type` is a
tagged union (`user`, `synthetic`, `compaction`, `move`), so a human is named
outright; and structurally, while a goal is waiting admission is suppressed, so the
plugin submits no continuation prompt, so no goal-originated inbox item can arrive
during a wait at all. Either fact alone would do.

### One thing the ticket's own wording needed

Both entry points clearing an expired wait "by one policy" is literally what the seam
does, but reaching it needs the store armed — and a store that came alive beside a
waiting goal is disarmed by design, so it is rejected as `disarmed` first. That
ordering is itself policy (a goal nobody has touched is not one this process should be
driving), and it is now tested as such: `disarmedExpiredWaiter()` proves the ordering,
`expiredWaiter()` — which adopts another writer's mutation and so is armed — proves the
stop.

## Related

- Ticket 12 named the drift this closes: the command plane never cleared an expired
  wait, so a goal whose deadline had passed sat quiet forever.
- Ticket 18 placed `wait-expired` in the arithmetic tier and tested it there before
  the wait itself was durable.
