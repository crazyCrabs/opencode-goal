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
 * - Token budget (`--tokens`): provider-reported usage is accumulated by the
 *   accounting module from the durable per-step events; reaching it blocks with
 *   `budget-limited`.
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
 * Usage accounting is NOT here: it lives in its own module (`accounting.ts`) and
 * folds the durable session events as they arrive, before this driver sees the
 * turn-completion event that admits the next round. It used to read the session
 * transcript once per finished turn, which lost usage after a restart and
 * blocked an agent that repeated itself while working.
 */

import type { GoalStore } from './state.ts'
import type { GoalView } from './types.ts'
import { admitRound, stopGoal } from './admission.ts'
import { providerStopReason, renderGoalRoundPrompt } from './round-policy.ts'

/**
 * The slice of the opencode 2.x session domain the driver speaks to. Its read
 * and action methods take the same inputs as the plugin context.
 */
export interface DriverSessionApi {
  prompt(input: { sessionID: string; text: string }): Promise<unknown>
}

export interface DriverHooks {
  /** Session store resolver: one store per project directory. */
  getStore(directory: string): GoalStore
  session: DriverSessionApi
  log(message: string, extra?: Record<string, unknown>): void
}

/** The continuation driver: one serialized continuation at a time per session. */
export class GoalDriver {
  private readonly inflight = new Map<string, Promise<void>>()
  private readonly stores = new Map<string, GoalStore>()
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
    await this.drive(store, sessionID, directory)
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
   * A turn the human interrupted (`reason: "user"`) is not continued: the human
   * took over, and `/goal resume` starts the next round. Its usage was already
   * folded by the accounting module from the durable step events.
   */
  async onTurnFinished(
    sessionID: string,
    directory: string,
    reason?: string,
    error?: unknown,
    durableSeq?: number,
  ): Promise<void> {
    if (this.alreadyFoldedTurn(sessionID, durableSeq)) return
    if (this.inflight.has(sessionID) || this.forgotten.has(sessionID)) return
    const run = this.finish(sessionID, directory, reason, error).catch((error: unknown) => {
      this.hooks.log(`goal round failed: ${error instanceof Error ? error.message : String(error)}`, { sessionID })
    })
    // claim the session synchronously so a burst of completion events cannot
    // double-drive it while the finished turn is being handled
    this.inflight.set(sessionID, run)
    try {
      await run
    } finally {
      this.inflight.delete(sessionID)
    }
  }

  /**
   * Highest durable turn-completion sequence folded per session.
   *
   * Turn-completion events are durable, and a durable stream is delivered at
   * least once: a reconnect replays what this process already handled. Without
   * this, each replay releases a round that is not in flight and admits another
   * one, so a goal can burn its whole cap in a reconnect. Accounting already
   * deduped its own fold this way; the driver did not, which is the same
   * failure on the other side of the seam.
   *
   * Keyed by session rather than by aggregate because the completion event's
   * `durable.aggregateID` is the session, and bounded by the session count the
   * same way `forget` bounds everything else.
   */
  private readonly foldedTurnSeq = new Map<string, number>()

  /**
   * Whether one turn-completion event has already been acted on.
   *
   * An event with no sequence is folded anyway rather than dropped: durable
   * events carry one, so an event without it is one this build has not met, and
   * dropping it would lose a completed turn — the loop would stall silently,
   * which is worse than admitting a round twice.
   */
  private alreadyFoldedTurn(sessionID: string, durableSeq: number | undefined): boolean {
    if (durableSeq === undefined) return false
    const folded = this.foldedTurnSeq.get(sessionID)
    if (folded !== undefined && durableSeq <= folded) return true
    this.foldedTurnSeq.set(sessionID, durableSeq)
    return false
  }

  /** Drop every trace of a deleted session so stale state cannot leak. */
  forget(sessionID: string): void {
    this.forgotten.add(sessionID)
    this.started.delete(sessionID)
    this.roundsInFlight.delete(sessionID)
    this.inflight.delete(sessionID)
    this.foldedTurnSeq.delete(sessionID)
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
    await this.drive(store, sessionID, directory)
  }

