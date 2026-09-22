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

The plugin ships as two bundles because opencode loads server plugins and TUI
plugins through separate paths. Both are needed: the server half owns the goal
state, tools, and continuation driver; the TUI half owns the `/goal` command.

Drop the bundled files into a plugin directory in your global config (or your
project's `.opencode/plugins/`):

```
~/.config/opencode/plugins/opencode-goal/index.js # dist/index.js — server half
~/.config/opencode/plugins/opencode-goal/tui.js   # dist/tui.js    — TUI half
```

A plugin directory is auto-discovered: the server half resolves to `index` and
the TUI half to `tui`, so no `tui.json` registration is needed.

The TUI bundle keeps `solid-js` and `@opentui/*` external, so those packages
must resolve from the config directory (opencode installs them itself; verify
with `ls ~/.config/opencode/node_modules/solid-js`).

Or as an npm package (once published) for the server half:

```json
{ "plugin": ["opencode-goal"] }
```

The `/goal` slash command is registered by the TUI plugin itself: it parses the
input, executes it against the goal log, and shows the result as a toast or
dialog. No command file and no model turn is involved.

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

A bare `/goal` with no goal set opens a prompt for the objective. The same
actions are available in the command palette (`Goal: …` group) and in the
sidebar row, which shows the phase, objective, and round/budget progress.

While a goal is active, the model can use four tools:

| Tool | Purpose |
|---|---|
| `get_goal` | Read the current goal (id/revision, phase, rounds, usage) |
| `create_goal` | Create a goal with optional round cap / token budget |
| `update_goal` | `complete` / `blocked` / `pause` / `resume` / `edit` — CAS-validated |
| `goal_wait` | Wait for an external event; suppresses continuation until the deadline |

## Architecture

Two plugin halves share one durable log:

```
TUI half (tui.js)                              Server half (index.js)

/goal --> parse --> GoalStore --> toast / dialog / sidebar
                        |                            |
                        |                            +--> goal tools (get / create / update / wait)
                        |                            +--> GoalDriver on session.idle
                        v                                 |
              .opencode/goal-log.jsonl <------------------+   (re-folded on every read)
```

- **Command plane (DSH `command-goal` posture)**: `/goal` executes in the UI and
  its output stays in the UI. No prompt parts are injected, so goal control never
  costs a model turn. After a create/edit/resume the command plane also admits
  and submits the first working round, because a locally executed slash command
  produces no `session.idle` that would otherwise wake the driver.
- **Keymap layers are render-tree hooks**: `context.keymap.layer` is
  `Keymap.createLayer`, which reads `Keymap.Provider` off the Solid context chain.
  Plugin setup is activated from a promise continuation, outside that chain, so
  the layer is claimed from a `ui.slot({ append: 'app' })` render — the same
  posture as the built-in plugins. Claiming it from setup throws
  `Keymap.Provider is missing`; the layer is disposed when that slot unmounts.
- **Continuation**: on `session.idle`, if the goal is `active` + `armed`, one
  guarded round is admitted (CAS) and a synthetic continuation prompt is injected.
  Provider errors disarm instead of looping.
- **Event sourcing**: every mutation (`create` / `edit` / `pause` / `resume` /
  `complete` / `block` / `continue` / `wait` / `clear`) appends a full-snapshot
  `goal/change` event to `<project>/.opencode/goal-log.jsonl`. The current state
  is a last-wins fold; `clear` writes a tombstone and history is never deleted.
- **CAS refs**: tools must pass the exact `goal_id` + `revision`; stale refs are
  rejected (`GOAL_STALE_REVISION`), preventing delayed turns from mutating a
  newer goal instance.
- **Orthogonal state**: durable `phase` (`active` / `paused` / `blocked` /
  `complete`) is separate from process-local `activation` (`armed` / `disarmed`).
  A store arms a goal newer than the ref it was born with, so a goal created or
  resumed while the process is alive continues here — including a goal created
  from the TUI — while a goal that only survived a restart stays quiet until a
  human resumes it (the DSH posture).

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
bun test            # 57 unit/integration tests
bun run build       # bundles dist/index.js (server) and dist/tui.js (TUI)
```

## License

MIT