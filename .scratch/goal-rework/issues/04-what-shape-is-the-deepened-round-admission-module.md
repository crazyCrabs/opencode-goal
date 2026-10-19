# What shape is the deepened round-admission module

Type: grilling
Status: resolved
Blocked by: 01

## Question

What is the shape of the module that admits a goal round?

DeepSeek Harness's round driver is the reference: it queues the round prompt only
when the agent is fully idle, the goal is `active` **and** armed, and capacity
remains; it then reserves `roundsStarted + 1`, awaits a durability checkpoint,
re-checks revision and competing input *after* the await, and uses pre-step race
fences to reject stale, cancelled or competing prompts. One goal per session.

`src/driver.ts` currently splits that admission policy across two entry points
that already disagree: `drive()` clears an expired wait deadline, the TUI's
`kickRound()` returns without clearing it, and the two render the round number
from different sources. `src/tui.tsx` imports `goalBlockReason` and
`renderGoalRoundPrompt` from `src/driver.ts`, so the human command plane depends
on the autonomous half.

**The admission trigger is now known.** [Record the real opencode v2 event stream during one goal run](./01-record-the-real-opencode-v2-event-stream-during-one-goal-run.md)
settled that `session.execution.succeeded|failed` is the only turn-completion signal, and
that it carries no `location` — so admission must be reached through the directory
fallback, and the module's interface has to accept a directory it did not derive from the
event that woke it.

Decide the module's interface, and decide what sits behind the seam. Use
`/codebase-design` — apply the deletion test, and check whether two adapters
justify the seam.

**One question prior art answers that the references do not.**
[What did the earlier opencode goal plugins get right and wrong](./02-what-did-the-earlier-opencode-goal-plugins-get-right-and-wrong.md) reports
that `prevalentWare` **defers continuation while sibling tasks are active**
(`defer_while_tasks_active`, `max_task_block_seconds: 900`). This plugin instead filters
subagent sessions out entirely via a `childSessions` set. Decide whether deferral or
exclusion is right — an excluded subagent never gets a round, a deferred one waits its turn,
and DSH says nothing about either case.

## Answer

Settled by a Jev pass over the Round 1 frontier, at the human's instruction that
these decisions take Jev's verdict. Five verdicts at confidence >= 0.80;
verdicts and probabilities in
[`jev-04-verdicts.md`](../../../../AppData/Local/Temp/opencode-goal-rework/jev-04-verdicts.md).

### The seam covers the admission decision only

The module answers one question: **may this round be admitted, and if so commit
it.** Nothing else.

| Inside the module | Left at the adapter |
| --- | --- |
| Guardrails (no-progress, round cap, token budget) | Event-shape normalisation and directory resolution |
| Compare-and-set admission of the round | Per-session in-flight tracking |
| External-wait deadline expiry | Usage accounting (ticket 11) |
| Block-on-guardrail-breach, tolerating a lost race | Prompt submission (different API on each side) |
| Rendering the admitted round's prompt | Toasts, logging, disarm-on-submit-error |

The decisive fact is that **the TUI is a separate process**. It constructs its own
`GoalStore` and submits through `context.client.session.prompt`; it shares no
runtime object with `GoalDriver`, only the append-only log on disk. So the
in-flight and running maps cannot be shared even if both callers imported the
same module — putting them inside would grow the interface and buy nothing.
`b-whole-loop` also fails `tui_crosses_seam`: the TUI cannot cross a loop
module, so the seam would stay hypothetical.

Deletion test: delete this module and the five shared steps reappear at two call
sites — it earns its keep. `c-three-modules` (0.000) and `d-no-new-module`
(0.000) both fail it.

### Interface shape (to be finalised in Round 2)

```ts
// Everything a caller must know to admit one round.
function admitRound(store: GoalStore, cause: AdmissionCause): AdmissionVerdict

type AdmissionVerdict =
  | { kind: 'admitted'; round: number }
  | { kind: 'blocked'; reason: GoalBlockReason }
  | { kind: 'rejected'; why: 'not-active' | 'disarmed' | 'stale-ref' | 'waiting' }
```

Two deliberate consequences:

