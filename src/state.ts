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
  type GoalBlockReason,
  type GoalChangeMeta,
  type GoalClearChangeMeta,
  type GoalOperation,
  type GoalPhase,
  type GoalRef,
  type GoalSnapshot,
  type GoalSnapshotChangeMeta,
  type GoalUsage,
  type GoalView,
} from './types.ts'

const GOAL_CHANGE_VERSION = 1

/** Coerce a possibly-missing legacy `tokenBudget` field into the durable shape. */
function normalizeSnapshot(snapshot: GoalSnapshot): GoalSnapshot {
  const budget = snapshot.tokenBudget
  if (typeof budget === 'number' && Number.isFinite(budget) && budget > 0) return snapshot
  return { ...snapshot, tokenBudget: 0 }
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
  waitUntil: number
  waitReason: string | undefined
  /** Normalized assistant outputs of recent goal rounds (no-progress guard). */
  recentOutputs: string[]
}

function emptyRuntime(): RuntimeState {
  return {
    activation: 'disarmed',
    waitUntil: 0,
    waitReason: undefined,
    recentOutputs: [],
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
      this.runtime.waitUntil = 0
      this.runtime.waitReason = undefined
      this.runtime.recentOutputs.length = 0
      this.usageOverlay = undefined
      return
    }
    const replaced = previous === undefined || previous.id !== next.id
    if (replaced || next.phase !== previous?.phase) {
      this.runtime.waitUntil = 0
      this.runtime.waitReason = undefined
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

  /** External-wait deadline (epoch ms; 0 = none). */
  get waitUntil(): number {
    return this.runtime.waitUntil
  }

  set waitUntil(value: number) {
    this.runtime.waitUntil = value
  }

  get waitReason(): string | undefined {
    return this.runtime.waitReason
  }

  set waitReason(value: string | undefined) {
    this.runtime.waitReason = value
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
      waitUntil: this.runtime.waitUntil,
      waitReason: this.runtime.waitReason,
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

  /** Reset the no-progress fingerprint (after resume / edit / different output). */
  resetNoProgress(): void {
    this.runtime.recentOutputs.length = 0
  }

  /** Add assistant usage to the goal's cumulative counters. */
  addUsage(usage: Partial<GoalUsage>): void {
    const goal = this.state.goal
    if (goal === undefined) return
    const current = goal.usage
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

  /** Create and arm a goal. A completed goal may be replaced. */
  create(objective: string, maxGoalRounds: number, tokenBudget: number): GoalView {
    const resolvedObjective = GoalStore.resolveObjective(objective)
    const resolvedRounds = GoalStore.resolveMaxGoalRounds(maxGoalRounds)
    const resolvedBudget = GoalStore.resolveTokenBudget(tokenBudget)
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
        tokenBudget: resolvedBudget,
        createdAt: now,
        updatedAt: now,
        roundsStarted: 0,
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
    this.runtime.waitUntil = 0
    this.runtime.waitReason = undefined
    this.resetNoProgress()
    return this.view()!
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
    this.resetNoProgress()
    return this.view()!
  }

  /** Transition helper for phase-only operations. */
  private transition(
    ref: GoalRef,
    operation: 'pause' | 'resume' | 'complete' | 'block',
    allowed: readonly GoalPhase[],
    phase: GoalPhase,
    activation: GoalActivation,
    blockedReason?: GoalBlockReason,
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
        ...blockedReason === undefined ? {} : { blockedReason: GoalStore.resolveBlockReason(blockedReason) },
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
      this.runtime.waitUntil = 0
      this.runtime.waitReason = undefined
      this.resetNoProgress()
    }
    if (operation === 'block' || operation === 'complete') {
      this.runtime.waitUntil = 0
      this.runtime.waitReason = undefined
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

  complete(ref: GoalRef): GoalView {
    return this.transition(ref, 'complete', ['active', 'paused', 'blocked'], 'complete', 'disarmed')
  }

  block(ref: GoalRef, reason: GoalBlockReason): GoalView {
    return this.transition(ref, 'block', ['active'], 'blocked', 'disarmed', reason)
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

  /** Set or clear an external-wait deadline. */
  wait(ref: GoalRef, reason: string, resumeAfterMs: number | undefined): GoalView {
    const current = this.expectCurrent(ref)
    if (current.phase !== 'active') {
      throw new GoalError('GOAL_INVALID_TRANSITION', `cannot wait on goal "${current.id}" from phase "${current.phase}"`)
    }
    if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 1000) {
      throw new GoalError('GOAL_INVALID_EDIT', 'wait reason must be 1-1000 characters')
    }
    const now = Date.now()
    const clamped = resumeAfterMs === undefined ? undefined : Math.max(resumeAfterMs, 10_000)
    const goal = this.snapshotWithUsage(
      {
        ...current,
        revision: current.revision + 1,
        updatedAt: this.nextTime(current),
      },
      this.effectiveUsage(current),
    )
    this.commit({
      kind: 'goal/change',
      version: GOAL_CHANGE_VERSION,
      operation: 'wait',
      goal,
    })
    this.runtime.waitReason = reason.trim()
    this.runtime.waitUntil = clamped === undefined ? 0 : now + clamped
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
    this.runtime.waitUntil = 0
    this.runtime.waitReason = undefined
    this.resetNoProgress()
  }
}