# 0003 — A finished human turn re-arms a goal that predates the process

- **Status:** Accepted
- **Date:** 2026-10-08
- **Ticket:** 26

## Context

A goal is disarmed when the store that folded it came alive beside it, because
activation is process-local and a goal that merely survived a restart is meant to
wait for an explicit resume. `session.created` re-arms one, because opening a
session is a human touching the goal — but it fires once per session, at
creation, so it structurally cannot see a session that already existed before
this process.

That is every session in `opencode run --standalone`: four live runs, zero
`session.created` events. It is also every session left open across a server
restart. A goal in such a session had no trigger at all, and the user's reported
defect was exactly this — a goal created from the TUI's home route stayed silent
until a message was sent.

The two candidate triggers were both dead ends, and it is worth recording why:

- **A poll.** `session.list` and `session.active` exist on the HTTP client and
  are absent from the plugin context's `SessionDomain`, which Picks only
  `create | get | switchAgent | switchModel | prompt | generate | command |
  synthetic | interrupt | update | move | wait | context`. A store poll could see
  a goal and never the session to run it in. No file-watch API exists anywhere in
  the plugin surface either.
- **A timer.** Asked directly, the answer was no (16% yes).

## Decision

A finished human turn is a human go-ahead of the same kind `onSessionCreated`
already treats session opening as, and unlike it is not one-shot per session: it
arrives every time the human sends a message.

`GoalDriver.adoptOnHumanTurn(sessionID, directory)` arms a disarmed active goal
and nothing else, called from the event handler beside `onSessionCreated`. Only
the arm happens there — whether the goal runs stays with admission, taken through
the same seam as every other trigger, so a paused, blocked, completed or waiting
goal is rejected there rather than armed into running.

A goal round's own completion cannot consent for the goal. The gate is
`isGoalTurn(sessionID)`: `roundsInFlight` still holds the session at that point,
because `finish` is what releases it and it runs afterwards, so the turn being
reported is recognised as the goal's own. This is the driver's decision rather
than the event handler's, because the driver is the only one that knows whose
turn it was.

## Consequences

- The `opencode run --standalone` case and the restart case both work, with no
  timer and no poll.
- Two triggers now arm — a session opening and a finished human turn — but
  admission remains one seam, so there is no second admission policy to disagree
  with the first.
- The DSH posture that a goal surviving a restart waits for an explicit resume is
  abandoned for this case. It was already abandoned for session opening; this
  extends the same reasoning to the trigger that can actually see a pre-existing
  session.
- An unrelated human turn in the project re-arms a goal. That is the cost, and it
  was weighed rather than discovered later.
- Re-arming after a restart still needs a human turn. Nothing re-arms a goal with
  no human action, and that is deliberate rather than an oversight.
