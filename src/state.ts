/**
 * Event-sourced goal store (DSH-style): an append-only JSONL log of
 * `goal/change` events with a last-wins projection fold and compare-and-set
 * mutations. Activation is process-local and never persisted, but every read
 * path re-folds the log first so multiple writers — the server-side goal
 * tools/driver and the TUI `/goal` command plane — converge on one state.
 *
 * A store arms a goal that is newer than the ref it was born with, so a goal
 * created or resumed while this process is alive continues here, while a goal
 * that merely survived a restart stays quiet until an explicit resume.
 *
 * Log location: `<worktree>/.opencode/goal-log.jsonl` — per-project, durable
 * across reloads, and auditable like DSH's session event log.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, appendFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  EMPTY_USAGE,
  GoalError,
  type GoalActivation,
  type CompletionClaim,
  type GoalBlockCode,
  type GoalBlockReason,
  type GoalChangeMeta,
  type GoalClearChangeMeta,
  type GoalOperation,
  type GoalPhase,
  type GoalRef,
  type GoalSnapshot,
  validateCompletionClaim,
  type GoalSnapshotChangeMeta,
  type GoalUsage,
  type GoalView,
} from './types.ts'

const GOAL_CHANGE_VERSION = 1

/** Coerce a possibly-missing legacy `tokenBudget` field into the durable shape. */
function normalizeSnapshot(snapshot: GoalSnapshot): GoalSnapshot {
  const budget = snapshot.tokenBudget
  const normalized = typeof budget === 'number' && Number.isFinite(budget) && budget > 0 ? snapshot : { ...snapshot, tokenBudget: 0 }
  // A goal written before the tool-less stall threshold existed has no value for
  // it. Folding it as `undefined` would make `hasStalledWithoutTools()` compare
  // against nothing and silently never fire — the guard would read as configured
  // off for every older goal, with nothing saying so. Default it instead, the
  // same way the token budget is defaulted.
  const stall = normalized.maxTurnsWithoutToolCall
  if (typeof stall === 'number' && Number.isFinite(stall) && stall >= 0) return normalized
  return { ...normalized, maxTurnsWithoutToolCall: GoalStore.DEFAULT_MAX_TURNS_WITHOUT_TOOL_CALL }
}

/** Whether two folded snapshots describe the same durable goal identity. */
function sameGoal(a: GoalSnapshot | undefined, b: GoalSnapshot | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.id === b.id && a.revision === b.revision && a.phase === b.phase
}

/** Fold state rebuilt from the log. */
export interface GoalFoldState {
  /** Current goal snapshot, absent after a clear or before the first create. */
  readonly goal: GoalSnapshot | undefined
  /** Latest mutation ref, including a clear tombstone. */
  readonly lastRef: GoalRef | undefined
}

/** Pure last-wins fold over durable goal facts. */
export function foldGoalLog(lines: readonly string[]): GoalFoldState {
  let goal: GoalSnapshot | undefined
  let lastRef: GoalRef | undefined
  for (const line of lines) {
    if (line.trim().length === 0) continue
    let change: GoalChangeMeta
    try {
      change = JSON.parse(line) as GoalChangeMeta
    } catch {
      continue // tolerate a torn tail write
    }
    if (change.kind !== 'goal/change' || change.version !== GOAL_CHANGE_VERSION) continue
    if (change.operation === 'clear') {
      goal = undefined
      lastRef = change.cleared
    } else {
      goal = normalizeSnapshot(change.goal)
      lastRef = { id: change.goal.id, revision: change.goal.revision }
    }
  }
  return { goal, lastRef }
}

/** Per-session runtime state held only in this process. */
interface RuntimeState {
  activation: GoalActivation
  /**
   * Consecutive turns that ended with no tool call at all.
   *
   * Deliberately a separate counter from `recentOutputs`: the no-progress guard
   * catches a goal that says the same thing, and this catches a goal that keeps
   * saying different things while doing nothing. One counter cannot hold both,
   * and a goal whose text changes but whose hands stay still is exactly the
   * failure the second one exists for.
   */
  turnsWithoutToolCall: number
  /** Normalized assistant outputs of recent goal rounds (no-progress guard). */
  recentOutputs: string[]
  /**
   * Normalized impasse reasons the model reported in recent goal rounds, oldest
   * first. Mirrors `recentOutputs`: a different reason resets the run, so the
   * count is consecutive rounds with the *same* condition, not rounds with any
   * judgment block.
   */
  recentJudgments: string[]
  /**
   * Whether the model reported an impasse since the last round boundary. The
   * round boundary is admission, which both entry points cross, so the streak
   * cannot be reset by one of them and not the other.
   */
  judgmentThisRound: boolean
}

