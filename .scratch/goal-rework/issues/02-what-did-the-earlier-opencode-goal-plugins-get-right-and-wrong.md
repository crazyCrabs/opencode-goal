# What did the earlier opencode goal plugins get right and wrong

Type: research
Status: resolved
Blocked by: —

## Question

At least two opencode goal plugins predate this one and are named in its
credits: `prevalentWare/opencode-goal-plugin` and `willytop8/OpenCode-goal-plugin`,
alongside a mention of "Codex's native goal-mode semantics".

What did they get right, what did they get wrong, and what does this repo's
README currently credit them for? This is a free road map of decisions already
made — and possibly unmade — in this exact target.

Report, with URLs: their architecture, their model-facing tool surface, their
continuation mechanism, their guardrails, their known issues or abandoned
approaches, and anything they report about opencode v1 versus v2 behaviour.

## Answer

Both repos exist and are substantial. Neither README carries the DSH/pi-goal
attribution line this repo's own README claims — `prevalentWare` credits only
Codex plus "William Ricchiuti's `willytop8/OpenCode-goal-plugin`". The `willytop8`
account has since renamed to `william-ricchiuti`.

**`prevalentWare/opencode-goal-plugin`** (TS, 404★, npm `@prevalentware/opencode-goal-plugin`)
- State: one flat JSON at `$XDG_DATA_HOME/opencode-goal-plugin/goals.json`, **no event log**,
  multi-goal per session with 20-entry history and 5 checkpoints embedded. Atomic write via
  same-dir temp + rename + fsync, owner-only perms, `O_EXCL` UUID temp name. Torn/whitespace/
  BOM/NUL content is quarantined to `goals.json.corrupt-<ts>-<uuid>` rather than clobbered.
- Continue decision: `session.idle` / `session.status{idle}`; **on v2 also**
  `session.execution.succeeded` alongside `.started/.failed/.interrupted`,
  `session.retry.scheduled`, `session.created`, `session.deleted`.
- 9 tools, all session-scoped, **no id or ref echo**. `create_goal` is idempotent.
- Defaults: `max_auto_turns 25`, `max_no_progress_turns 2`, `no_progress_token_threshold 50`,
  `max_prompt_failures 3`, `max_task_block_seconds 900`. Statuses
  `active/paused/complete/unmet/budgetLimited/usageLimited`.
- **Has an executable v2 smoke test**: `scripts/smoke-v2-lifecycle.ts` runs a real `opencode2`
  against a deterministic local model. Pins the v2 dev contract to
  `@opencode/{plugin,schema,client} 0.0.0-beta-19425` and notes the compaction hook only exists
  on newer betas.
- Open issue [#54](https://github.com/prevalentWare/opencode-goal-plugin/issues/54): on opencode
  1.18.25 nothing registers at all — no `/goal`, no `*_goal` tools, silent load. Root cause
  disputed by the maintainer. Still open.

**`william-ricchiuti/OpenCode-goal-plugin`** (JS, 262★, npm `opencode-goal-plugin` v0.10.0)
- State: project-local sharded JSON at `<cwd>/.opencode/goals/state.json`, sharded per session
  under `<stateFilePath>.sessions/<sha256(sessionID)>/`, plus an append-only ledger with 2 MiB
  rotation. **Fail-closed**: terminal events are written to the ledger *before* the state write,
  so a terminal outcome survives a failed state write; corrupt state reconstructs non-completed
  goals from the ledger and loads them **paused**.
- Continue decision: `session.idle` / `session.status{idle}`, plus `session.error`,
  `message.updated`, `permission.replied` (reject→pause), `session.compacted`, `session.updated`,
  `session.deleted`.
- 11 tools, session-scoped, **no id echo**. `goal_complete` takes a structured claim:
  `{summary, criteria: [{criterion, evidence[]}], checks: [{command?, result: passed|failed|not-run,
  exitCode?, explanation?}], changedFiles?, knownLimitations?}`.
- Defaults: `maxTurns 10`, `maxDurationMs 900000`, `maxTokens 200000`, `budgetWrapupRatio 0.8`,
  plus **two separate stall counters** — `noProgressTurnsBeforePause 2` and a distinct
  `noToolCallTurnsBeforePause 2`.
- **v1 only.** `engines.opencode: ">=1.17.15 <2"`; `docs/compatibility.md` states OpenCode 2 is
  not supported and not yet tested, with a five-point list of what a v2 claim would require.

**Consequence for this map — three premises changed:**

1. **The dual trigger is not a mistake.** `prevalentWare`, the only prior art that supports both
   generations, runs `session.idle` **and** `session.execution.succeeded` in parallel on v2. This
   repo's most recent refactor built the same hedge on the premise that it was required. Prior
   art corroborates the design; it does not corroborate the stated reason.
2. **The compare-and-set ref in the model interface is the outlier.** Both prior plugins went
   session-scoped with no ref echo, years of maintenance apart. Hiding the ref is not
   assimilation — it is where this target converged.
3. **A v2 smoke harness already exists to copy.** Ticket 01's recording does not need inventing;
   it needs adapting from `prevalentWare`'s.

**Reuse:** the fail-closed ledger ordering and paused-on-recovery; the corrupt-state quarantine;
per-session sharded state with a single-writer lease and passive degradation; the separate
no-tool-call stall counter; the structured `goal_complete` claim schema; deferring continuation
while sibling tasks are active.

**Avoid:** marker-in-prose completion (`[goal:complete]` honored only when adjacent to
`[goal:evidence]`); relying on `experimental.chat.system.transform` for correctness, which
1.17.15 and 1.18.10 never call; `config`-hook command injection as the only registration path
(open issue #54); unpinned plugin entries, which opencode resolves once and never re-resolves;
and claiming v2 support in prose rather than behind an executable test.
