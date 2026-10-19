# 25 — The inbox wake path reads a location the live server does not send

**Type:** defect
**Status:** resolved — implemented in `d557b15`. Two regression tests, both proven
against `HEAD` with the fix reverted, plus one existing test corrected rather than
worked around.

**Blocked by:** 19 — the external wait becomes durable, bounded, and woken by a human

## What was observed

Ticket 19 made `goal_wait` durable and gave it a wake source: a human's inbox
message arms the store and ends the wait, so a goal no longer has to be awake to
hear it. That path was written against four recordings in which
`session.inbox.enqueued` carried `event.location`.

The first live run of the rework disagreed. `src/index.ts`'s runtime invariant
check — the one ticket 16 installed so a shape change cannot pass silently —
logged:

```
session event location shape differs from the recorded one {
  type: "session.inbox.enqueued",
  carriesLocation: false,
  expectedLocationLess: false,
}
```

**On a live v2 server, `session.inbox.enqueued` carries no location.**

## Why the path then does nothing

`src/index.ts:359` — the inbox branch is the only branch in the whole event
handler that reads the location directly and has no fallback:

```ts
const directory = event.location?.directory
if (directory === undefined || directory.length === 0) continue
```

Every other branch that needs a directory calls `resolveTurnSession(sessionID,
event.location?.directory)`, which falls back to the `sessionDirectories` map
(filled by the location-bearing `session.step.started`) and then to
`ctx.session.get`. The inbox branch has neither fallback, so with no location on
the event it `continue`s before reaching `store.view()`.

The consequence is not a degraded wait — it is **no wait ending at all**. A
waiting goal never hears the human arrive, `waitUntil` stays in the future, and
admission keeps rejecting with `waiting` until the deadline expires, at which
point the goal blocks with `wait-expired` (arithmetic tier) rather than
resuming on the human it was waiting for. The human is the wake source ticket 19
promised, and the one path that implements it is the one path that cannot hear
them.

## What makes this a defect and not a stale fixture

The invariant check exists for exactly this: it compares the live shape against
the recorded one and says so instead of letting the branch quietly no-op. It
fired on the first live run. The recordings were made on the same server version
(2.0.14), so this is not a version drift — it is a shape that is true of the
recorded run and false of this one, and the code took the narrower of the two.

## The fix direction

Use `resolveTurnSession(sessionID, event.location?.directory)`, as the step and
execution branches already do. That is a one-line change to the same shape every
other branch has, and it is the inconsistency rather than the fallback that is
surprising here.

Two things the fix must keep:

1. **The `waitUntil === 0` guard before arming.** A goal that is not waiting is
   not one this event is about, and arming a store that came alive beside an
   unwaiting goal is disarming-by-design territory.
2. **The `childSessions` guard.** A subagent's session must not wake the parent's
   goal.

## What has to be decided rather than assumed

Whether the recordings or the live run describe the common case. Four recordings
said `hasLocation: true`; the live run said `false`. Both were real servers at
2.0.14. If the location is present in the TUI and absent on the API path — the
same split ticket 09 is still chasing — then a fix that only adds the resolver
covers both, and the question stops mattering. That is an argument for the
resolver rather than against knowing the answer.

Jev has not been asked. This ticket exists so the change is made deliberately.

## What was done

`src/index.ts` — the inbox branch now resolves its directory the way every other
branch does:

```ts
const directory = await resolveTurnSession(sessionID, event.location?.directory)
if (directory === undefined) return
```

The branch itself became async, wrapped in `void (async () => { ... })()` exactly
as the idle and execution branches are, because the resolver awaits a `session.get`
when the map has nothing.

Both requirements held:

1. **`waitUntil === 0` is still checked before arming.** A goal that is not waiting
   is not one this event is about.
2. **The subagent guard still holds — now supplied by the resolver.** It returns
   `undefined` for a session in `childSessions`, which is the same set the branch
   used to check by hand. The `childSessions`/`ownsDirectory` lines the branch used
   to repeat were deleted rather than kept, for the same reason the step and
   execution branches do not repeat them: a guard answered in two places is a guard
   that can disagree with itself.

## One existing test was constructing a state no session can be in

`another project's inbox item does not end this project's wait` used one session id
and put it in two projects: `stepStarted('ses-other')` taught the adapter that the
session lived here, then `inboxArrivedIn` reported the same session in `other`.
The old branch read the envelope and got `other`; the resolver reads the map first
and would get here. The test now does `stepStarted('ses-other', other)`, so the
session genuinely lives elsewhere and the map agrees with the envelope.

Noted because the alternative — leaving the test alone and reading it as a
regression — would have pointed at the resolver, and the resolver is not what was
wrong.

## The invariant check was deliberately left reporting

`LOCATION_LESS_EVENTS` still does not contain `session.inbox.enqueued`, so the
check ticket 16 installed keeps logging on every inbox event. That was a choice,
not an oversight. Moving the event into the set would assert the live shape over
the recordings, and that is precisely the question the ticket says is unresolved.
Silencing a monitor because it reports something already investigated turns it into
a monitor nobody reads.

The cost is stated plainly: one warning per human message, on the event whose
useful line ("goal wait ended by a human arriving") follows it. When ticket 09
settles which path carries the location, this event's set membership is updated in
the same change.

## Proof the tests catch the defect

Both new tests were run against `HEAD` with the fix reverted:

```
a human arriving on a location-less inbox item still ends the wait
  expect(after.waitUntil).toBe(0)  ->  Received: 1791435524522   (fail)

a subagent session's inbox item does not wake the parent's goal
  ->  Received: 1791435543195                                  (fail)
```

`1791435524522` is the deadline still in the future: the wait never ended, which is
the defect. The child test fails on its second assertion at HEAD — the human's own
bare item cannot wake it either — because at HEAD nothing on this event can.

## State

`bun test` 208 pass / 0 fail (was 206; two tests added, none removed),
`tsc --noEmit` clean, `bun run build` clean.
