/**
 * Goal continuation driver: watches for `session.idle` and injects one guarded
 * continuation prompt per goal round while the goal is active and armed.
 *
 * Guardrails (pi-goal-style):
 * - Round cap (`maxGoalRounds`): reaching it blocks the goal with
 *   `round-limit` — the DSH round-budget posture.
 * - Token budget (`--tokens`): provider-reported usage is accumulated from
 *   assistant messages; reaching it blocks with `budget-limited`.
 * - No-progress guard: three consecutive empty or normalized-identical goal
 *   round outputs block with `no-progress`.
 * - External wait (`goal_wait`): suppresses continuation until a deadline.
 * - Stale-turn guard: every continuation is validated against the exact
 *   current goal ref (CAS) before the round is admitted.
 */

import type { OpencodeClient } from '@opencode-ai/sdk'
import type { GoalStore } from './state.ts'
import type { GoalView } from './types.ts'

export interface DriverHooks {
  /** Session store resolver: one store per project directory. */
  getStore(directory: string): GoalStore
  client: OpencodeClient
  log(message: string, extra?: Record<string, unknown>): void
}

/** Render the continuation prompt for one admitted round. */
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
    '- If the objective is fully achieved with evidence, call update_goal with action "complete" and a summary of the evidence.',
    '- If progress is genuinely blocked by something only the user or an external system can resolve (and the same blocker has persisted for at least 3 goal rounds), call update_goal with action "blocked" with a concrete reason.',
    '- If you are waiting on an external event (e.g. a monitor or review), call goal_wait with a reason and an optional resume_after_ms deadline instead of looping.',
    '- Do not claim completion without evidence. Do not mark blocked merely because work is difficult.',
  ].join('\n')
}

/** The continuation driver: one serialized continuation at a time per session. */
export class GoalDriver {
  private readonly inflight = new Map<string, Promise<void>>()
  private readonly stores = new Map<string, GoalStore>()
  private directory = ''

  constructor(private readonly hooks: DriverHooks) {}

  /** Bind the driver to the plugin's project directory. */
  setDirectory(directory: string): void {
    this.directory = directory
    this.storeFor(directory)
  }

  /** Resolve (and cache) the store for one project directory. */
  storeFor(directory: string): GoalStore {
    let store = this.stores.get(directory)
    if (store === undefined) {
      store = this.hooks.getStore(directory)
      this.stores.set(directory, store)
    }
    return store
  }

  /** Handle one `session.idle` event: maybe inject the next goal round. */
  async onSessionIdle(sessionID: string, directory: string): Promise<void> {
    const store = this.storeFor(directory)
    const goal = store.view()
    if (goal === undefined || goal.phase !== 'active' || goal.activation !== 'armed') return
    if (this.inflight.has(sessionID)) return

    const run = this.drive(store, sessionID, goal, directory).catch((error: unknown) => {
      this.hooks.log(`goal round failed: ${error instanceof Error ? error.message : String(error)}`, { sessionID })
    })
    this.inflight.set(sessionID, run)
    try {
      await run
    } finally {
      this.inflight.delete(sessionID)
    }
  }

  /** Attribute one assistant message to the active goal: usage + no-progress. */
  onAssistantMessage(
    directory: string,
    info: { tokens?: { input?: number; output?: number }; cost?: number; text?: string },
  ): void {
    const store = this.storeFor(directory)
    const goal = store.view()
    if (goal === undefined || goal.phase !== 'active') return
    if (info.tokens !== undefined || (info.cost ?? 0) > 0) {
      store.addUsage({
        inputTokens: info.tokens?.input ?? 0,
        outputTokens: info.tokens?.output ?? 0,
        cost: info.cost ?? 0,
      })
    }
    if (info.text !== undefined) {
      store.recordRoundOutput(info.text)
    }
  }

  /** Apply guardrails and inject one continuation round. */
  private async drive(store: GoalStore, sessionID: string, goal: GoalView, directory: string): Promise<void> {
    const now = Date.now()

    // external wait: quiet until the deadline passes or non-goal work wakes us
    if (store.waitUntil > 0) {
      if (store.waitUntil > now) return
      store.waitUntil = 0
      store.waitReason = undefined
    }

    // no-progress guard (pi-goal-style): three consecutive identical/empty rounds
    if (store.hasRepeatedRounds()) {
      store.block({ id: goal.id, revision: goal.revision }, {
        code: 'no-progress',
        message: 'Goal blocked: three consecutive goal rounds produced empty or identical output.',
      })
      this.hooks.log('goal blocked: no progress detected', { goalID: goal.id })
      return
    }

    // round cap (DSH round-budget posture)
    if (goal.roundsStarted >= goal.maxGoalRounds) {
      store.block({ id: goal.id, revision: goal.revision }, {
        code: 'round-limit',
        message: `Goal reached its configured limit of ${goal.maxGoalRounds} rounds.`,
      })
      this.hooks.log('goal blocked: round limit reached', { goalID: goal.id, rounds: goal.roundsStarted })
      return
    }

    // token budget (pi-goal-style)
    const used = goal.usage.inputTokens + goal.usage.outputTokens
    if (goal.tokenBudget > 0 && used >= goal.tokenBudget) {
      store.block({ id: goal.id, revision: goal.revision }, {
        code: 'budget-limited',
        message: `Goal reached its token budget of ${goal.tokenBudget} tokens (used ${used}).`,
      })
      this.hooks.log('goal blocked: token budget reached', { goalID: goal.id, used, budget: goal.tokenBudget })
      return
    }

    // admit the round with CAS (stale-turn guard)
    const round = goal.roundsStarted + 1
    const text = renderGoalRoundPrompt(goal, round)
    const admitted = store.continue({ id: goal.id, revision: goal.revision })
    this.hooks.log('goal round started', { goalID: goal.id, round, revision: admitted.revision })

    try {
      const result = await this.hooks.client.session.prompt({
        path: { id: sessionID },
        body: {
          parts: [{ type: 'text', text, synthetic: true }],
        },
      })
      const data = result.data
      if (data === undefined) throw new Error('goal round prompt failed without data')
      const info = data.info
      const textParts = data.parts
        .filter(p => p.type === 'text')
        .map(p => (p as { text?: string }).text ?? '')
        .join('\n')
      // attribute usage + output of this round
      this.onAssistantMessage(directory, {
        tokens: info.tokens,
        cost: info.cost,
        text: textParts,
      })
      this.hooks.log('goal round finished', { goalID: goal.id, round, cost: info.cost })
    } catch (error: unknown) {
      this.hooks.log(`goal round errored: ${error instanceof Error ? error.message : String(error)}`, { goalID: goal.id, round })
      // do not loop on provider errors: disarm so the next human turn decides
      store.activation = 'disarmed'
    }
  }
}