/**
 * Round policy: the pieces of the continuation loop that are pure, shared,
 * and speak no transport. Both the autonomous driver and the human `/goal`
 * command need them, so neither may own them — a piece of policy that lives on
 * one side of the entry-point divide is a policy the other side re-implements,
 * and the two drift.
 *
 * These functions are deliberately transport-free: they read a `GoalStore` and a
 * `GoalView` and answer. They never touch a session, a directory, or an event.
 * That is what lets both entry points cross one policy rather than two.
 *
 * The driver's `GoalDriver` class owns everything transport-shaped — per-session
 * in-flight tracking, usage accounting, prompt submission, and reporting. When
 * the admission decision grows its own seam (ticket 15), it is cut here, not
 * there.
 */

import type { GoalStore } from './state.ts'
import type { GoalBlockCode, GoalBlockReason, GoalView } from './types.ts'

/**
 * Render the continuation prompt for one admitted round.
 *
 * The prompt is the model-facing half of the policy: what the objective is, what
 * evidence counts, and which verbs end the round. Any wording change here is a
 * change to what the model does, so it is pinned by a test that quotes the
 * golden text rather than by a loose "contains" assertion.
 */
export function renderGoalRoundPrompt(goal: GoalView, round: number): string {
  const budget = goal.tokenBudget > 0 ? ` | budget ${goal.usage.inputTokens + goal.usage.outputTokens}/${goal.tokenBudget}` : ''
  return [
    `[opencode-goal continuation round ${round}/${goal.maxGoalRounds}${budget}]`,
    '',
    'You are continuing an autonomous goal. The objective is:',
    '',
    goal.objective,
    '',
    'Rules for this round:',
    '- Treat the objective as the task; derive concrete requirements from it and from the current worktree.',
    '- Verify work against real evidence (commands, tests, files, runtime behavior) before claiming completion.',
    '- If the objective is fully achieved with evidence, call update_goal with action "complete" and a structured claim: a summary, the criteria you derived from the objective each with its evidence, and the checks you ran with the exit codes they returned.',
    '- If progress is genuinely blocked by something only the user or an external system can resolve (and the same blocker has persisted for at least 3 goal rounds), call update_goal with action "blocked" with a concrete reason.',
    '- If you are waiting on an external event (e.g. a monitor or review), call goal_wait with a reason and a resume_after_ms deadline instead of looping.',
    '- Do not claim completion without evidence. Do not mark blocked merely because work is difficult.',
  ].join('\n')
}

/**
 * HTTP statuses that mean the provider will not serve this request without a
 * human changing something — an account, a subscription, a quota. Retrying is
 * pointless, so a goal that meets one stops durably instead of disarming.
 */
const REFUSAL_STATUSES: ReadonlySet<number> = new Set([401, 402, 403, 408, 429])

/**
 * Classify a failed turn's error into a stop, or undefined when the failure is
 * not a provider refusal and the goal may carry on.
 *
 * This exists because a provider refusal used to leave a goal alive in durable
 * state and dead in practice: the driver caught the prompt-submission error and
 * set the process-local `activation` to `disarmed`, so the goal still read
 * `active` in the log, nothing recorded that the provider was the reason, and a
 * restart re-armed it straight back into the same refusal.
 *
 * A status outside the refusal set is left alone — a 500 or a dropped
 * connection is transient, and stopping a goal for one would lose work the next
 * attempt would have finished.
 */
/** Read one field off an unknown thrown value or event payload. */
function field(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) return undefined
  return (source as Record<string, unknown>)[key]
}

/**
 * Classify a failed turn's error into a stop, or undefined when the failure is
 * not a provider refusal and the goal may carry on.
 *
 * Takes `unknown` because its two callers hold different things: the driver
 * passes the `error` object from a turn-completion event, the command plane
 * passes whatever a failed prompt submission threw.
 *
 * The event shape is `{ type: string, message: string, status?: number }`,
 * declared by `@opencode/protocol` and confirmed by a live 403
 * (`provider.auth`, "An active OpenCode Go subscription is required", 403).
 */
export function providerStopReason(error: unknown): GoalBlockReason | undefined {
  if (error === undefined || error === null) return undefined
  const rawStatus = field(error, 'status')
  const status = typeof rawStatus === 'number' && Number.isFinite(rawStatus) ? rawStatus : undefined
  const type = typeof field(error, 'type') === 'string' ? (field(error, 'type') as string) : ''
  if (status !== undefined && !REFUSAL_STATUSES.has(status)) return undefined
  // a provider-family error with no status is still a refusal nobody can retry
  // past, but an untyped error with no status is not classifiable at all
  if (status === undefined && !type.startsWith('provider.')) return undefined
  const rawMessage = field(error, 'message')
  const message = typeof rawMessage === 'string' && rawMessage.trim().length > 0
    ? rawMessage.trim()
    : 'the provider refused the request'
  const kind = status !== undefined ? `HTTP ${status}` : type
  return {
    code: 'usage-limited',
    message: `Goal stopped: the provider refused the request (${kind}): ${message}`,
  }
}

