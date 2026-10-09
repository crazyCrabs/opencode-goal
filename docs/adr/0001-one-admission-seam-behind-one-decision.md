# 0001 — One admission seam behind one decision

- **Status:** Accepted
- **Date:** 2026-09-24
- **Tickets:** 15, 18, 21

## Context

Two entry points admit goal rounds. The continuation driver admits the round
after a turn finishes; the command plane admits the first round after a human
creates, edits or resumes a goal. They had grown separate copies of the same
policy, and the copies had drifted in ways that mattered: the command plane let a
lost compare-and-set race escape as an unhandled rejection, and it never cleared
an expired external wait, so a goal whose deadline had passed sat quiet forever
with nothing recording why.

The two callers also know different things. The server knows from its event
stream whether a turn is running, because it submitted the prompt that started
it. The command plane knows from the UI, because it holds the UI. Neither can
answer the other's question, and the temptation was to build a shared turn
registry that neither owns.

## Decision

Admission is one function, `admitRound(store)`, and both entry points cross it.
It names no caller. What each caller knows that the other does not — a session
id, a directory, whether a turn is active, how to submit a prompt, how to report
— stays at the caller.

The policy is a single ordered sequence: not active, disarmed, waiting,
guardrails, then the compare-and-set. Each check's position is policy rather than
accident, and the order is documented at the function so it cannot be reordered
casually.

The round-boundary crossing for the judgment streak lives inside admission too,
so neither entry point can reset a streak the other is counting.

## Consequences

- A policy change is one edit, and it cannot land on one entry point only. The
  two drift defects are structurally gone rather than fixed.
- The caller's private knowledge stays private. There is no shared turn registry,
  and the comment on `drive()` records why building one would be wrong.
- A new admission reason has to be classified once — `rejected` for nothing to
  do, `blocked` for a stop — which forces a new reason to be honest about which
  it is.
- The seam takes an already-resolved store, so a caller that cannot resolve one
  cannot reach admission. That is deliberate, but it means the seam is not a
  convenience wrapper for anything else.
