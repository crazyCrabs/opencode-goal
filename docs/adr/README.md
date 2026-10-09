# Architecture decision records

One file per decision that a future reader would otherwise have to reconstruct
from a commit message. Numbered `NNNN-short-title.md`, four digits, never reused
and never renumbered — a superseded ADR keeps its number and its status changes
to `Superseded by NNNN`.

Each record answers four questions and nothing else:

| Section | What belongs there |
| --- | --- |
| **Status** | `Accepted`, `Superseded by NNNN`, or `Deprecated` |
| **Context** | The forces at the time, including the ones that argued against |
| **Decision** | What is now true, in one paragraph a reader can act on |
| **Consequences** | What this makes easier, what it makes harder, and what it costs |

An ADR records a decision, not a changelog. If a record's consequences section
reads as a list of features, the decision was too small to be one.

## The records

| # | Decision |
| --- | --- |
| [0001](0001-one-admission-seam-behind-one-decision.md) | Both entry points cross one admission policy |
| [0002](0002-durable-usage-is-a-delta-and-does-not-bump-the-revision.md) | A usage fold is a delta, not a snapshot |
| [0003](0003-a-finished-human-turn-re-arms-a-goal-that-predates-the-process.md) | A finished human turn is a human go-ahead |
| [0004](0004-one-directory-resolution-and-an-invariant-check-keeps-reporting.md) | One resolver, and warnings stay warnings |
| [0005](0005-a-round-lease-is-a-coordinate-not-a-state-verb.md) | Round ownership lives in the goal log |
