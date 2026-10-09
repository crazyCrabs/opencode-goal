# 0004 — One directory resolution, and an invariant check keeps reporting

- **Status:** Accepted
- **Date:** 2026-10-08
- **Ticket:** 25

## Context

opencode 2.x sends some goal events with a location envelope and some without,
and the plugin needs a project directory for every one of them. Three branches of
the event handler had each grown their own answer: the inbox wake path read
`event.location?.directory` directly with no fallback, while the step and
execution branches consulted a resolver that learned a session's directory from a
location-bearing event and otherwise asked `session.get`.

The hand-written answers had also drifted from the live server in three measured
ways, and each one is worth recording because each was a place where the protocol
types asserted something the server did not do:

- four recordings said `session.inbox.enqueued` carries a location; the live run
  said it does not;
- the protocol types declare a flat `SessionInfo.directory`; eight live
  `session.get` results across four recordings all reported `hasTopLevelDirectory:
  false` and carried the directory under `location`;
- `session.viewed` is declared in `@opencode/protocol` and never published —
  three successful 200 calls produced zero events out of 563 recorded.

## Decision

One function, `resolveTurnSession(sessionID, locationDirectory)`, answers every
branch. It reads the map learned from location-bearing events first and falls back
to `session.get`, and it returns `undefined` for a session this instance does not
own or that belongs to a subagent. The inbox branch's repeated `childSessions` and
`ownsDirectory` checks were deleted rather than kept, because a guard answered in
two places is a guard that can disagree with itself.

`LOCATION_LESS_EVENTS` — the set that decides whether a location-less event is
expected or surprising — was deliberately left alone. Moving
`session.inbox.enqueued` into it would assert the live shape over four recordings,
which is the same unresolved question another ticket was chasing, and it would
silence a monitor that is reporting something already investigated. The cost is
one warning per human message, and it is stated rather than hidden.

## Consequences

- A new branch cannot grow its own directory logic; the resolver is the only
  answer, and it is the one that already handles subagent sessions and foreign
  projects.
- The event handler gained an `await` in the inbox branch, which made it async and
  wrapped it the same way the idle and execution branches already were.
- An existing test was wrong rather than in the way: "another project's inbox item
  does not end this project's wait" used one session id in two projects at once, a
  state no real session can occupy. The test was corrected to teach the resolver
  the session's project, and the correction recorded.
- The warning stays. The invariant check is doing its job, and a tidy log was
  judged less valuable than a monitor that keeps reporting.
