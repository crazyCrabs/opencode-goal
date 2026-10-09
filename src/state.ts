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
  type GoalLeaseChangeMeta,
  type GoalLogLine,
} from './types.ts'

const GOAL_CHANGE_VERSION = 1
const GOAL_LEASE_VERSION = 1

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

/**
 * Whether two folded goals report the same usage.
 *
 * Separate from `sameGoal` because usage is not part of a goal's identity: a
 * usage delta does not bump the revision (ADR 0002), so a fold that differs only
 * in usage has moved something a reader depends on without moving the goal.
 */
function sameUsage(a: GoalSnapshot | undefined, b: GoalSnapshot | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return (
    a.usage.inputTokens === b.usage.inputTokens &&
    a.usage.outputTokens === b.usage.outputTokens &&
    a.usage.cost === b.usage.cost
  )
}

/**
 * Whether two folded leases are the same claim.
 *
 * Compared field by field rather than by reference because a lease is re-appended
 * on every renewal, so a live round's lease is a different line every time while
 * remaining the same claim.
 */
function sameLease(a: GoalLeaseChangeMeta | undefined, b: GoalLeaseChangeMeta | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.id === b.id && a.holder === b.holder && a.expiresAt === b.expiresAt
}

/** Whether a fold holds nothing any reader of this store depends on. */
function unchangedFold(a: GoalFoldState, b: GoalFoldState): boolean {
  return sameGoal(a.goal, b.goal) && sameUsage(a.goal, b.goal) && sameLease(a.lease, b.lease)
}

/** Fold state rebuilt from the log. */
export interface GoalFoldState {
  /** Current goal snapshot, absent after a clear or before the first create. */
  readonly goal: GoalSnapshot | undefined
  /** Latest mutation ref, including a clear tombstone. */
  readonly lastRef: GoalRef | undefined
  /**
   * The last lease line folded, whether or not it has expired. Expiry is decided
   * at read time, so a holder's death is visible without rewriting history.
   */
  readonly lease: GoalLeaseChangeMeta | undefined
}

/**
 * Pure last-wins fold over durable goal facts.
 *
 * Usage is folded separately from the goal snapshot, because the two arrive on
 * different kinds of line. A snapshot line carries the goal as its writer last
 * saw it; a `usage` line carries only a delta, and it can arrive after the goal
 * has stopped changing — which is exactly the case that used to lose it. The
 * accumulator therefore runs alongside the snapshot, and the rule for when it
 * adopts a snapshot's carried value is what keeps old and new logs both folding
 * correctly; see the comment on the seeding below.
 */
