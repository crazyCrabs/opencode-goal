# opencode-goal

Persistent autonomous goals for [opencode](https://opencode.ai) (v2 plugin API).

Built from the combined design philosophies of two goal systems:

- **DSH goal architecture** (DeepSeek Harness): event-sourced append-only state
  log, orthogonal durable-phase / process-activation, strict round budgets.
- **pi-goal guardrails** (`@narumitw/pi-goal`): token budgets, no-progress
  detection, external waits, stale-turn guards, autonomous continuation from the
  turn boundary.

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

## Hooks

`.githooks/pre-commit` is versioned, but git will not use it until the path is
pointed at it, once per clone:

```
git config core.hooksPath .githooks
```

It typechecks only. `bun run check` runs typecheck and the suite, and is what CI
runs.

## Usage

```
/goal                                   show the current goal
/goal <objective>                       start goal mode (autonomous continuation)
/goal --tokens 100k <objective>         start with a token budget
/goal --rounds 10 <objective>           start with a round cap
/goal edit <objective>                  update the objective without resetting counters
/goal pause                             stop autonomous continuation, keep the goal
/goal resume                            re-arm a paused/blocked goal and start its next round now
/goal clear                             remove the goal (durable tombstone)
```

A bare `/goal` with no goal set opens a prompt for the objective. The same
actions are available in the command palette (`Goal: …` group) and in the
sidebar row, which shows the phase, objective, round/budget progress, and — when
the goal has stopped — *why*, in the block code and its message.

**A goal belongs to a session, not to a directory.** Two sessions in one project
hold two goals: a session opened later inherits nothing, and a turn finishing in
one session says nothing about another's goal. The scope is the conversation,
because that is where the human's intent lives.

A goal only runs inside an opencode **session** — it is not a background daemon.
The session the goal works in is remembered durably, so a restart, a closed
tab, or `opencode run --standalone` all find it again. What starts a round:

1. The first round right after `/goal create|edit|resume`. Created from the home
   route (no session open), the goal makes a session, navigates to it, and runs
   the round there.
2. Every further round after *that session's* turn finishes, driven by the
   server half.
3. A human turn in the goal's own session, which is the go-ahead for a goal that
   predates the process or was interrupted.

`/goal resume` matters for goals a human deliberately stopped — `pause`, a
`blocked` goal, one sitting in `goal_wait` until its deadline — and for a goal
whose room is gone, which is replaced by a session created carrying the model the
old one ran on.

While a goal is active, the model can use four tools:

| Tool | Purpose |
|---|---|
| `get_goal` | Read the current goal: objective, phase, rounds, round limit, token budget, usage, and whether a continuation is armed |
| `create_goal` | Create a goal with optional round cap / token budget |
| `update_goal` | `complete` / `blocked` / `pause` / `resume` / `edit` |
| `goal_wait` | Wait for an external event; suppresses continuation until the deadline |

**The model never quotes a ref.** `update_goal` resolves which goal it is working
on itself, so a typo cannot be rejected and a delayed turn cannot silently
overwrite a newer goal instance. `get_goal` still reports the id and revision,
because a human reading the log wants them. Completing a goal requires a
structured claim — what was achieved, per criterion, with the evidence — and
that claim is cross-checked against the commands that actually ran, so a claimed
exit code nothing executed shows up as a disagreement rather than as success.

All four tools are registered with `options: { codemode: false }`, which opts them
out of opencode 2.x Code Mode: without it a plugin tool only lands in the Code
Mode catalog and must be invoked through the synthetic `execute` tool, so a model
that calls `get_goal` by name gets *"No tool named get_goal is currently
available"*. These tools are the plugin's whole model-facing contract and the
system prompt names them directly, so they are first-class tools.

## Architecture

Two plugin halves share one durable log:

```
TUI half (tui.js)                              Server half (index.js)

/goal --> parse --> GoalStore --> toast / dialog / sidebar
                        |                            |
                        |                            +--> goal tools (get / create / update / wait)
                        |                            +--> GoalDriver on session.created (adopt)
                        |                            |           + session.execution.* (continue)
                        v                                 |
              .opencode/goal-log.jsonl <------------------+   (re-folded on every read)
```

- **Command plane (DSH `command-goal` posture)**: `/goal` executes in the UI and
  its output stays in the UI. No prompt parts are injected, so goal control never
  costs a model turn. After a create/edit/resume the command plane also admits
  and submits the first working round, because a locally executed slash command
  produces no turn-completion event that would otherwise wake the driver.
- **Keymap layers are render-tree hooks**: `context.keymap.layer` is
  `Keymap.createLayer`, which reads `Keymap.Provider` off the Solid context chain.
  Plugin setup is activated from a promise continuation, outside that chain, so
  the layer is claimed from a `ui.slot({ append: 'app' })` render — the same
  posture as the built-in plugins. Claiming it from setup throws
  `Keymap.Provider is missing`; the layer is disposed when that slot unmounts.
- **Continuation**: opencode 2.x reports a finished turn through
  `session.execution.succeeded|failed|interrupted` and never publishes
  `session.idle` for one, so those execution events are the driver's completion
  signal: the turn is accounted (usage + round output) and, if the goal is
  `active` + `armed` **and the turn is the goal's own**, one guarded round is
  admitted and a synthetic continuation prompt is submitted. `session.idle` is
  still honored as a legacy trigger while no round is in flight. A turn the human
  interrupted (`reason: "user"`) is accounted but not continued.
- **One round at a time per session**: a round is in flight from admission until
  its turn's completion event. opencode coalesces a prompt submitted mid-turn
  instead of running it, so a second admission meanwhile would spend budget on a
  prompt that never executes — the in-flight guard drops those triggers.
- **Event sourcing**: every mutation (`create` / `edit` / `pause` / `resume` /
  `complete` / `block` / `continue` / `wait` / `clear`) appends a `goal/change`
  line to `<project>/.opencode/goal-log.jsonl`. Two more line kinds carry
  *coordinates* — where the goal is rather than what happened to it: a
  `goal/lease` naming the process holding the current round, and a
  `goal/session` naming the room and the model it resolved to. A coordinate
  never moves the revision, never counts as a round, a block or usage, and is
  dropped by a `clear` along with the goal. The current state is a last-wins
  fold; `clear` writes a tombstone and history is never deleted.
- **Durable usage is a delta**: a `usage` operation appends the tokens a step
  spent at the moment they are folded, rather than riding the next mutation's
  snapshot. A snapshot arriving later cannot undo it, and it does not bump the
  revision — so a fold that changed only usage is not a state change and cannot
  re-arm or disarm a store.
- **A round lease, not mutual exclusion**: admission claims the round by writing
  a lease with an expiry, renewed while the round runs. A second process folds
  it and defers. A dead holder releases by doing nothing — expiry is read at
  call time — so the whole crash story needs no liveness protocol. This closes
  the double-driving *loop*; two processes can still both pass the check before
  either writes, so one extra round is possible and the log shows it.
- **Orthogonal state**: durable `phase` (`active` / `paused` / `blocked` /
  `complete`) is separate from process-local `activation` (`armed` / `disarmed`).
  A store arms a goal newer than the ref it was born with, so a goal created or
  resumed while the process is alive continues here — including a goal created
  from the TUI. A goal that only survived a restart is armed by the next
  `session.created` instead, so it needs no manual resume; it only stays quiet
  for phases a human chose to stop (`paused`, `blocked`, waiting).
- **Session adoption**: `session.created` in the goal's own session is the
  go-ahead. The driver arms the goal, runs the block gate, and admits the next
  round into that session. A session opened later inherits nothing, and a goal
  whose room is gone waits rather than driving whichever session the human
  happens to open next.
- **Project ownership**: a server loads this plugin once per location, and every
  instance sees every project's events, so each event is attributed to its
  session's directory (from `session.created`, else `session.get`) and driven
  only when that directory belongs to this instance's root. Subagent sessions
  (they carry a `parentID`) and deleted sessions are never driven.
- **The model opencode is already using**: a plugin-created session carries no
  model, so it falls back to the server default — which for an account without
  an OpenCode Go subscription is a 403. The goal therefore resolves the model
  through the layer that can answer: the session open on the router, then every
  session carrying a model in this project, newest first, then the same fact
  over HTTP, then the model remembered on the goal itself.

## Guardrails

Two tiers, because they answer different questions. An **arithmetic** code is a
fact that has already happened, so it stops the goal on the first breach. A
**judgment** code is a claim about the model's behaviour, so it is *challenged*:
the goal keeps running until the same condition persists three consecutive
rounds, and an impasse that clears resets the count.

| Code | Tier | Default | Behavior |
|---|---|---|---|
| `round-limit` | arithmetic | 25 rounds | reaching the cap blocks the goal |
| `budget-limited` | arithmetic | unlimited | `--tokens N`; blocks when usage reaches it |
| `usage-limited` | arithmetic | — | the provider refused the request: 401/402/403/408/429 |
| `provider-unavailable` | arithmetic | 3 failures | the connection never opened; a DNS or socket failure is not a refusal |
| `wait-expired` | arithmetic | — | a `goal_wait` deadline passed with no human arriving |
| `model-reported` | judgment | — | the model's own claim that it is stuck |
| `no-progress` | judgment | 3 rounds | three consecutive empty or identical outputs |
| `no-tool-call` | judgment | 2 turns | consecutive turns that talked without calling a tool |

The distinction the tiers encode: a dead network and an exhausted subscription
need different human action, so a stop names which one it is. And a turn that
never reached the provider says nothing about whether the model is acting, so it
does not feed the stall counter.

## Development

```bash
bun install
bun run typecheck   # tsc --noEmit
bun run check       # typecheck + the suite (283 tests)
bun run build       # bundles dist/index.js (server) and dist/tui.js (TUI)
```

[`AGENTS.md`](AGENTS.md) is the entry point for anything non-obvious: the domain
vocabulary in [`CONTEXT.md`](CONTEXT.md), the decisions in
[`docs/adr/`](docs/adr/README.md), the checklist for adding a goal-log line kind
in [`docs/goal-log-protocol.md`](docs/goal-log-protocol.md), and the tracker for
the current work in [`.scratch/goal-rework/`](.scratch/goal-rework/map.md).

## License

MIT
