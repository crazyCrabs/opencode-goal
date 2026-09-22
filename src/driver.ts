/**
 * Goal continuation driver: watches for `session.idle` and injects one guarded
 * continuation prompt per goal round while the goal is active and armed.
 *
 * A session being created is the other trigger: opening a session in a project
 * with an active goal arms it and admits the next round, so a goal that merely
 * survived a restart keeps running without a human resuming it by hand.
 *
 * Guardrails (pi-goal-style):
 * - Round cap (`maxGoalRounds`): reaching it blocks the goal with
 *   `round-limit` — the DSH round-budget posture.
 * - Token budget (`--tokens`): provider-reported usage is accumulated from the
 *   session transcript; reaching it blocks with `budget-limited`.
 * - No-progress guard: three consecutive empty or normalized-identical goal
 *   round outputs block with `no-progress`.
 * - External wait (`goal_wait`): suppresses continuation until a deadline.
 * - Stale-turn guard: every continuation is validated against the exact
 *   current goal ref (CAS) before the round is admitted.
 *
 * Usage accounting runs at idle: opencode 2.x no longer emits `message.updated`,
 * so the driver reads the session transcript once per idle and folds every
 * assistant message newer than the last accounted one into the goal.
 */

import type { GoalStore } from './state.ts'
import type { GoalBlockReason, GoalView } from './types.ts'

/** One assistant message as the session transcript reports it. */
export interface DriverAssistantMessage {
  readonly id?: string
  readonly type?: string
  readonly tokens?: { input?: number; output?: number }
  readonly cost?: number
  readonly content?: ReadonlyArray<{ type?: string; text?: string }>
}

/**
 * The slice of the opencode 2.x session domain the driver speaks to. Its read
 * and action methods take the same inputs as the plugin context.
 */
export interface DriverSessionApi {
  prompt(input: { sessionID: string; text: string }): Promise<unknown>
  context(input: { sessionID: string }): Promise<readonly DriverAssistantMessage[]>
}

export interface DriverHooks {
  /** Session store resolver: one store per project directory. */
  getStore(directory: string): GoalStore
  session: DriverSessionApi
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

/**
 * Guardrail verdict for admitting one more round: undefined means the round may
 * be admitted, otherwise the goal must be blocked with the returned reason.
 * Shared by the server driver and the TUI `/goal` command's first-round kick so
 * both entry points enforce one budget policy.
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

/** How far one session's transcript has been folded into its goal. */
interface AccountedState {
  readonly messageID: string | undefined
  readonly inputTokens: number
  readonly outputTokens: number
}

/** The continuation driver: one serialized continuation at a time per session. */
export class GoalDriver {
  private readonly inflight = new Map<string, Promise<void>>()
  private readonly stores = new Map<string, GoalStore>()
  private readonly accounted = new Map<string, AccountedState>()
  /** Sessions this driver already auto-started, so one opening is one start. */
  private readonly started = new Set<string>()
  /**
   * The session currently running a goal round, per project directory. A second
   * session opening while one is mid-round must not start a parallel round on
   * the same goal; a round that finished releases the project for the next
   * session to adopt.
   */
  private readonly running = new Map<string, string>()
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

  /**
   * Handle a newly created session: opening a session in a project with an
   * active goal is the human's go-ahead, so the goal is armed and its next
   * round is admitted here — no manual `/goal resume` needed. A goal that is
   * paused, blocked, completed, waiting on an external event, or already
   * mid-round in another session is left alone.
   */
  async onSessionCreated(sessionID: string, directory: string): Promise<void> {
    if (this.started.has(sessionID)) return
    this.started.add(sessionID)
    const store = this.storeFor(directory)
    const goal = store.view()
    if (goal === undefined || goal.phase !== 'active') return
    // an external wait stays suppressed: goal_wait means quiet until the
    // deadline or the next human turn, not until the next session opens
    if (store.waitUntil > Date.now()) return
    // another session of this project is running the goal's current round
    const active = this.running.get(directory)
    if (active !== undefined && active !== sessionID) return
    // the goal survived this process (or a previous one) disarmed: opening a
    // session re-arms it, and the round below admits it like a resume would
    store.activation = 'armed'
    this.hooks.log('goal adopted by new session', { goalID: goal.id, sessionID, round: goal.roundsStarted + 1 })
    await this.drive(store, sessionID, goal, directory)
  }

