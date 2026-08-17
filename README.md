# opencode-goal

Persistent autonomous goals for [opencode](https://opencode.ai) (v2 plugin API).

Built from the combined design philosophies of two goal systems:

- **DSH goal architecture** (DeepSeek Harness): event-sourced append-only state
  log, compare-and-set (CAS) refs, orthogonal durable-phase / process-activation,
  strict round budgets.
- **pi-goal guardrails** (`@narumitw/pi-goal`): token budgets, no-progress
  detection, external waits, stale-turn guards, autonomous continuation from the
  idle boundary.

## Install

As a local plugin, drop the bundled `dist/index.js` into your project:

```
.opencode/plugins/opencode-goal.js
```

Or as an npm package (once published):

```json
{ "plugin": ["opencode-goal"] }
```

The `/goal` slash command is provided by a command file that teaches the model to
use the goal tools. Create `.opencode/command/goal.md` (project) or
`~/.config/opencode/command/goal.md` (global):

```markdown
---
description: Set or manage the autonomous goal for this session
---
The user invoked the /goal command with: $ARGUMENTS

Manage the session's autonomous goal using the available goal tools:
- To view the current goal: call get_goal.
- To set or replace a goal: call create_goal with the objective and optional max_goal_rounds / token_budget.
- To pause, resume, mark complete, or mark blocked: call update_goal with the matching action.
- To wait on an external event: call goal_wait.
If the arguments look like a goal objective, set it with create_goal and report the result.
```

## Usage

```
/goal                                   show the current goal
/goal <objective>                       start goal mode (autonomous continuation)
/goal --tokens 100k <objective>         start with a token budget
/goal --rounds 10 <objective>           start with a round cap
/goal edit <objective>                  update the objective without resetting counters
/goal pause                             stop autonomous continuation, keep the goal
/goal resume                            re-arm a paused/blocked goal
/goal clear                             remove the goal (durable tombstone)
```

While a goal is active, the model can use four tools:

| Tool | Purpose |
|---|---|
| `get_goal` | Read the current goal (id/revision, phase, rounds, usage) |
| `create_goal` | Create a goal with optional round cap / token budget |
| `update_goal` | `complete` / `blocked` / `pause` / `resume` / `edit` — CAS-validated |
| `goal_wait` | Wait for an external event; suppresses continuation until the deadline |

## Architecture

```
session.idle ──► GoalDriver ──► guardrails ──► session.prompt (synthetic continuation)
                     │              │
                     ▼              ▼
                GoalStore    round cap · token budget · no-progress · wait
                     │
                     ▼
        .opencode/goal-log.jsonl   (append-only event log, DSH-style)
```

- **Event sourcing**: every mutation (`create` / `edit` / `pause` / `resume` /
  `complete` / `block` / `continue` / `wait` / `clear`) appends a full-snapshot
  `goal/change` event to `<project>/.opencode/goal-log.jsonl`. The current state
  is a last-wins fold; `clear` writes a tombstone and history is never deleted.
- **CAS refs**: tools must pass the exact `goal_id` + `revision`; stale refs are
  rejected (`GOAL_STALE_REVISION`), preventing delayed turns from mutating a
  newer goal instance.
- **Orthogonal state**: durable `phase` (`active` / `paused` / `blocked` /
  `complete`) is separate from process-local `activation` (`armed` / `disarmed`).
  After a reload the goal is `disarmed` — the DSH posture: a human must resume.
- **Continuation**: on `session.idle`, if the goal is `active` + `armed`, one
  guarded round is admitted (CAS) and a synthetic continuation prompt is injected.
  Provider errors disarm instead of looping.

## Guardrails

| Guardrail | Default | Behavior |
|---|---|---|
| Round cap | 25 | reaching it blocks the goal (`round-limit`) |
| Token budget | unlimited | `--tokens N`; blocks at `budget-limited` |
| No-progress | 3 rounds | three consecutive empty/identical outputs block (`no-progress`) |
| External wait | — | `goal_wait` suppresses continuation until the deadline |
| Stale-turn | — | CAS refs rotate on every mutation |

## Development

```bash
bun install
bun run typecheck   # tsc --noEmit
bun test            # 22 unit/integration tests
bun run build       # bundles dist/index.js (single file, deps included)
```

## License

MIT