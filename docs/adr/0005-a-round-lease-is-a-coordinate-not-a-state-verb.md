# 0005 — A round lease is a coordinate, not a state verb

- **Status:** Accepted
- **Date:** 2026-10-09
- **Ticket:** 27

## Context

Two opencode processes on one worktree each fold the same goal log, and each holds
its own in-memory round bookkeeping keyed by session. Neither can see the other's
round. One turn-completion event then reaches both, both admit a round, and the
two continuation prompts coalesce into each other: opencode interrupts a turn when
a prompt arrives mid-turn, and the interruption is itself a turn-completion event,
so the loop runs itself.

Measured in-process: one event fanned out to two processes admitted two rounds,
and with prompt coalescing modelled the result was four `continue` mutations
inside 51 ms with `in=0 out=0` on every one, stopped only by a stall guard. That
is the shape of a recorded anomaly — eleven `continue` mutations inside 20 ms with
zero usage folded — whose other three candidate explanations were each ruled out
by measurement: execution events are per turn rather than per step; a burst of
completions for one session admits exactly one round; eleven child sessions
completing in one burst admit none.

The compare-and-set does not cover it. Each process re-folds on every read and
compares on the current revision, so two drivers that do not interleave both
succeed. The revision says *where* the goal is, not *who* is driving it.

## Decision

Round ownership is durable, in the goal log, as its own line kind:
`{kind: 'goal/lease', version, id, holder, at, expiresAt}`.

It is a **coordinate, not a state verb**. The fold gives it its own slot and never
lets it reach the goal accumulator, the revision, or `lastRef`; a lease naming a
goal other than the current one is dropped. A lease line read as a round would
make every round look like two, which is why it is a separate kind rather than a
field on the snapshot.

A holder is one `randomUUID()` per driver, therefore one per process. Admission
rejects with `leased` when an unexpired lease is held by another process. The
driver acquires the lease after admission commits and before it submits, renews it
from the round's own step events, and releases it when the turn reports back.
Expiry is read at call time, so a process that dies mid-round releases its round
by doing nothing at all — the whole crash story needs no liveness protocol.

The command plane presents its own holder and deliberately does **not** override.
Overriding would be the double-driving defect arriving through the one door meant
to be the human's.

## Consequences

- The loop converges. With the lease, one fan-out admits two rounds and twenty
  further events admit none; without it, the same run stopped only because a stall
  guard happened to fire.
- A live pair of servers on one worktree produces one distinct holder across every
  run, and the lease is written and renewed on a real v2 server.
- **It does not make admission atomic.** Two processes can both pass the check
  before either writes, and one extra round is then admitted. What it closes is the
  loop, which is what made the defect unbounded.
- The lease check sits behind the disarmed check, so a process started after the
  goal exists cannot reach it until a human turn re-arms it (see ADR 0003). The
  lease's real job is between processes that are both armed.
- The goal log gained a line kind that is neither a round, a block, a wait nor
  usage. Every reader of the log — including the fold, and including a human —
  has to know that a lease is not a state verb.
- Renewal is rate-limited to roughly once per half-window, because a twenty-round
  goal would otherwise write two hundred lines for one fact.
