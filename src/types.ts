/**
 * Pure domain types of opencode-goal: the durable goal snapshot vocabulary,
 * compare-and-set refs, phases, activation, and event payloads.
 *
 * Architecture notes:
 * - Event-sourced state (DSH-style): every mutation appends a `goal/change`
 *   event to an append-only JSONL log; the projection is a last-wins fold.
 * - Compare-and-set (DSH-style): every mutation requires the exact current
 *   `GoalRef` (id + revision); stale refs are rejected.
 * - Orthogonal state separation (DSH-style): durable `GoalPhase` and
 *   process-local `GoalActivation` are distinct dimensions.
 */

/** Identifies one goal across its durable revisions. */
export interface GoalRef {
  readonly id: string
  /** Positive revision; every durable mutation increments it. */
  readonly revision: number
}

/** Durable lifecycle phase. Activation is process-local and separate. */
export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete'

/** Whether this live process may automatically continue an active goal. */
export type GoalActivation = 'armed' | 'disarmed'

/** Machine-routable and human-readable explanation for a blocked goal. */
export interface GoalBlockReason {
  /** Stable lower-kebab-case classification chosen by the blocking policy. */
  readonly code: string
  /** Non-empty explanation shown to humans and models. */
  readonly message: string
}

/** Token and cost usage accumulated over the goal lifecycle. */
export interface GoalUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cost: number
}

export const EMPTY_USAGE: GoalUsage = { inputTokens: 0, outputTokens: 0, cost: 0 }

/** Full durable state written by every non-clear goal mutation. */
export interface GoalSnapshot extends GoalRef {
  /** Human-requested completion objective. */
  readonly objective: string
  /** Durable lifecycle phase. */
  readonly phase: GoalPhase
  /** Present exactly while `phase` is `blocked`. */
  readonly blockedReason?: GoalBlockReason
  /** Total admitted goal-round cap. */
  readonly maxGoalRounds: number
  /** Epoch milliseconds of the create mutation. */
  readonly createdAt: number
  /** Epoch milliseconds of the latest mutation. */
  readonly updatedAt: number
  /** Token/cost usage snapshot at this mutation. */
  readonly usage: GoalUsage
  /** Highest admitted round number for this goal. */
  readonly roundsStarted: number
}

/** Current goal projection, including values derived from the log fold. */
export interface GoalView extends GoalSnapshot {
  /** Process-local continuation eligibility; never persisted. */
  readonly activation: GoalActivation
  /** Optional token budget (0 = unlimited). */
  readonly tokenBudget: number
  /** Optional external-wait deadline (epoch ms; 0 = none). */
  readonly waitUntil: number
  /** Reason recorded when waiting. */
  readonly waitReason?: string
}

/** State-changing verbs recorded in the durable change log. */
export type GoalOperation =
  | 'create'
  | 'edit'
  | 'pause'
  | 'resume'
  | 'complete'
  | 'block'
  | 'continue'
  | 'wait'
  | 'clear'

/** Full-snapshot mutation committed by a durable `goal/change` event. */
export interface GoalSnapshotChangeMeta {
  readonly kind: 'goal/change'
  readonly version: 1
  readonly operation: Exclude<GoalOperation, 'clear'>
  readonly goal: GoalSnapshot
}

/** Tombstone retained when the current goal is cleared. */
export interface GoalClearChangeMeta {
  readonly kind: 'goal/change'
  readonly version: 1
  readonly operation: 'clear'
  readonly cleared: GoalRef
  readonly clearedAt: number
}

/** Durable change union carried by the goal domain's own log event. */
export type GoalChangeMeta = GoalSnapshotChangeMeta | GoalClearChangeMeta

/** Stable error codes for rejected goal reads and mutations. */
export type GoalErrorCode =
  | 'GOAL_NOT_FOUND'
  | 'GOAL_ALREADY_EXISTS'
  | 'GOAL_STALE_REVISION'
  | 'GOAL_INVALID_OBJECTIVE'
  | 'GOAL_INVALID_MAX_ROUNDS'
  | 'GOAL_INVALID_TOKEN_BUDGET'
  | 'GOAL_INVALID_BLOCK_REASON'
  | 'GOAL_INVALID_EDIT'
  | 'GOAL_INVALID_TRANSITION'
  | 'GOAL_BUDGET_EXHAUSTED'

/** Domain error with a stable machine-readable code. */
export class GoalError extends Error {
  readonly code: GoalErrorCode
  constructor(code: GoalErrorCode, message: string) {
    super(message)
    this.name = 'GoalError'
    this.code = code
  }
}