  /** Finish one turn reported through the execution events. */
  private async finish(sessionID: string, directory: string, reason?: string, error?: unknown): Promise<void> {
    const store = this.storeFor(directory)
    // the turn that was in flight is over: release the round before admitting
    // the next one, whether or not this session's turn is admitted again
    this.releaseRound(sessionID, directory)
    if (reason === 'user') {
      this.hooks.log('goal round interrupted by the user; waiting for a human turn', { sessionID })
      return
    }
    // A provider refusal stops the goal durably, with the reason recorded. It
    // used to disarm the goal instead, which left it reading `active` in the log
    // with nothing saying why it had gone quiet, and a restart re-armed it into
    // the same refusal.
    const stop = providerStopReason(error)
    if (stop !== undefined) {
      if (stopGoal(store, stop)) {
        this.hooks.log(`goal blocked: ${stop.code}`, { sessionID, directory })
      } else {
        this.hooks.log('goal provider stop skipped: another writer moved the goal', { sessionID })
      }
      return
    }
    await this.drive(store, sessionID, directory)
  }

  /**
   * Admit the next round through the shared admission seam and submit its
   * prompt. Everything this method does that admission does not — claiming the
   * session, submitting the prompt, disarming on a provider error, reporting —
   * is adapter work, and it is the only reason this method exists.
   */
  private async drive(store: GoalStore, sessionID: string, directory: string): Promise<void> {
    // One round at a time per session: opencode coalesces a prompt submitted
    // mid-turn, so a second admission would burn a round for no work. This is
    // deliberately NOT unified with the human command plane's equivalent check.
    // The server knows from its event stream whether a round is in flight,
    // because it is the one that submitted the prompt that started it; the
    // command plane asks the UI whether a turn is active, because it is the one
    // holding the UI. Neither can answer the other's question, and pretending
    // otherwise would need a shared turn registry neither entry point owns.
    if (this.roundsInFlight.has(sessionID)) return

    const verdict = admitRound(store)
    if (verdict.kind === 'rejected') {
      // not-active, disarmed, waiting and stale-ref are all "nothing to do":
      // admission is re-evaluated at the next trigger, so silence is correct
      return
    }
    if (verdict.kind === 'blocked') {
      this.hooks.log(`goal blocked: ${verdict.reason.code}`, { sessionID })
      return
    }

    const goal = store.view()
    if (goal === undefined) return
    const round = verdict.round
    const text = renderGoalRoundPrompt(goal, round)

    // the round is in flight until its turn reports back through the execution
    // events; the project is claimed for this session meanwhile so a second
    // session opening defers instead of racing the same goal
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
        this.releaseRound(sessionID, directory)
        // a provider refusal on submission is the same stop the turn-completion
        // event would have reported, so it is classified the same way
        const stop = providerStopReason(error)
        if (stop !== undefined) {
          if (stopGoal(store, stop)) {
            this.hooks.log(`goal blocked: ${stop.code}`, { goalID: goal.id, round })
          }
          return
        }
        // anything else is transient: disarm so the next human turn decides
        store.activation = 'disarmed'
      })
  }

  /**
   * Whether the turn now running in a session is one this plugin submitted a
   * continuation prompt for — a goal round, as opposed to a human turn.
   *
   * `roundsInFlight` is exactly that set: a session enters it when a round's
   * prompt is submitted and leaves when the turn reports back. Accounting asks
   * this so a human's question is not charged to the goal's round budget or its
   * token budget, and so a human's rephrasing does not read as progress.
   *
   * The command plane cannot answer this and the server can, for the same reason
   * given in `drive()`: the server is the one that submitted the prompt.
   */
  isGoalTurn(sessionID: string): boolean {
    return this.roundsInFlight.has(sessionID)
  }

  /** Release the in-flight round of one session (its turn ended or failed). */
  private releaseRound(sessionID: string, directory: string): void {
    this.roundsInFlight.delete(sessionID)
    if (this.running.get(directory) === sessionID) this.running.delete(directory)
  }
}
