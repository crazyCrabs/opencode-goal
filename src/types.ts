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
/** One requirement a completion claim says it met, and the evidence for it. */
export interface CompletionCriterion {
  readonly criterion: string
  readonly evidence: readonly string[]
}

/**
 * One check the model says it ran. The shape is what makes the claim auditable:
 * a free-text summary cannot be compared against anything, while a named command
 * and the exit code it returned can be compared against the event stream.
 */
export interface CompletionCheck {
  readonly command?: string
  readonly result: 'passed' | 'failed' | 'not-run'
  readonly exitCode?: number
  readonly explanation?: string
}

/**
 * A structured claim that the objective is achieved.
 *
 * The evidence bar was the unanimous decision in its ticket; the shape itself was
 * a near coin-flip carried by one argument — the three-round gate on a
 * model-reported impasse only works if the model's own claims can be compared
 * across rounds, and a free-text summary is not comparable.
 */
export interface CompletionClaim {
  readonly summary: string
  readonly criteria: readonly CompletionCriterion[]
  readonly checks: readonly CompletionCheck[]
}

/**
 * Validate a completion claim. Returns the normalized claim, or throws with a
 * message the model can act on.
 *
 * A claim with no criteria is refused rather than recorded: an objective nobody
 * checked against is not an achieved objective, and recording it as one is the
 * failure this shape exists to prevent.
 */
export function validateCompletionClaim(claim: unknown): CompletionClaim {
  const source = (claim ?? {}) as Record<string, unknown>
  const summary = typeof source.summary === 'string' ? source.summary.trim() : ''
  if (summary.length === 0) throw new GoalError('GOAL_INVALID_CLAIM', 'a completion claim requires a non-empty summary')
  if (!Array.isArray(source.criteria)) {
    throw new GoalError('GOAL_INVALID_CLAIM', 'a completion claim requires criteria: at least one requirement and its evidence')
  }
  if (source.criteria.length === 0) {
    throw new GoalError('GOAL_INVALID_CLAIM', 'a completion claim requires at least one criterion with evidence')
  }
  const criteria: CompletionCriterion[] = []
  for (const [index, raw] of source.criteria.entries()) {
    const entry = (raw ?? {}) as Record<string, unknown>
    const criterion = typeof entry.criterion === 'string' ? entry.criterion.trim() : ''
    if (criterion.length === 0) {
      throw new GoalError('GOAL_INVALID_CLAIM', `criterion ${index + 1} requires a non-empty description`)
    }
    const evidence = Array.isArray(entry.evidence)
      ? entry.evidence.filter((item): item is string => typeof item === 'string').map(item => item.trim())
      : []
    if (evidence.length === 0) {
      throw new GoalError('GOAL_INVALID_CLAIM', `criterion ${index + 1} ("${criterion}") requires at least one piece of evidence`)
    }
    criteria.push({ criterion, evidence })
  }
  const rawChecks = Array.isArray(source.checks) ? source.checks : []
  const checks: CompletionCheck[] = []
  for (const raw of rawChecks) {
    const entry = (raw ?? {}) as Record<string, unknown>
    const result = entry.result
    if (result !== 'passed' && result !== 'failed' && result !== 'not-run') {
      throw new GoalError('GOAL_INVALID_CLAIM', `a check's result must be passed, failed or not-run, not ${JSON.stringify(result)}`)
    }
    const exitCode = typeof entry.exitCode === 'number' && Number.isFinite(entry.exitCode) ? entry.exitCode : undefined
    checks.push({
      command: typeof entry.command === 'string' && entry.command.trim().length > 0 ? entry.command.trim() : undefined,
      result,
      exitCode,
      explanation: typeof entry.explanation === 'string' && entry.explanation.trim().length > 0 ? entry.explanation.trim() : undefined,
    })
  }
  return { summary, criteria, checks }
}

/**
 * Every reason the system can stop a goal with. A closed union, because the
 * block gate in `round-policy.ts` tiers these codes and a code outside the union
 * would silently escape the gate.
 */
export type GoalBlockCode =
  /** The model reported an impasse only a human or an external system can clear. */
  | 'model-reported'
  /** Consecutive goal rounds produced empty or identical output. */
  | 'no-progress'
  /** The goal reached its configured round cap. */
  | 'round-limit'
  /** The goal reached its configured token budget. */
  | 'budget-limited'
  /** Consecutive turns ended with no tool call at all. */
  | 'no-tool-call'
  /** The provider refused to serve the goal (quota, auth, rate limit). */
  | 'usage-limited'
  /** An external wait whose deadline passed while nothing woke it. */
  | 'wait-expired'

export interface GoalBlockReason {
  /** Stable lower-kebab-case classification chosen by the blocking policy. */
  readonly code: GoalBlockCode
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
  /**
   * Consecutive turns with no tool call at all before the goal is stalled as
   * talking without acting. Durable for the same reason the budget is: it is a
   * limit the model-facing surface and the command plane have to agree on, and
   * process-local state cannot be shared across writers.
   */
  readonly maxTurnsWithoutToolCall: number
  /**
   * Optional total token budget (0 = unlimited). Durable so every writer —
   * the server-side goal tools and the TUI `/goal` command — observes one
   * value; process-local state cannot be shared across writers.
   */
  readonly tokenBudget: number
  /** Epoch milliseconds of the create mutation. */
  readonly createdAt: number
  /** Epoch milliseconds of the latest mutation. */
  readonly updatedAt: number
  /** Token/cost usage snapshot at this mutation. */
  readonly usage: GoalUsage
  /** Highest admitted round number for this goal. */
  readonly roundsStarted: number
  /**
   * External-wait deadline (epoch ms; 0 = not waiting).
   *
   * Durable, because a wait that lived only in one process was a wait a restart
   * forgot: the goal came back armed and ran straight on into whatever it had
   * been waiting for. Zero now means one thing and one thing only — not waiting.
   * A wait with no deadline cannot be expressed, which is what removes the
   * sentinel collision where 0 used to mean both.
   */
  readonly waitUntil: number
  /** Reason recorded when waiting. */
  readonly waitReason?: string
  /**
   * The structured claim the goal completed with. Recorded rather than discarded
   * because "auditable" means the claim can still be read after the round that
   * made it, and a claim that only ever reached the tool result was not auditable
   * — it was a message.
   */
  readonly completion?: CompletionClaim
}

/** Current goal projection, including values derived from the log fold. */
export interface GoalView extends GoalSnapshot {
  /** Process-local continuation eligibility; never persisted. */
  readonly activation: GoalActivation
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
  | 'GOAL_INVALID_CLAIM'

/** Domain error with a stable machine-readable code. */
export class GoalError extends Error {
  readonly code: GoalErrorCode
  constructor(code: GoalErrorCode, message: string) {
    super(message)
    this.name = 'GoalError'
    this.code = code
  }
}