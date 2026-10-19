# opencode-goal

A plugin that gives an opencode agent a persistent objective it keeps working
toward across turns, with guardrails that decide when to stop.

## Language

**Goal**: A completion objective the agent works toward autonomously, surviving
across turns and restarts.
_Avoid_: task, job, issue, ticket, project

**Goal round**: One autonomous turn taken on the goal's behalf, admitted by the
continuation loop. Only admitted goal rounds consume the round budget.
_Avoid_: step, iteration, turn (a turn is any turn; a goal round is one taken *for* the goal)

**Phase**: What happened to the goal over its life — `active`, `paused`,
`blocked`, or `complete`. Durable.
_Avoid_: state (too general), status (reserved for the whole set including
activation), lifecycle

**Activation**: Whether this live process may start another goal round —
`armed` or `disarmed`. Process-local and never persisted. A phase records what
happened; activation records whether fresh authority to spend resources exists.
_Avoid_: permission, authorization, readiness

**Block reason**: A machine-routable classification of why a goal stopped:
a stable lower-kebab-case code plus a human-readable message.
_Avoid_: error, failure, excuse

**Guardrail**: A policy that admits or refuses the next goal round — round cap,
token budget, no-progress detection, external wait, stale-turn check.
_Avoid_: limit, threshold, rule, safety check

**Continuation**: The loop that admits and submits one goal round after another.
_Avoid_: retry, polling, loop

**Command plane**: The human-facing surface — `/goal` and its actions — which
executes directly in the UI and never spends a model turn.
_Avoid_: slash command, CLI, control panel

**Goal log**: The append-only record of every goal mutation, and the only
durable authority for what the goal is.
_Avoid_: database, store, state file, history

**Compare-and-set ref**: The exact `{ id, revision }` identifying the goal
instance a mutation targets, so a delayed writer cannot mutate a newer one.
_Avoid_: handle, token, cursor, version (revision alone is one half of it)

**Admission**: The decision that a goal round may run — distinct from its
execution. Admission is governed; execution is not.
_Avoid_: scheduling, dispatch, approval
