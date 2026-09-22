/**
 * Goal continuation driver: watches session turn completions and injects one
 * guarded continuation prompt per goal round while the goal is active and
 * armed.
 *
 * The completion signal is `session.execution.succeeded|failed|interrupted`,
 * NOT `session.idle`: opencode 2.x publishes no `session.idle` when a prompt
 * turn ends (verified against a live server — a turn emits
 * `session.execution.started` → `session.step.*` → `session.execution.*`).
 * A driver that waits on `session.idle` therefore stalls after the first
 * round. `session.idle` is still honored as a legacy trigger, but only while
 * no round is in flight, because it can fire without any turn finishing (a
 * freshly opened session emits a short burst of them).
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
 * - One-round-at-a-time guard: a round is in flight from admission until its
 *   turn's completion event, and no second round is admitted for that session
 *   meanwhile — opencode coalesces a prompt submitted mid-turn instead of
 *   running it, so a second admission would burn budget without doing work.
 *
 * Usage accounting runs at turn completion: opencode 2.x no longer emits
 * `message.updated`, so the driver reads the session transcript once per
 * finished turn and folds every assistant message newer than the last
 * accounted one into the goal.
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
  /** Deleted sessions: never driven again, whatever event arrives for them. */
  private readonly forgotten = new Set<string>()
  /**
   * Sessions with a goal round in flight: a round counts as in flight from the
   * moment it is admitted until its turn's completion event arrives. Triggers
   * for such a session are ignored, because opencode coalesces a prompt
   * submitted while a turn is running instead of running it — a second round
   * admitted meanwhile would spend budget on a prompt that never executes.
   */
  private readonly roundsInFlight = new Set<string>()
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
    if (this.started.has(sessionID) || this.forgotten.has(sessionID)) return
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
    // this session already runs a round (a legacy idle started it first)
    if (this.roundsInFlight.has(sessionID)) return
    // the goal survived this process (or a previous one) disarmed: opening a
    // session re-arms it, and the round below admits it like a resume would
    store.activation = 'armed'
    this.hooks.log('goal adopted by new session', { goalID: goal.id, sessionID, round: goal.roundsStarted + 1 })
    await this.drive(store, sessionID, goal, directory)
  }

  /** Handle one `session.idle` event: account the finished turn, then maybe inject the next goal round. */
  async onSessionIdle(sessionID: string, directory: string): Promise<void> {
    if (this.inflight.has(sessionID) || this.forgotten.has(sessionID)) return
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

  /**
   * Handle one finished turn as opencode 2.x reports it:
   * `session.execution.succeeded|failed|interrupted`. This is the only
   * reliable completion signal — no `session.idle` is published when a prompt
   * turn ends — so it is what keeps the autonomous loop advancing.
   *
   * A turn the human interrupted (`reason: "user"`) is accounted but not
   * continued: the human took over, and `/goal resume` starts the next round.
   */
  async onTurnFinished(sessionID: string, directory: string, reason?: string): Promise<void> {
    if (this.inflight.has(sessionID) || this.forgotten.has(sessionID)) return
    const run = this.finish(sessionID, directory, reason).catch((error: unknown) => {
      this.hooks.log(`goal round failed: ${error instanceof Error ? error.message : String(error)}`, { sessionID })
    })
    // claim the session synchronously so a burst of completion events cannot
    // double-drive it while the turn is being accounted
    this.inflight.set(sessionID, run)
    try {
      await run
    } finally {
      this.inflight.delete(sessionID)
    }
  }

  /** Drop every trace of a deleted session so stale state cannot leak. */
  forget(sessionID: string): void {
    this.forgotten.add(sessionID)
    this.started.delete(sessionID)
    this.accounted.delete(sessionID)
    this.roundsInFlight.delete(sessionID)
    this.inflight.delete(sessionID)
    for (const [directory, active] of this.running) {
      if (active === sessionID) this.running.delete(directory)
    }
  }

  /** Fold the finished turn's usage, then admit one continuation round. */
  private async handle(sessionID: string, directory: string): Promise<void> {
    // a goal round is mid-turn in this session: its completion event admits
    // the next round, and `session.idle` can fire without a turn finishing
    if (this.roundsInFlight.has(sessionID)) return
    const store = this.storeFor(directory)
    await this.accountSession(sessionID, store)
    const goal = store.view()
    if (goal === undefined || goal.phase !== 'active' || goal.activation !== 'armed') return
    await this.drive(store, sessionID, goal, directory)
  }

  /** Account one finished turn reported through the execution events. */
  private async finish(sessionID: string, directory: string, reason?: string): Promise<void> {
    const store = this.storeFor(directory)
    // the turn that was in flight is over: release the round before admitting
    // the next one, whether or not this session's turn is admitted again
    this.releaseRound(sessionID, directory)
    await this.accountSession(sessionID, store)
    if (reason === 'user') {
      this.hooks.log('goal round interrupted by the user; waiting for a human turn', { sessionID })
      return
    }
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
    // one round at a time per session: opencode coalesces a prompt submitted
    // mid-turn, so a second admission would burn a round for no work
    if (this.roundsInFlight.has(sessionID)) return
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
      this.blockSafely(store, goal, blockReason)
      return
    }

    // admit the round with CAS (stale-turn guard)
    const round = goal.roundsStarted + 1
    const text = renderGoalRoundPrompt(goal, round)
    let admitted: GoalView
    try {
      admitted = store.continue({ id: goal.id, revision: goal.revision })
    } catch (error) {
      // another writer won the compare-and-set race (a second plugin instance
      // for the same project also observed the completion event): its round is
      // the one that runs here, so this instance stays out of the way
      this.hooks.log(`goal round not admitted: ${error instanceof Error ? error.message : String(error)}`, {
        goalID: goal.id,
        round,
      })
      return
    }
    this.hooks.log('goal round started', { goalID: goal.id, round, revision: admitted.revision })

    // the round is in flight until its turn reports back through the
    // execution events; the project is claimed for this session meanwhile so a
    // second session opening defers instead of racing the same goal
    this.roundsInFlight.add(sessionID)
    this.running.set(directory, sessionID)

    // the round is admitted: submitting it must not stall the driver, because
    // the turn's completion event (not this call) accounts it and admits the
    // round after it
    void this.hooks.session
      .prompt({ sessionID, text })
      .then(() => {
        // submission acknowledged; the round keeps running until its completion
      })
      .catch((error: unknown) => {
        this.hooks.log(`goal round errored: ${error instanceof Error ? error.message : String(error)}`, {
          goalID: goal.id,
          round,
        })
        // do not loop on provider errors: disarm so the next human turn decides
        store.activation = 'disarmed'
        this.releaseRound(sessionID, directory)
      })
  }

  /** Block the goal, tolerating a lost compare-and-set race with another writer. */
  private blockSafely(store: GoalStore, goal: GoalView, blockReason: GoalBlockReason): void {
    try {
      store.block({ id: goal.id, revision: goal.revision }, blockReason)
      this.hooks.log(`goal blocked: ${blockReason.code}`, { goalID: goal.id })
    } catch (error) {
      this.hooks.log(`goal block skipped: ${error instanceof Error ? error.message : String(error)}`, { goalID: goal.id })
    }
  }

  /** Release the in-flight round of one session (its turn ended or failed). */
  private releaseRound(sessionID: string, directory: string): void {
    this.roundsInFlight.delete(sessionID)
    if (this.running.get(directory) === sessionID) this.running.delete(directory)
  }
}
