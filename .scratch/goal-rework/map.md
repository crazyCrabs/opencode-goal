# Map: goal-rework

Wayfinder map for reworking the `opencode-goal` plugin's goal experience.

Issues: [`issues/`](./issues) · Decisions live in their ticket, never here.

## Destination

A specification for reworking the continuation loop of `opencode-goal` — round admission, guardrails, and the events that drive them — so that it matches the goal experience of Codex CLI and DeepSeek Harness, and sits correctly on opencode v2's event semantics.

Accepted by a recorded scenario: a real opencode v2 server runs `/goal <objective>` to a natural stop, with every round's prompt, tool call, and event captured.

**Written.** [`SPEC.md`](./SPEC.md) — 62 numbered decisions, drafted from the 9 resolved grilling tickets and the 4 live recordings, and now implemented. The acceptance run has happened and passes (ticket 23); what is left is the human's confirmation of the pass mark (ticket 10) and the TUI observation (ticket 09).

## Notes

**Domain.** Goal vocabulary lives in [`CONTEXT.md`](../../CONTEXT.md): goal, goal round, phase, activation, block reason, guardrail, continuation, command plane, goal log, compare-and-set ref. Use it exactly; do not invent synonyms.

**Skills every session should consult.**

- `/grilling` and `/domain-modeling` — every grilling ticket runs both
- `/codebase-design` — the deep-module vocabulary (module, interface, depth, seam, adapter, leverage, locality) and the deletion test
- `/tdd` — for any test that lands on a deepened interface

**Acceptance harness seed.** `assets/event-spy.plugin.js` is the read-only spy that produced
ticket 01's recordings. It is the starting point for the recorded scenario this effort's spec
is accepted by — extend it, do not rebuild it.

**How the destination was settled.** A Jev (TypeSafe System One) pass over the
whole decision set, plus a grilling round. See
[`decisions-from-charting.md`](./decisions-from-charting.md) — the payload, the
verdicts, and the escalated calls. Cite it when a ticket reopens a question it
already answered.

**Standing parameters — settled at charting, binding on every ticket.**

| Parameter | Value |
| --- | --- |
| Planning mode | Planning only. Produce decisions and the spec, not code. |
| Primary target surface | The continuation loop, *not* the model-facing tool contract and *not* the TUI command plane |
| Compare-and-set ref | Hides inside the server. The model stops echoing it. |
| Model-owned lifecycle | Unchanged in this effort — the model still calls `pause`/`resume`/`wait`. Reworking that is the Codex answer and belongs to a different effort |
| Reference authority | Constraint, with every intentional deviation recorded as an ADR |
| Verify before designing | Yes. Record the real event stream before deciding the trigger layer |
| Definition of done | The recorded scenario, run before and after |
| Lock level | Moderate — destination and the model-facing surface first, then start |
| Block gate | Judgment blocks (model-reported `blocked`, `no-progress`) are rejected until the same condition persists 3 consecutive rounds; arithmetic stops (`round-limit`, `budget-limited`, `usage-limited`) stop immediately. Settled by ticket 06. |
| What ends an external wait | The deadline, or a user item arriving at `session.inbox.enqueued` — not the next goal turn, and not turn completion. Settled by ticket 07, which also requires a deadline on every wait. |
| What survives regardless | The append-only goal log and the phase/activation split. Event *semantics* may change; the log's shape does not |

**Settled facts about opencode v2.** All three contested claims are now settled by
recording against a real server. See
[Record the real opencode v2 event stream during one goal run](./issues/01-record-the-real-opencode-v2-event-stream-during-one-goal-run.md):

1. `session.idle` does **not** fire when a prompt turn ends. The plugin's source comment
   was right; the documentation-based reading was wrong.
2. `session.execution.*` **and** `session.usage.updated` carry no `location` on the
   envelope. The plugin's directory attribution is load-bearing, not redundant.
3. `ctx.session.get` returns no top-level `directory` — only `location.directory`. The
   plugin's cast has a dead first branch but works.

Do not re-litigate these. The recordings are in `assets/`, and the spy plugin that
produced them is the seed of the acceptance harness for this effort's spec.

**Authority of the references.** Three verified sources, ranked: DeepSeek Harness supplies
the durable architecture (event log, CAS, phase/activation split, the admission protocol);
pi-goal supplies the guardrail semantics and defaults; Codex CLI supplies the model-facing
minimum. Two opencode goal plugins that predate this one are a fourth source — less
principled, better travelled. Where the four disagree, say which one you are following and
record why as an ADR.

## Decisions so far

_One line per resolved ticket. The detail lives in the ticket; this is only the index._