export function foldGoalLog(lines: readonly string[]): GoalFoldState {
  let goal: GoalSnapshot | undefined
  let lastRef: GoalRef | undefined
  let usage: GoalUsage = EMPTY_USAGE
  let lease: GoalLeaseChangeMeta | undefined
  /** The goal the usage accumulator belongs to. */
  let usageGoalID: string | undefined
  /** Whether a delta has already been folded for `usageGoalID`. */
  let usageFromDelta = false
  for (const line of lines) {
    if (line.trim().length === 0) continue
    let parsed: GoalLogLine
    try {
      parsed = JSON.parse(line) as GoalLogLine
    } catch {
      continue // tolerate a torn tail write
    }
    // A lease is a coordinate, not a state verb: it is folded into its own slot
    // and never reaches the goal accumulator, the revision, or `lastRef`. A
    // lease naming a goal other than the one now current is dropped rather than
    // applied, so one writer's lease cannot hold another goal's round.
    if (parsed.kind === 'goal/lease') {
      if (goal !== undefined && parsed.id === goal.id) lease = parsed
      continue
    }
    const change = parsed
    if (change.kind !== 'goal/change' || change.version !== GOAL_CHANGE_VERSION) continue
    if (change.operation === 'usage') {
      // a delta, and only for the goal it names: one written by another goal's
      // writer must not be added to this one
      if (goal !== undefined && change.ref.id === goal.id) {
        usage = {
          inputTokens: usage.inputTokens + (change.delta.inputTokens ?? 0),
          outputTokens: usage.outputTokens + (change.delta.outputTokens ?? 0),
          cost: usage.cost + (change.delta.cost ?? 0),
        }
        usageFromDelta = true
      }
      continue
    }
    if (change.operation === 'clear') {
      goal = undefined
      lastRef = change.cleared
      usage = EMPTY_USAGE
      usageGoalID = undefined
      usageFromDelta = false
      // a cleared goal has no round to own, so its lease goes with it
      lease = undefined
    } else {
      goal = normalizeSnapshot(change.goal)
      lastRef = { id: change.goal.id, revision: change.goal.revision }
      // Seed the accumulator from a snapshot's carried usage while no delta has
      // been folded for this goal, and never after one has.
      //
      // The first half is what keeps a log written before usage became durable
      // readable: such a log has no `usage` lines at all and its total lives
      // only in the snapshots, so summing nothing would fold every one of them as
      // zero usage. The second half is what stops a new-style log from
      // double-counting: once a delta has landed, every later snapshot already
      // carries the sum of the deltas before it.
      //
      // A new goal id re-seeds regardless, so a completed goal's usage is not
      // inherited by the goal that replaces it.
      if (usageGoalID !== change.goal.id || !usageFromDelta) {
        usage = { ...change.goal.usage }
        usageGoalID = change.goal.id
        usageFromDelta = false
      }
    }
  }
  return {
    goal: goal === undefined ? undefined : { ...goal, usage },
    lastRef,
    lease,
  }
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
    this.state = { goal: undefined, lastRef: undefined, lease: undefined }
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
      this.state = { goal: undefined, lastRef: this.state.lastRef, lease: this.state.lease }
      // the goal is gone: that is a state verb, whatever removed it
      this.applyExternalChange(previous, undefined, true)
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
    // The early return is what keeps a read cheap, and it has to cover
    // everything a reader depends on, not only the goal: `view()` reads the
    // goal's usage and `lease` reads the lease. Comparing identity alone made a
    // foreign usage delta or a foreign lease invisible until a snapshot mutation
    // happened to land, which is a process reporting stale usage indefinitely and
    // — worse for ADR 0005 — a process admitting a round another process's lease
    // already covered.
    if (unchangedFold(this.state, folded)) return
    // A usage delta and a lease are coordinates, not state verbs. Neither one
    // re-arms or dis-arms this store, neither resets the no-progress history, and
    // neither clears this process's own usage overlay. Only the goal itself moving
    // — a different id, a higher revision, a different phase — does those things,
    // and running them for a coordinate is what would disarm an armed store: the
    // revision has not moved, so `applyActivation` would read "not mutated while
    // alive" and switch it off.
    const stateVerb = !sameGoal(previous, folded.goal)
    this.state = folded
    this.applyExternalChange(previous, folded.goal, stateVerb)
  }

  /** Adopt an externally folded goal, preserving usage accounting. */
  private applyExternalChange(
    previous: GoalSnapshot | undefined,
    next: GoalSnapshot | undefined,
    stateVerb: boolean,
  ): void {
    if (next === undefined) {
      // external clear: drop every process-local trace of the goal
      this.runtime.activation = 'disarmed'
      this.runtime.recentOutputs.length = 0
      this.usageOverlay = undefined
      return
    }
    // A coordinate moved and nothing else: the new state is already adopted
    // above, and every process-local consequence below belongs to a state verb.
    if (!stateVerb) return
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

  /**
   * Add assistant usage to the goal's cumulative counters, durably, at the
   * moment of the fold.
   *
   * This used to accumulate in memory and ride the next mutation, which loses
   * everything folded after the last one. Measured on a live server: a one-round
   * goal folded 46 196 input tokens and recorded 22 839, because the two steps
   * after the goal went complete had no mutation left to carry them — 22 839 is
   * exactly steps 1 and 2, and the `complete` was stamped 12 ms before step 3.
   * The same overlay discarded everything pending when the process exited, which
   * is the in-memory dependence ticket 14 set out to remove, reintroduced for
   * exactly the usage that is hardest to recover.
   *
   * The change is a **delta**, and it does not bump the revision. Both are
   * load-bearing:
   *
   * - The fold is last-wins per line, so a usage line carrying a snapshot would
   *   replace the goal as this process last saw it. A `/goal pause` written by
   *   the TUI while a round is in flight — a real ordering, because a paused
   *   goal's in-flight round still reports its steps — would be undone by the
   *   next usage line, which predates the pause. A delta cannot clobber anything.
   * - The revision is the coordinate every caller-held ref and the arming rule
   *   in `applyActivation` read. A usage fold is not a state verb and must not
   *   look like one, or a process folding steps would arm goals it never ran.
   *
   * The cost is one log line per step, about 180 bytes — a ref, three numbers
   * and a timestamp, no snapshot. A 25-round goal with several steps each is a
   * few hundred lines.
   *
   * A failed append falls back to the in-memory overlay so the goal keeps
   * running: a throw here would propagate into the plugin's event loop and end
   * the stream, so one bad write degrades one bookkeeping number instead of
   * every event after it.
   */
  addUsage(usage: Partial<GoalUsage>): void {
    const goal = this.state.goal
    if (goal === undefined) return
    const current = this.effectiveUsage(goal)
    const next: GoalUsage = {
      inputTokens: current.inputTokens + (usage.inputTokens ?? 0),
      outputTokens: current.outputTokens + (usage.outputTokens ?? 0),
      cost: current.cost + (usage.cost ?? 0),
    }
    const delta: GoalUsage = {
      inputTokens: next.inputTokens - current.inputTokens,
      outputTokens: next.outputTokens - current.outputTokens,
      cost: next.cost - current.cost,
    }
    // adopt locally first, so a second fold in the same tick accumulates on this
    // one even before the append returns
    this.state = { ...this.state, goal: { ...goal, usage: next } }
    try {
      this.appendUsage({ id: goal.id, revision: goal.revision }, delta)
    } catch {
      this.usageOverlay = next
    }
  }

  /**
   * Append one usage delta.
   *
   * Deliberately not `commit`: a usage line is not a snapshot, so it must not
   * touch the projection or the overlay the way every mutation does.
   */
  private appendUsage(ref: GoalRef, delta: GoalUsage): void {
    mkdirSync(dirname(this.logPath), { recursive: true })
    appendFileSync(this.logPath, `${JSON.stringify({
      kind: 'goal/change',
      version: GOAL_CHANGE_VERSION,
      operation: 'usage',
      ref,
      delta,
      at: Date.now(),
    })}\n`)
    this.usageOverlay = undefined
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
  private commit(change: GoalSnapshotChangeMeta | GoalClearChangeMeta): void {
    mkdirSync(dirname(this.logPath), { recursive: true })
    appendFileSync(this.logPath, `${JSON.stringify(change)}\n`)
    this.seq += 1
    if (change.operation === 'clear') {
      this.state = { goal: undefined, lastRef: change.cleared, lease: undefined }
    } else {
      // A state verb never touches the lease: it is a coordinate, and a round
      // admitted between the lease line and the commit keeps it.
      this.state = { goal: change.goal, lastRef: { id: change.goal.id, revision: change.goal.revision }, lease: this.state.lease }
    }
    this.usageOverlay = undefined
  }

  /**
   * Claim the current round for this process, durably.
   *
   * Written after admission commits, so the `continue` line is already in the log
   * when another process re-folds it: the lease describes a round that exists.
   *
   * A renewal is the same call with a later `expiresAt`. It is a plain append
   * rather than an update because the log is append-only, and the fold is
   * last-wins, so a renewal simply supersedes the lease it replaces.
   */
  holdRound(ref: GoalRef, holder: string, expiresAt: number): void {
    this.expectCurrent(ref)
    const at = Date.now()
    mkdirSync(dirname(this.logPath), { recursive: true })
    appendFileSync(this.logPath, `${JSON.stringify({
      kind: 'goal/lease',
      version: GOAL_LEASE_VERSION,
      id: ref.id,
      holder,
      at,
      expiresAt: Math.max(expiresAt, at),
    } satisfies GoalLeaseChangeMeta)}\n`)
    this.seq += 1
  }

  /**
   * Release the round this process holds, if it still holds it.
   *
   * A release is a lease line whose expiry is already past, not a delete: an
   * append-only log cannot delete, and a past expiry is what the fold already
   * knows how to read. A holder that is no longer the holder — another process
   * took the round over — writes nothing, because overwriting a live lease would
   * hand the round back to a process that just lost it.
   */
  releaseRound(ref: GoalRef, holder: string): void {
    const current = this.current
    if (current === undefined || current.id !== ref.id) return
    const lease = this.state.lease
    if (lease !== undefined && lease.holder !== holder) return
    const at = Date.now()
    mkdirSync(dirname(this.logPath), { recursive: true })
    appendFileSync(this.logPath, `${JSON.stringify({
      kind: 'goal/lease',
      version: GOAL_LEASE_VERSION,
      id: ref.id,
      holder,
      at,
      expiresAt: at,
    } satisfies GoalLeaseChangeMeta)}\n`)
    this.seq += 1
  }

  /**
   * The lease currently holding the goal's round, or undefined when none is
   * live.
   *
   * Expiry is read at call time rather than stored, so a process that died
   * mid-round releases its round by doing nothing at all: the lease ages out and
   * the next admission is allowed. That is the whole crash story, and it needs no
   * liveness protocol.
   */
  get lease(): GoalLeaseChangeMeta | undefined {
    this.sync()
    const lease = this.state.lease
    if (lease === undefined) return undefined
    if (lease.expiresAt <= Date.now()) return undefined
    return lease
  }

  /**
   * Renew this process's lease only when it is close enough to expiry to be
   * worth a line.
   *
   * Without the threshold every step of every round would append a line, and a
   * twenty-round goal would write two hundred of them for one fact. With it, a
   * round renews about once per half-window, which is also the natural rate at
   * which the lease's expiry means anything.
   */
  renewLeaseIfDue(ref: GoalRef, holder: string, windowMs: number): void {
    this.sync()
    const lease = this.state.lease
    if (lease === undefined || lease.holder !== holder) return
    if (lease.expiresAt - Date.now() >= windowMs / 2) return
    this.holdRound(ref, holder, Date.now() + windowMs)
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