function emptyRuntime(): RuntimeState {
  return {
    activation: 'disarmed',
    turnsWithoutToolCall: 0,
    recentOutputs: [],
    recentJudgments: [],
    judgmentThisRound: false,
  }
}

/** Event-sourced goal store for one worktree. */
export class GoalStore {
  private readonly logPath: string
  private state: GoalFoldState
  private readonly runtime: RuntimeState
  private seq = 0
  /**
   * The goal ref this store was born with (undefined when the log held no
   * goal). A goal newer than that — a different id or a higher revision — was
   * mutated while this process was alive, so it continues here; a goal that
   * merely survived a restart keeps its durable phase but stays disarmed until
   * a human explicitly resumes it (the DSH posture).
   */
  private readonly bornWith: GoalRef | undefined

  constructor(worktree: string) {
    this.logPath = `${worktree}/.opencode/goal-log.jsonl`
    this.runtime = emptyRuntime()
    this.state = { goal: undefined, lastRef: undefined }
    if (existsSync(this.logPath)) {
      const lines = readFileSync(this.logPath, 'utf8').split('\n')
      this.state = foldGoalLog(lines)
      this.seq = lines.filter(l => l.trim().length > 0).length
    }
    const born = this.state.goal
    this.bornWith = born === undefined ? undefined : { id: born.id, revision: born.revision }
    this.applyActivation(born)
  }

  /**
   * Arm only a goal mutated after this store came alive. A create/edit/resume
   * from any writer — including the TUI `/goal` command plane — therefore arms
   * every live process, while an untouched goal from a previous run waits for
   * an explicit resume.
   */
  private applyActivation(goal: GoalSnapshot | undefined): void {
    const mutatedWhileAlive =
      goal !== undefined &&
      (this.bornWith === undefined || goal.id !== this.bornWith.id || goal.revision > this.bornWith.revision)
    this.runtime.activation = goal !== undefined && goal.phase === 'active' && mutatedWhileAlive ? 'armed' : 'disarmed'
  }

  /**
   * Re-fold the durable log and adopt mutations made by other writers (the TUI
   * `/goal` command plane writes the same file). The log is the only shared
   * source of truth, so every read path folds it before answering.
   *
   * Runtime state is preserved except where an external change makes it wrong:
   * a mutation newer than this store's birth arms it, any non-active phase
   * disarms it, and a new or cleared goal resets the process-local
   * wait/no-progress bookkeeping.
   */
  sync(): void {
    if (!existsSync(this.logPath)) {
      const previous = this.state.goal
      if (previous === undefined) return
      this.state = { goal: undefined, lastRef: this.state.lastRef }
      this.applyExternalChange(previous, undefined)
      return
    }
    let lines: string[]
    try {
      lines = readFileSync(this.logPath, 'utf8').split('\n')
    } catch {
      return // a concurrent append made the read fail; the next sync retries
    }
    const folded = foldGoalLog(lines)
    const previous = this.state.goal
    if (sameGoal(previous, folded.goal)) return
    this.state = folded
    this.applyExternalChange(previous, folded.goal)
  }

  /** Adopt an externally folded goal, preserving usage accounting. */
  private applyExternalChange(previous: GoalSnapshot | undefined, next: GoalSnapshot | undefined): void {
    if (next === undefined) {
      // external clear: drop every process-local trace of the goal
      this.runtime.activation = 'disarmed'
      this.runtime.recentOutputs.length = 0
      this.usageOverlay = undefined
      return
    }
    const replaced = previous === undefined || previous.id !== next.id
    if (replaced || next.phase !== previous?.phase) {
      this.runtime.recentOutputs.length = 0
    }
    if (replaced) this.usageOverlay = undefined
    this.applyActivation(next)
  }

