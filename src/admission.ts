/**
 * Round admission: the one place that decides whether a goal round may start,
 * and commits that decision.
 *
 * Both entry points cross this seam. The autonomous driver admits the round
 * after a finished turn; the human `/goal` command plane admits the first round
 * after a create, edit or resume. Before this module existed they each carried
 * their own copy of the policy, and the copies had drifted in two ways that
 * mattered: the command plane let a lost compare-and-set race escape as an
 * unhandled rejection, and it never cleared an expired external wait, so a goal
 * whose deadline had passed sat quiet forever with nothing recording why.
 *
 * The seam is a single function that takes an already-resolved store. It names
 * no caller, because both callers run identical policy. What each caller knows
 * that the other does not — a session id, a directory, whether a turn is
 * running, how to submit a prompt, how to report — stays at the caller.
 *
 * The store is the only shared source of truth: every mutation here is a
 * synchronous append that is durable when it returns, and every read re-folds
 * the log first. So admission is single-phase. The reference architecture's
 * two-phase reserve/await/re-check/race-fence protocol is deliberately not
 * reproduced — it exists to coordinate a reservation across processes, and a
 * synchronous durable append plus a compare-and-set already gives that.
 */

import type { GoalStore } from './state.ts'
import type { GoalBlockReason } from './types.ts'
import { gateBlock, goalBlockReason } from './round-policy.ts'

/**
 * What admission decided. `admitted` means the round is committed and the caller
 * may submit its prompt; `blocked` means the goal was stopped with the reason;
 * `rejected` means nothing was admitted and the caller should do nothing.
 */
export type AdmissionVerdict =
  | { kind: 'admitted'; round: number }
  | { kind: 'blocked'; reason: GoalBlockReason }
  | { kind: 'rejected'; code: 'not-active' | 'disarmed' | 'stale-ref' | 'waiting' | 'judgment-pending' }

/**
 * Decide whether one more round may be admitted, and commit the decision.
 *
 * The checks run in this order, which is policy rather than accident:
 *
 * 1. **Not active.** A missing, paused, blocked or complete goal has no round to
 *    admit. Checked first so a caller cannot act on a stale view.
 * 2. **Disarmed.** Activation is process-local: a store that came alive beside a
 *    goal it never mutated does not drive it, so a goal that merely survived a
 *    restart waits for an explicit resume or a session opening. A caller that
 *    mutates the goal (a create, edit or resume) arms its own store first, so
 *    this rejects only a goal nobody has touched.
 * 3. **Waiting.** An external wait whose deadline is still in the future
 *    suppresses continuation. One whose deadline has passed stops the goal with
 *    `wait-expired` rather than resuming it blind. Both halves live in this one
 *    policy, which is what stops the two entry points disagreeing about whether
 *    a wait ended and what ending it means.
 * 4. **Guardrails.** A breach stops the goal with a reason, unless the breach
 *    is a judgment that has not yet persisted, in which case the round runs
 *    anyway — "not yet" is an instruction to keep going, not a verdict. A lost
 *    race with another writer is reported as `stale-ref` rather than thrown,
 *    because the other writer's round is the one that runs.
 * 5. **Admit.** The compare-and-set is the stale-turn guard: a caller holding a
 *    view from before another writer's mutation is rejected rather than
 *    double-admitting a round.
 */
export function admitRound(store: GoalStore): AdmissionVerdict {
  const goal = store.view()
  if (goal === undefined || goal.phase !== 'active') {
    return { kind: 'rejected', code: 'not-active' }
  }
  if (goal.activation !== 'armed') {
    return { kind: 'rejected', code: 'disarmed' }
  }

  // External wait: quiet until the deadline passes, and then stopped rather than
  // resumed. The wait is durable now, so a fresh process reads the same deadline
  // and reaches the same verdict — which is the point, because the alternative
  // was a restart forgetting the wait and running straight on into whatever the
  // goal had been waiting for.
  if (store.waitUntil > 0) {
    if (store.waitUntil > Date.now()) {
      return { kind: 'rejected', code: 'waiting' }
    }
    // The deadline passed with nothing having arrived. Clearing and admitting the
    // next round would resume the goal blind into the thing it could not wait for,
    // and it would spend a round re-discovering the same impasse. So it stops,
    // carrying the wait's own reason. This is arithmetic-tier: a deadline that has
    // passed is a fact about what happened, not a claim to challenge.
    const expired = store.waitReason
    const reason: GoalBlockReason = {
      code: 'wait-expired',
      message: expired === undefined || expired.trim().length === 0
        ? 'Goal stopped: its external wait deadline passed with nothing arriving to wake it.'
        : `Goal stopped: its external wait deadline passed with nothing arriving to wake it. It was waiting for: ${expired}`,
    }
    try {
      store.block({ id: goal.id, revision: goal.revision }, reason)
    } catch {
      return { kind: 'rejected', code: 'stale-ref' }
    }
    return { kind: 'blocked', reason }
  }

  // A round boundary, crossed only once the goal is actually going to run a
  // round: the round that just ended either carried the model's own judgment or
  // it did not, and that is what makes the judgment streak consecutive rather
  // than a lifetime tally. It lives here because both entry points admit through
  // this seam, so neither can reset a streak the other is counting, and because
  // a goal that is waiting has run no round and so must not cross a boundary.
  store.endJudgmentRound()

  const blockReason = goalBlockReason(store, goal)
  if (blockReason !== undefined) {
    // the tier decides whether this reason stops the goal now or is challenged
    const gated = gateBlock(store, blockReason)
    if (gated === undefined) {
      // a judgment that has not yet persisted. Not "never": the round runs, and
      // the next observation of the same condition is what decides.
      return { kind: 'rejected', code: 'judgment-pending' }
    }
    // block-on-breach, tolerating a lost race: another writer may have admitted
    // a round (or blocked the goal) between this caller's view and now
    try {
      store.block({ id: goal.id, revision: goal.revision }, gated)
    } catch {
      return { kind: 'rejected', code: 'stale-ref' }
    }
    return { kind: 'blocked', reason: gated }
  }

  const round = goal.roundsStarted + 1
  try {
    store.continue({ id: goal.id, revision: goal.revision })
  } catch {
    // another writer won the compare-and-set race: its round is the one that
    // runs here, so this caller stays out of the way rather than erroring
    return { kind: 'rejected', code: 'stale-ref' }
  }
  return { kind: 'admitted', round }
}

/**
 * Stop the goal with a reason, tolerating a lost race with another writer.
 * Returns whether this writer's stop landed.
 *
 * The sibling of the block-on-breach inside `admitRound`, for stops that come
 * from outside admission: a provider refusal reported on a failed turn. It lives
 * here rather than at each entry point for the same reason admission does — both
 * entry points must stop a goal the same way, and the alternative is the drift
 * that produced two copies of the admission policy in the first place.
 */
export function stopGoal(store: GoalStore, reason: GoalBlockReason): boolean {
  const goal = store.view()
  if (goal === undefined || goal.phase !== 'active') return false
  try {
    store.block({ id: goal.id, revision: goal.revision }, reason)
    return true
  } catch {
    // another writer moved the goal between this read and this commit
    return false
  }
}
