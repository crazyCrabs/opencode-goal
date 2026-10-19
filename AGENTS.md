# opencode-goal — agent guide

Everything here is a pointer. The material lives in the files named and is reached
when its trigger fires; nothing in this file summarises it.

## Before changing goal behaviour

Read the tracker first. [`.scratch/goal-rework/map.md`](.scratch/goal-rework/map.md)
names the destination and what is still open, [`SPEC.md`](.scratch/goal-rework/SPEC.md)
carries the numbered decisions, and [`issues/`](.scratch/goal-rework/issues) holds one
file per unit of work with its acceptance criteria. A change that contradicts a
numbered decision is either a new decision — record it — or a defect — ticket it.
It is not a silent edit.

The tracker was untracked for ten days and invisible for all of them; two units of
work were implemented from a summary instead of from the spec. It is committed now.
Do not move it back out.

## Before naming anything

[`CONTEXT.md`](CONTEXT.md) fixes the domain vocabulary — goal, goal round, phase,
activation, block reason, guardrail, continuation, command plane, goal log,
compare-and-set ref — each with the synonyms it replaces. New types, fields, block
codes and log line kinds take their names from it, so a reader meeting `roundsStarted`
in one file meets the same word in the next.

## Before adding a goal-log line kind

[`docs/goal-log-protocol.md`](docs/goal-log-protocol.md) is the checklist. A new line
kind is not one edit in one file, and nothing in the type system enforces the rest.

## Before changing an established mechanism

[`docs/adr/`](docs/adr/README.md) records the decisions this design turned on, each
with the forces that argued against it. A change that contradicts one supersedes it;
it does not delete it.

## Verifying

`bun run check` runs typecheck and the suite. The pre-commit hook typechecks only, so
a red suite is not caught before a commit — run the check yourself before saying a
change is verified.