/**
 * The two tiers of the block gate.
 *
 * A judgment is the agent's own claim about a situation it might be wrong about,
 * so it is challenged: the same condition must survive several rounds before it
 * is accepted. An arithmetic limit is a fact about what has already happened —
 * a cap that has been reached, a budget that has been spent — so it stops the
 * goal on the first breach. Gating it would spend rounds proving arithmetic.
 */
export type BlockTier = 'judgment' | 'arithmetic'

/**
 * Which tier each block code belongs to. A new code takes its tier from its
 * nature, and this table is where that is written down: joining the arithmetic
 * tier takes the immediate behaviour, joining the judgment tier takes the
 * three-round behaviour.
 */
const BLOCK_TIERS: Readonly<Record<GoalBlockCode, BlockTier>> = {
  // the model's own claim that it is stuck: challenge it
  'model-reported': 'judgment',
  // three identical rounds: already a three-round observation
  'no-progress': 'judgment',
  // talking without acting: an observation about the model's behaviour over
  // consecutive turns, so it is challenged rather than obeyed
  'no-tool-call': 'judgment',
  // caps and bills: already happened, no point re-litigating
  'round-limit': 'arithmetic',
  'budget-limited': 'arithmetic',
  'usage-limited': 'arithmetic',
  'wait-expired': 'arithmetic',
}

/** How many consecutive rounds a judgment condition must persist before it is accepted. */
export const JUDGMENT_ROUNDS = 3

export function blockTier(code: GoalBlockCode): BlockTier {
  return BLOCK_TIERS[code]
}

/**
 * Apply the tier to a candidate block: arithmetic reasons stop the goal now,
 * judgment reasons only once they have persisted `JUDGMENT_ROUNDS` consecutive
 * rounds with the same condition.
 *
 * The store answers the persistence question, because the answer is about the
 * goal's history rather than about this call: `no-progress` is already three
 * identical rounds by the time it is raised, and `model-reported` counts the
 * rounds the model has repeated the same impasse.
 *
 * Returns undefined when the condition is a judgment that has not yet persisted,
 * which means "not yet" rather than "never" — the caller continues the round and
 * the next observation is what decides.
 *
 * Note that at the admission seam this branch is currently unreachable: the only
 * judgment code `goalBlockReason` raises is `no-progress`, and it is already a
 * three-round observation by the time it is raised, so it always passes. The
 * branch is the tier being applied to whatever a future judgment code raises
 * there, which is the point of gating by tier rather than by code.
 */
export function gateBlock(store: GoalStore, reason: GoalBlockReason): GoalBlockReason | undefined {
  if (blockTier(reason.code) === 'arithmetic') return reason
  return store.judgmentPersisted(reason.code, reason.message) ? reason : undefined
}

/**
 * Guardrail verdict for admitting one more round: undefined means the round may
 * be admitted, otherwise the goal must be blocked with the returned reason.
 * Shared by the server driver and the TUI `/goal` command's first-round kick so
 * both entry points enforce one budget policy.
 *
 * Ordering is policy, not accident: the two stall guards are checked before the
 * round cap, so a goal that stops changing its answer — or stops acting entirely
 * — is blocked as stalled rather than as exhausted. A test pins that precedence.
 */
export function goalBlockReason(store: GoalStore, goal: GoalView): GoalBlockReason | undefined {
  // no-progress guard (pi-goal-style): three consecutive identical/empty rounds
  if (store.hasRepeatedRounds()) {
    return {
      code: 'no-progress',
      message: 'Goal blocked: three consecutive goal rounds produced empty or identical output.',
    }
  }
  // round cap (DSH round-budget posture)
  if (goal.roundsStarted >= goal.maxGoalRounds) {
    return {
      code: 'round-limit',
      message: `Goal reached its configured limit of ${goal.maxGoalRounds} rounds.`,
    }
  }
  // talking without acting: the goal keeps producing text and never uses a tool
  if (store.hasStalledWithoutTools()) {
    const limit = goal.maxTurnsWithoutToolCall
    return {
      code: 'no-tool-call',
      message:
        `Goal blocked: ${store.turnsWithoutToolCallCount} consecutive goal turns ended with no tool call ` +
        `(limit ${limit}). The goal is talking without acting.`,
    }
  }
  // token budget (pi-goal-style)
  const used = goal.usage.inputTokens + goal.usage.outputTokens
  if (goal.tokenBudget > 0 && used >= goal.tokenBudget) {
    return {
      code: 'budget-limited',
      message: `Goal reached its token budget of ${goal.tokenBudget} tokens (used ${used}).`,
    }
  }
  return undefined
}