  /** Current durable goal or undefined. */
  get current(): GoalSnapshot | undefined {
    return this.state.goal
  }

  /** Process-local continuation eligibility. */
  get activation(): GoalActivation {
    return this.runtime.activation
  }

  set activation(value: GoalActivation) {
    this.runtime.activation = value
  }

  /** Token budget (0 = unlimited). */
  get tokenBudget(): number {
    return this.view()?.tokenBudget ?? 0
  }

  /**
   * External-wait deadline (epoch ms; 0 = not waiting), read from the durable
   * snapshot so a fresh process sees the same wait. The setters are gone with
   * the field: a wait is now written only by `wait()` and cleared only by the
   * admission seam, which is the one policy both entry points cross.
   */
  get waitUntil(): number {
    return this.state.goal?.waitUntil ?? 0
  }

  get waitReason(): string | undefined {
    return this.state.goal?.waitReason
  }

  /** Current goal view including process-local state and live usage overlay. */
  view(): GoalView | undefined {
    this.sync()
    const goal = this.state.goal
    if (goal === undefined) return undefined
    return {
      ...goal,
      usage: this.effectiveUsage(goal),
      activation: this.runtime.activation,
      waitUntil: this.state.goal?.waitUntil ?? 0,
      waitReason: this.state.goal?.waitReason,
    }
  }