- [What did the earlier opencode goal plugins get right and wrong](./issues/02-what-did-the-earlier-opencode-goal-plugins-get-right-and-wrong.md) — both prior plugins are session-scoped with no ref echo, so hiding the compare-and-set ref is where this target converged; prior art also runs a parallel `session.idle` + `session.execution.succeeded` pair, and ticket 01 later confirmed the reason behind it (`session.idle` really does not fire at turn end), so the dual trigger was correct rather than a hedge
- [Record the real opencode v2 event stream during one goal run](./issues/01-record-the-real-opencode-v2-event-stream-during-one-goal-run.md) — `session.idle` never fires at turn end; `session.execution.*` and `session.usage.updated` carry no `location`; `session.get` has no top-level `directory`; `session.usage.updated` and `session.tool.*` are native signals the plugin ignores
- [What shape is the deepened round-admission module](./issues/04-what-shape-is-the-deepened-round-admission-module.md) — the seam is the admission decision only, taken by both entry points; the TUI being a separate process is what puts the in-flight maps outside it, and what makes the whole-loop shape fail the two-adapter test
- [Which events drive continuation, and does directory attribution get deleted](./issues/03-which-events-drive-continuation-and-does-directory-attribution-get-deleted.md) — the location-less set is exactly four events wide, so the directory is learned from `session.step.started`'s `location` instead of `session.get`; `session.idle` stays, but gated on ticket 09
- [Should the status set gain usage_limited and budget_limited](./issues/05-should-the-status-set-gain-usage_limited-and-budget_limited.md) — the phase set stays DeepSeek Harness's four, and the provider-quota gap is closed with a durable `usage-limited` block code instead of a phase
- [Round semantics, human turns, the default cap, and whether token budget stays](./issues/06-round-semantics-human-turns-the-default-cap-and-whether-token-budget-stays.md) — cap stays 25, token budget stays, no-progress adopts "any tool call resets", the block gate is two-tiered, and a second no-tool-call stall counter is added
- [Does goal_wait stay, and can the arranged wake source be enforced](./issues/07-does-goal_wait-stay-and-can-the-arranged-wake-source-be-enforced.md) — it stays and becomes durable, a deadline becomes a required argument, the native `session.inbox.enqueued` event is the wake, and expiry blocks with a new `wait-expired` code instead of resuming
- [What the model's goal tools and continuation prompt say now that refs are hidden](./issues/08-what-the-models-goal-tools-and-continuation-prompt-say-now-that-refs-are-hidden.md) — `update_goal` takes an action and its payload with no ref to quote, the bundle stays at four, and a `complete` claim carries structured criteria plus the commands it ran with their exit codes
- [Does the native session.usage.updated replace the hand-rolled transcript fold](./issues/11-does-the-native-session-usage-updated-replace-the-hand-rolled-transcript-fold.md) — no: `session.usage.updated` is ephemeral, so usage folds from the durable `session.step.ended` and text from the durable `session.text.ended`, the transcript read dies, and accounting becomes its own module

## Not yet specified

In-scope fog — dim but not yet sharp enough to ticket. Each patch graduates when the frontier reaches it.

- **The durable store's interface once the compare-and-set ref moves inside.** Now depends on the admission module's interface, which [ticket 04](./issues/04-what-shape-is-the-deepened-round-admission-module.md) settled as one function taking an already-resolved store. Whether `usage_limited`/`budget_limited` become phases is still open (ticket 05).
- **How many model-facing goal tools remain.** Settled by [ticket 08](./issues/08-what-the-models-goal-tools-and-continuation-prompt-say-now-that-refs-are-hidden.md): the bundle stays at four, and only the arguments and descriptions change.
- **Whether the spec covers the TUI half at all beyond admitting the first round.** The command plane scored 0.00 as a target surface, but it still executes the first round.
- **Whether a wall-clock budget joins the guardrails.** Both references meter something besides tokens — Codex meters elapsed time, DSH deliberately meters nothing but rounds. Note [ticket 07](./issues/07-does-goal_wait-stay-and-can-the-arranged-wake-source-be-enforced.md) now requires every external wait to carry a deadline, which is a per-wait wall-clock bound but not a goal-level one.
- **What the model-facing `goal_wait` looks like with a required deadline.** [Ticket 07](./issues/07-does-goal_wait-stay-and-can-the-arranged-wake-source-be-enforced.md) settled that `resume_after_ms` becomes required; [ticket 08](./issues/08-what-the-models-goal-tools-and-continuation-prompt-say-now-that-refs-are-hidden.md) settled the bundle's shape. What is left is the wording of each description and the continuation prompt, which follows the spec rather than shaping it.
- **Whether the append-only log gains fail-closed ordering.** [What did the earlier opencode goal plugins get right and wrong](./issues/02-what-did-the-earlier-opencode-goal-plugins-get-right-and-wrong.md) found `william-ricchiuti` writing terminal events to a ledger *before* the state write, so a terminal outcome survives a failed write, and reconstructing recovered goals **paused**. Whether this goal log needs that hangs on the round-admission module and on the store's interface.
- **The test surface for the deepened modules.** Depends on which modules survive the rework. One part is already answered: prior art ships an executable v2 smoke test rather than README prose, and the spec's acceptance should be no weaker than that.

## Out of scope

Ruled beyond the destination. Closed, never graduates.

- **TUI command-plane UX polish** — toasts, palette entries, the sidebar row. Scored 0.00 as a target surface. Reopens only if the destination is redrawn.
- **The argument-declaration deduplication in `src/tools.ts`** — real friction, but an isolated refactor in a surface that is not the target. It falls out of the tool rework or it doesn't.
- **The goal store's read-surface slimming** (`src/state.ts` pass-through getters, raw setters onto hidden process-local state) — same reasoning. Revisit only if the store survives the rework unchanged.
- **npm packaging and the release process** — not a goal-experience question.
- **A README rewrite** — follows the spec; it does not shape it.

**The spec is broken into implementable slices.** [`issues/13`](./issues) through
[`issues/27`](./issues) are tracer-bullet tickets in dependency order, each with its
blocking edges. Tickets 13 through 22 are implemented; 24 through 27 were found by
the implementation and the live runs, and are implemented too. The spine is
13 → 14 → 15; 09 and 10 gated 22 and 23, and both are answered. Ticket 12 is closed
by 15.

**What is left before the spec is accepted.** Ticket 09 (the TUI observation) settles this spec's decision 10 and may add a decision about `session.created`; it is the one thing that needs a human at an interactive terminal, because `opencode mini requires a TTY stdout`. Ticket 10 supplies the pass mark the recorded scenario needs, and it has been supplied under the standing authorisation — the human's confirmation of that one line is the only outstanding input. Neither blocks the spec's body.