  /** Handle one `session.idle` event: account the finished turn, then maybe inject the next goal round. */
  async onSessionIdle(sessionID: string, directory: string): Promise<void> {
    if (this.inflight.has(sessionID)) return
    const run = this.handle(sessionID, directory).catch((error: unknown) => {
      this.hooks.log(`goal round failed: ${error instanceof Error ? error.message : String(error)}`, { sessionID })
    })
    // claim the session synchronously so a second idle cannot double-drive it
    this.inflight.set(sessionID, run)
    try {
      await run
    } finally {
      this.inflight.delete(sessionID)
    }
  }

  /** Fold the finished turn's usage, then admit one continuation round. */
  private async handle(sessionID: string, directory: string): Promise<void> {
    const store = this.storeFor(directory)
    await this.accountSession(sessionID, store)
    const goal = store.view()
    if (goal === undefined || goal.phase !== 'active' || goal.activation !== 'armed') return
    await this.drive(store, sessionID, goal, directory)
  }

  /**
   * Attribute every assistant message newer than the last accounted one to the
   * active goal: provider usage for the token budget and the final text for the
   * no-progress guard.
   */
  private async accountSession(sessionID: string, store: GoalStore): Promise<void> {
    const goal = store.view()
    if (goal === undefined || goal.phase !== 'active') return
    let messages: readonly DriverAssistantMessage[]
    try {
      messages = await this.hooks.session.context({ sessionID })
    } catch {
      return // a failed read is retried at the next idle
    }
    const seen = this.accounted.get(sessionID)
    let index = 0
    if (seen?.messageID !== undefined) {
      const found = messages.findIndex(message => message.id === seen.messageID)
      if (found >= 0) index = found + 1
    }
    let inputTokens = 0
    let outputTokens = 0
    let cost = 0
    let lastID = seen?.messageID
    let lastText: string | undefined
    for (const message of messages.slice(index)) {
      if (message.type !== undefined && message.type !== 'assistant') continue
      inputTokens += message.tokens?.input ?? 0
      outputTokens += message.tokens?.output ?? 0
      cost += message.cost ?? 0
      if (message.id !== undefined) lastID = message.id
      const text = (message.content ?? [])
        .filter(part => part.type === 'text')
        .map(part => part.text ?? '')
        .join('\n')
      if (text.trim().length > 0) lastText = text
    }
    if (inputTokens > 0 || outputTokens > 0 || cost > 0) {
      store.addUsage({ inputTokens, outputTokens, cost })
    }
    if (lastText !== undefined) store.recordRoundOutput(lastText)
    this.accounted.set(sessionID, {
      messageID: lastID,
      inputTokens: (seen?.inputTokens ?? 0) + inputTokens,
      outputTokens: (seen?.outputTokens ?? 0) + outputTokens,
    })
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

    // guardrails shared with the TUI command plane (no-progress / rounds / budget)
    const blockReason = goalBlockReason(store, goal)
    if (blockReason !== undefined) {
      store.block({ id: goal.id, revision: goal.revision }, blockReason)
      this.hooks.log(`goal blocked: ${blockReason.code}`, { goalID: goal.id })
      return
    }

    // admit the round with CAS (stale-turn guard)
    const round = goal.roundsStarted + 1
    const text = renderGoalRoundPrompt(goal, round)
    const admitted = store.continue({ id: goal.id, revision: goal.revision })
    this.hooks.log('goal round started', { goalID: goal.id, round, revision: admitted.revision })

    // claim the project for this session while the round runs: a second
    // session opening meanwhile defers to it instead of racing the same goal
    this.running.set(directory, sessionID)

    // the round is admitted: submitting it must not stall the driver, because
    // the next `session.idle` (not this call) accounts the turn and admits the
    // round after it
    void this.hooks.session
      .prompt({ sessionID, text })
      .then(() => {
        // the round finished: the next session to open may adopt the goal
        if (this.running.get(directory) === sessionID) this.running.delete(directory)
      })
      .catch((error: unknown) => {
        this.hooks.log(`goal round errored: ${error instanceof Error ? error.message : String(error)}`, {
          goalID: goal.id,
          round,
        })
        // do not loop on provider errors: disarm so the next human turn decides
        store.activation = 'disarmed'
        if (this.running.get(directory) === sessionID) this.running.delete(directory)
      })
  }
}