  /** Normalize assistant output for the no-progress guard. */
  static normalizeOutput(text: string): string {
    return text
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  /** Record one goal round's assistant output; returns true when 3 consecutive rounds repeated. */
  recordRoundOutput(output: string): boolean {
    const normalized = GoalStore.normalizeOutput(output)
    const recent = this.runtime.recentOutputs
    if (normalized.length === 0) {
      // empty output counts as a repeated empty output
      if (recent.length > 0 && recent[recent.length - 1] === '') {
        recent.push('')
      } else {
        recent.length = 0
        recent.push('')
      }
    } else if (recent.length > 0 && recent[recent.length - 1] === normalized) {
      recent.push(normalized)
    } else {
      recent.length = 0
      recent.push(normalized)
    }
    if (recent.length > 3) recent.splice(0, recent.length - 3)
    return recent.length >= 3
  }

  /** Whether three consecutive goal rounds produced empty or identical output. */
  hasRepeatedRounds(): boolean {
    return this.runtime.recentOutputs.length >= 3
  }

  /**
   * Record the model reporting an impasse, and return whether the same impasse
   * has now been reported for `rounds` consecutive rounds.
   *
   * A different reason resets the run rather than adding to it, so a model that
   * names a new obstacle each round never accumulates toward a block.
   */
  noteJudgment(reason: string, rounds = 3): boolean {
    const normalized = GoalStore.normalizeOutput(reason)
    const recent = this.runtime.recentJudgments
    if (recent.length > 0 && recent[recent.length - 1] === normalized) {
      recent.push(normalized)
    } else {
      recent.length = 0
      recent.push(normalized)
    }
    if (recent.length > rounds) recent.splice(0, recent.length - rounds)
    this.runtime.judgmentThisRound = true
    return recent.length >= rounds
  }

  /** How many consecutive rounds the model has now reported the same impasse. */
  judgmentRounds(): number {
    return this.runtime.recentJudgments.length
  }

  /**
   * Whether a judgment condition has persisted long enough to be accepted.
   *
   * The store answers rather than the caller because the answer is about the
   * goal's history, and only the store holds it. An unknown code is treated as
   * unpersisted: a condition nothing has observed has not persisted.
   */
  judgmentPersisted(code: GoalBlockCode, message: string, rounds = 3): boolean {
    // no-progress is already a three-round observation by the time it is raised,
    // so its fingerprint is the output fingerprint
    if (code === 'no-progress') return this.hasRepeatedRounds()
    if (code === 'model-reported') {
      const recent = this.runtime.recentJudgments
      if (recent.length === 0) return false
      return recent.length >= rounds && recent[recent.length - 1] === GoalStore.normalizeOutput(message)
    }
    // The tool-less stall is the same shape: the condition is "this turn had no
    // tool call", and it has persisted when the streak reaches its threshold.
    // The threshold is configurable, so where the tier's default is three
    // consecutive rounds, this condition's persistence requirement is whatever
    // the goal says — default 2, from the prior art.
    if (code === 'no-tool-call') return this.hasStalledWithoutTools()
    // an arithmetic code has no persistence question to answer
    return false
  }

  /**
   * Mark a round boundary: a round that ended without the model reporting an
   * impasse clears the streak, so the count is consecutive rounds rather than a
   * lifetime tally. Called from admission, which both entry points cross.
   */
  endJudgmentRound(): void {
    if (!this.runtime.judgmentThisRound) this.runtime.recentJudgments.length = 0
    this.runtime.judgmentThisRound = false
  }

  /**
   * Reset both stall counters (after a create, an edit, a resume, or work).
   *
   * They are reset together because they measure the same thing from two
   * directions: a goal that did something in a turn is neither repeating itself
   * nor idle. Keeping them separate here would let one survive a mutation the
   * other did not, and the two would then disagree about whether the goal was
   * moving.
   */
  resetStallCounters(): void {
    this.runtime.recentOutputs.length = 0
    this.runtime.turnsWithoutToolCall = 0
  }

  /**
   * Note that the goal made a tool call in the round being accounted: the goal
   * is acting, so the no-progress fingerprint resets.
   *
   * A model that repeats its phrasing while it works is not stalled. Three
   * identical sentences of narration between two `write` calls is a working
   * agent; the guard would otherwise block it as an impasse, which is
   * experience-losing in exactly the case it was written to protect.
   */
  noteToolCall(): void {
    this.resetStallCounters()
  }

  /**
   * Note that a goal turn ended with no tool call at all: the goal talked
   * without acting. A goal whose text keeps changing but whose hands stay still
   * is stalled, and the no-progress fingerprint — which resets the moment the
   * text differs — cannot see it.
   */
  noteTurnWithoutToolCall(): void {
    this.runtime.turnsWithoutToolCall += 1
  }

  /** Consecutive turns that have now ended with no tool call at all. */
  get turnsWithoutToolCallCount(): number {
    return this.runtime.turnsWithoutToolCall
  }

  /** Whether the goal has now stalled by talking without acting. */
  hasStalledWithoutTools(): boolean {
    const goal = this.state.goal
    if (goal === undefined) return false
    // 0 disables the guard, so it is checked for rather than folded into the
    // comparison: `0 >= 0` would stall a goal on its very first tool-less turn
    // and there would be no way to turn the guard off.
    if (goal.maxTurnsWithoutToolCall <= 0) return false
    return this.runtime.turnsWithoutToolCall >= goal.maxTurnsWithoutToolCall
  }

  /** Add assistant usage to the goal's cumulative counters. */
  addUsage(usage: Partial<GoalUsage>): void {
    const goal = this.state.goal
    if (goal === undefined) return
    // accumulate on the *visible* usage, not the durable one: usage is carried on
    // the next durable mutation, so the durable value stays put between calls and
    // reading it would make every call after the first replace the first's delta
    const current = this.effectiveUsage(goal)
    const next: GoalUsage = {
      inputTokens: current.inputTokens + (usage.inputTokens ?? 0),
      outputTokens: current.outputTokens + (usage.outputTokens ?? 0),
      cost: current.cost + (usage.cost ?? 0),
    }
    // usage is carried on the next durable mutation; keep an in-memory overlay
    this.usageOverlay = next
  }

  private usageOverlay: GoalUsage | undefined

  private effectiveUsage(goal: GoalSnapshot): GoalUsage {
    return this.usageOverlay ?? goal.usage
  }

  /** Reject a stale or missing current-state ref. */
  private expectCurrent(ref: GoalRef): GoalSnapshot {
    this.sync()
    const current = this.state.goal
    if (current === undefined) throw new GoalError('GOAL_NOT_FOUND', 'no current goal')
    if (ref.id !== current.id || ref.revision !== current.revision) {
      throw new GoalError(
        'GOAL_STALE_REVISION',
        `stale goal ref "${ref.id}" revision ${ref.revision}; current is "${current.id}" revision ${current.revision}`,
      )
    }
    return current
  }

  /** Append one durable event and update the in-memory projection. */
  private commit(change: GoalChangeMeta): void {
    mkdirSync(dirname(this.logPath), { recursive: true })
    appendFileSync(this.logPath, `${JSON.stringify(change)}\n`)
    this.seq += 1
    if (change.operation === 'clear') {
      this.state = { goal: undefined, lastRef: change.cleared }
    } else {
      this.state = { goal: change.goal, lastRef: { id: change.goal.id, revision: change.goal.revision } }
    }
    this.usageOverlay = undefined
  }

  /** Build a snapshot carrying the current usage overlay. */
  private snapshotWithUsage(
    base: Omit<GoalSnapshot, 'usage'>,
    usage: GoalUsage | undefined,
  ): GoalSnapshot {
    return { ...base, usage: usage ?? EMPTY_USAGE }
  }

  private nextTime(goal: GoalSnapshot): number {
    return Math.max(Date.now(), goal.updatedAt)
  }

  /** Validate a caller-visible non-negative safe-integer token budget. */
  private static resolveTokenBudget(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new GoalError('GOAL_INVALID_TOKEN_BUDGET', 'tokenBudget must be a non-negative safe integer (0 = unlimited)')
    }
    return value
  }