- **The module takes an already-resolved store, not a session.** The caller has
  resolved the directory (from the `session.created` payload, else `session.get`)
  before calling. This is ticket 01's consequence: `session.execution.*` carries
  no `location`, so the directory reaches admission by a route the module did
  not derive.
- **The prompt leaves `src/driver.ts` with the policy.** Otherwise the TUI keeps
  importing the server half just to render a prompt. Whether it lands inside the
  admission module or in a module of its own is Round 2's question.

### Subagent sessions are excluded, at the adapter

`session.created` payloads carrying a `parentID` are recorded and every later
location-less event for them is dropped. The admission module never learns that a
subagent exists — so its interface carries no `parentID`, and it is testable
without the v2 session domain at all.

Deferral (`defer_while_tasks_active`) is the wrong tool here: the question is
whether a *session* gets a goal round, not whether the goal waits on unrelated
background work, and a parent turn's completion already contains its subagent
tool calls, so there is no overlap to wait for. An excluded subagent never sees a
goal prompt injected into its narrow context; a deferred one would, on a turn
that belongs to the parent agent's own tool work.

### Both entry points cross one seam

The server driver and the TUI command plane call the same `admitRound`. That is
what makes the seam real rather than hypothetical, and it is what fixes the two
drifts by construction:

- `drive()` clears an expired wait; `kickRound()` does not — one policy fixes it.
- `drive()` catches a lost CAS race; `kickRound()` does not, and
  `runGoalCommand` does not either — one policy fixes it.
- The round number's provenance (`roundsStarted + 1` before admitting versus
  `admitted.roundsStarted` after) collapses to one.
- One-round-at-a-time is asked of the UI in the TUI and answered from
  `roundsInFlight` in the driver. These are two mechanisms for one invariant.
  They stay separate — see below.

### What stays separate, and why

The one-round-at-a-time invariant is deliberately **not** unified. The server
knows from its event stream whether a round is in flight; the TUI can only ask
the UI whether a turn is active. Forcing one mechanism would push a v2 session
concept into the TUI or a UI probe into the server. The invariant is enforced in
both places by different means, and that is the correct answer rather than a gap.

### The two drifts get one carry ticket

Recorded here, not silently folded away: this effort is planning-only, and the
code lands in a later implementation effort. One carry ticket, not two — they
share one root cause and splitting tickets would cut one decision into two.

Opened as
[Fix the two admission drifts the shared seam removes](./12-fix-the-two-admission-drifts-the-shared-seam-removes.md).

### Still open, for Round 2

- Whether `admitRound` needs `cause` at all. If both adapters run identical
  policy, the parameter is dead weight and the interface gets smaller. The
  difference today is only in reporting, which is the caller's job.
- Where the round prompt's rendering lives.
- Whether `admitRound` returning `rejected` is enough, or whether it must say
  *why* it refused in a way the TUI can turn into a toast.

### Round 2 — the interface is finalised

Jev over the three follow-ups Round 1 unblocked. All at or above the floor;
verdicts and probabilities in
[`jev-04-r2-verdicts.md`](../../../../AppData/Local/Temp/opencode-goal-rework/jev-04-r2-verdicts.md).

| Question | Verdict |
| --- | --- |
| Does `cause` survive on the interface? | **No** (0.38) |
| Where does prompt rendering live? | **Its own module** (0.900, confidence 0.84) |
| Does the verdict carry codes or messages? | **Codes** (0.34) |

`cause` drops out: both adapters run one policy, so the parameter encodes
nothing, and any future divergence belongs in the verdict rather than in a
flag naming the caller. The resulting interface is the smallest one the tree
produced.

```ts
// Everything a caller must know to admit one round.
function admitRound(store: GoalStore): AdmissionVerdict

type AdmissionVerdict =
  | { kind: 'admitted'; round: number }
  | { kind: 'blocked'; reason: GoalBlockReason }
  | { kind: 'rejected'; code: 'not-active' | 'disarmed' | 'stale-ref' | 'waiting' }
```

The prompt moves to a module of its own, imported by both adapters. The TUI
therefore never imports the server half at all — today it imports
`src/driver.ts` for two pure functions, and after this it imports nothing from
it. Ticket 08 churns a prompt module that admission never depends on.