  /** Validate a caller-visible positive safe-integer round cap. */
  private static resolveMaxGoalRounds(value: number): number {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new GoalError('GOAL_INVALID_MAX_ROUNDS', 'maxGoalRounds must be a positive safe integer')
    }
    return value
  }

  /** Validate and normalize an objective at the domain boundary. */
  private static resolveObjective(value: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new GoalError('GOAL_INVALID_OBJECTIVE', 'goal objective must be a non-empty string')
    }
    return value.trim()
  }

  private static resolveBlockReason(reason: GoalBlockReason): GoalBlockReason {
    const code = reason.code
    const message = reason.message
    if (typeof code !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(code) || typeof message !== 'string' || message.trim().length === 0) {
      throw new GoalError('GOAL_INVALID_BLOCK_REASON', 'block reason requires a lower-kebab-case code and a non-empty message')
    }
    return { code, message: message.trim() }
  }

  /** Default total admitted goal-round cap. */
  static readonly DEFAULT_MAX_GOAL_ROUNDS = 25

  /** Default consecutive tool-less turns before a goal is stalled. */
  static readonly DEFAULT_MAX_TURNS_WITHOUT_TOOL_CALL = 2

  /** Create and arm a goal. A completed goal may be replaced. */
  create(objective: string, maxGoalRounds: number, tokenBudget: number, maxTurnsWithoutToolCall?: number): GoalView {
    const resolvedObjective = GoalStore.resolveObjective(objective)
    const resolvedRounds = GoalStore.resolveMaxGoalRounds(maxGoalRounds)
    const resolvedBudget = GoalStore.resolveTokenBudget(tokenBudget)
    const resolvedStallTurns = GoalStore.resolveMaxTurnsWithoutToolCall(maxTurnsWithoutToolCall)
    this.sync()
    const current = this.state.goal
    if (current !== undefined && current.phase !== 'complete') {
      throw new GoalError('GOAL_ALREADY_EXISTS', `goal "${current.id}" already exists with phase "${current.phase}"`)
    }
    const now = Date.now()
    const goal = this.snapshotWithUsage(
      {
        id: `goal-${randomUUID()}`,
        revision: 1,
        objective: resolvedObjective,
        phase: 'active',
        maxGoalRounds: resolvedRounds,
        maxTurnsWithoutToolCall: resolvedStallTurns,
        tokenBudget: resolvedBudget,
        createdAt: now,
        updatedAt: now,
        roundsStarted: 0,
        waitUntil: 0,
      },
      this.usageOverlay,
    )
    this.commit({
      kind: 'goal/change',
      version: GOAL_CHANGE_VERSION,
      operation: 'create',
      goal,
    })
    this.runtime.activation = 'armed'
    this.resetStallCounters()
    return this.view()!
  }

  /**
   * Resolve the tool-less stall threshold. Non-negative and capped, so a typo
   * cannot express "never" as a very large number; 0 disables the guard.
   */
  static resolveMaxTurnsWithoutToolCall(value: number | undefined): number {
    if (value === undefined) return GoalStore.DEFAULT_MAX_TURNS_WITHOUT_TOOL_CALL
    if (!Number.isFinite(value) || value < 0) {
      throw new GoalError('GOAL_INVALID_EDIT', 'max_turns_without_tool_call must be a non-negative number')
    }
    return Math.min(Math.floor(value), 100)
  }

  /** Edit objective and/or round cap without changing phase. */
  edit(ref: GoalRef, objective: string | undefined, maxGoalRounds: number | undefined): GoalView {
    const current = this.expectCurrent(ref)
    if (objective === undefined && maxGoalRounds === undefined) {
      throw new GoalError('GOAL_INVALID_EDIT', 'goal edit requires objective and/or maxGoalRounds')
    }
    const goal = this.snapshotWithUsage(
      {
        ...current,
        revision: current.revision + 1,
        objective: objective === undefined ? current.objective : GoalStore.resolveObjective(objective),
        maxGoalRounds: maxGoalRounds === undefined ? current.maxGoalRounds : GoalStore.resolveMaxGoalRounds(maxGoalRounds),
        updatedAt: this.nextTime(current),
      },
      this.effectiveUsage(current),
    )
    this.commit({
      kind: 'goal/change',
      version: GOAL_CHANGE_VERSION,
      operation: 'edit',
      goal,
    })
    this.resetStallCounters()
    return this.view()!
  }

  /**
   * Transition helper for phase changes. Every phase change in this store goes
   * through here, so the activation rule and the wait-clearing are decided once
   * rather than once per operation.
   */
  private transition(
    ref: GoalRef,
    operation: 'pause' | 'resume' | 'complete' | 'block',
    allowed: readonly GoalPhase[],
    phase: GoalPhase,
    activation: GoalActivation,
    extra?: Readonly<Partial<Omit<GoalSnapshot, 'usage'>>>,
  ): GoalView {
    const current = this.expectCurrent(ref)
    if (!allowed.includes(current.phase)) {
      throw new GoalError(
        'GOAL_INVALID_TRANSITION',
        `cannot ${operation} goal "${current.id}" from phase "${current.phase}"; expected ${allowed.join(' or ')}`,
      )
    }
    const goal = this.snapshotWithUsage(
      {
        ...current,
        revision: current.revision + 1,
        phase,
        updatedAt: this.nextTime(current),
        // Only `wait()` sets the wait, so every phase transition clears it: a
        // paused, resumed, completed or blocked goal is not waiting on anything.
        waitUntil: 0,
        waitReason: undefined,
        ...extra,
      },
      this.effectiveUsage(current),
    )
    this.commit({
      kind: 'goal/change',
      version: GOAL_CHANGE_VERSION,
      operation,
      goal,
    })
    this.runtime.activation = activation
    if (operation === 'resume') {
      this.resetStallCounters()
    }
    if (operation === 'block' || operation === 'complete') {
    }
    return this.view()!
  }

  pause(ref: GoalRef): GoalView {
    return this.transition(ref, 'pause', ['active'], 'paused', 'disarmed')
  }

  resume(ref: GoalRef): GoalView {
    const current = this.expectCurrent(ref)
    if (current.phase === 'active' && this.runtime.activation === 'armed') {
      throw new GoalError('GOAL_INVALID_TRANSITION', `goal "${current.id}" is already active and armed`)
    }
    if (current.roundsStarted >= current.maxGoalRounds) {
      throw new GoalError(
        'GOAL_INVALID_TRANSITION',
        `goal "${current.id}" exhausted ${current.maxGoalRounds} goal rounds; increase maxGoalRounds before resuming`,
      )
    }
    return this.transition(ref, 'resume', ['active', 'paused', 'blocked'], 'active', 'armed')
  }

  /**
   * Complete the goal, recording the claim it completed with.
   *
   * The claim is validated here as well as at the tool, because a completed goal
   * is the one state a reader has no way to re-open and check: if the claim is
   * wrong when it lands, it is wrong for good.
   */
  complete(ref: GoalRef, claim?: CompletionClaim): GoalView {
    const normalized = claim === undefined ? undefined : validateCompletionClaim(claim)
    return this.transition(
      ref,
      'complete',
      ['active', 'paused', 'blocked'],
      'complete',
      'disarmed',
      normalized === undefined ? undefined : { completion: normalized },
    )
  }

  block(ref: GoalRef, reason: GoalBlockReason): GoalView {
    return this.transition(ref, 'block', ['active'], 'blocked', 'disarmed', {
      blockedReason: GoalStore.resolveBlockReason(reason),
    })
  }

  /** Record one admitted continuation round (driver-owned). */
  continue(ref: GoalRef): GoalView {
    const current = this.expectCurrent(ref)
    if (current.phase !== 'active') {
      throw new GoalError('GOAL_INVALID_TRANSITION', `cannot continue goal "${current.id}" from phase "${current.phase}"`)
    }
    const goal = this.snapshotWithUsage(
      {
        ...current,
        revision: current.revision + 1,
        roundsStarted: current.roundsStarted + 1,
        updatedAt: this.nextTime(current),
      },
      this.effectiveUsage(current),
    )
    this.commit({
      kind: 'goal/change',
      version: GOAL_CHANGE_VERSION,
      operation: 'continue',
      goal,
    })
    return this.view()!
  }

  /**
   * Wait on an external event until a deadline, durably.
   *
   * The deadline is required. It used to be optional, and an absent one was
   * folded to `0` — the same value that meant "not waiting" — so a wait with no
   * deadline did not wait at all: admission saw `waitUntil === 0`, treated the
   * goal as not waiting, and ran the next round immediately. One value could not
   * mean both things, and it is no longer asked to.
   */
  wait(ref: GoalRef, reason: string, resumeAfterMs: number): GoalView {
    const current = this.expectCurrent(ref)
    if (current.phase !== 'active') {
      throw new GoalError('GOAL_INVALID_TRANSITION', `cannot wait on goal "${current.id}" from phase "${current.phase}"`)
    }
    if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 1000) {
      throw new GoalError('GOAL_INVALID_EDIT', 'wait reason must be 1-1000 characters')
    }
    if (!Number.isFinite(resumeAfterMs) || resumeAfterMs <= 0) {
      throw new GoalError('GOAL_INVALID_EDIT', 'resume_after_ms is required and must be a positive number of milliseconds')
    }
    const now = Date.now()
    const deadline = now + Math.max(resumeAfterMs, 10_000)
    const goal = this.snapshotWithUsage(
      {
        ...current,
        revision: current.revision + 1,
        updatedAt: this.nextTime(current),
        waitUntil: deadline,
        waitReason: reason.trim(),
      },
      this.effectiveUsage(current),
    )
    this.commit({
      kind: 'goal/change',
      version: GOAL_CHANGE_VERSION,
      operation: 'wait',
      goal,
    })
    return this.view()!
  }

  /**
   * End the current external wait. Idempotent, and safe to call on a goal that
   * is not waiting — the inbox wake may arrive after the deadline already fired.
   */
  endWait(ref: GoalRef): GoalView {
    const current = this.expectCurrent(ref)
    if (current.waitUntil === 0) return this.view()!
    const goal = this.snapshotWithUsage(
      {
        ...current,
        revision: current.revision + 1,
        updatedAt: this.nextTime(current),
        waitUntil: 0,
        waitReason: undefined,
      },
      this.effectiveUsage(current),
    )
    this.commit({
      kind: 'goal/change',
      version: GOAL_CHANGE_VERSION,
      operation: 'wait',
      goal,
    })
    return this.view()!
  }

  /** Clear the current goal while retaining a durable tombstone and history. */
  clear(ref: GoalRef): void {
    const current = this.expectCurrent(ref)
    const tombstone: GoalRef = { id: current.id, revision: current.revision + 1 }
    const change: GoalClearChangeMeta = {
      kind: 'goal/change',
      version: GOAL_CHANGE_VERSION,
      operation: 'clear',
      cleared: tombstone,
      clearedAt: Date.now(),
    }
    this.commit(change)
    this.runtime.activation = 'disarmed'
    this.resetStallCounters()
  }
}