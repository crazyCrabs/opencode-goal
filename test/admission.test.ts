import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { admitRound, type AdmissionVerdict } from '../src/admission.ts'
import { GoalStore } from '../src/state.ts'
import type { GoalView } from '../src/types.ts'

/**
 * Every test here crosses `admitRound` and nothing else. If a test needs to
 * reach past the seam to set up its case, the seam is the wrong shape.
 */
function activeGoal(maxGoalRounds = 25, tokenBudget = 0): GoalStore {
  const store = new GoalStore(mkdtempSync(join(tmpdir(), 'goal-admission-')))
  store.create('admission objective', maxGoalRounds, tokenBudget)
  return store
}

describe('admission admits', () => {
  test('an active armed goal with no guardrail tripped is admitted', () => {
    const store = activeGoal()
    const before = store.view()!.roundsStarted
    const verdict = admitRound(store)
    expect(verdict).toEqual({ kind: 'admitted', round: before + 1 })
    expect(store.view()!.roundsStarted).toBe(before + 1)
  })

  test('the admitted round is the one the durable log now records', () => {
    const store = activeGoal()
    const verdict = admitRound(store) as { kind: 'admitted'; round: number }
    expect(store.view()!.roundsStarted).toBe(verdict.round)
  })
})

describe('admission rejects', () => {
  test('no goal at all is not-active', () => {
    const store = new GoalStore(mkdtempSync(join(tmpdir(), 'goal-admission-none-')))
    expect(admitRound(store)).toEqual({ kind: 'rejected', code: 'not-active' })
  })

  test('a paused goal is not-active', () => {
    const store = activeGoal()
    store.pause({ id: store.view()!.id, revision: store.view()!.revision })
    expect(admitRound(store)).toEqual({ kind: 'rejected', code: 'not-active' })
  })

  test('a blocked goal is not-active', () => {
    const store = activeGoal(1)
    expect(admitRound(store).kind).toBe('admitted') // round 1
    expect(admitRound(store).kind).toBe('blocked') // the cap
    // the goal is now durably blocked, so there is nothing left to admit
    expect(admitRound(store)).toEqual({ kind: 'rejected', code: 'not-active' })
  })

  test('a goal this store never mutated is disarmed', () => {
    // a goal that merely survived a restart: the store came alive beside it and
    // nothing has touched it since, so it waits for an explicit resume
    const directory = mkdtempSync(join(tmpdir(), 'goal-admission-survivor-'))
    const yesterday = new GoalStore(directory)
    yesterday.create('survivor objective', 25, 0)

    const today = new GoalStore(directory)
    expect(today.view()?.activation).toBe('disarmed')
    expect(admitRound(today)).toEqual({ kind: 'rejected', code: 'disarmed' })
  })

  test('arming the store admits the round, which is what a resume or a session opening does', () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-admission-arm-'))
    new GoalStore(directory).create('survivor objective', 25, 0)
    const today = new GoalStore(directory)
    today.activation = 'armed'
    expect(admitRound(today)).toEqual({ kind: 'admitted', round: 1 })
  })

  test('an external wait whose deadline is still in the future is waiting', () => {
    const store = activeGoal()
    store.wait({ id: store.view()!.id, revision: store.view()!.revision }, 'waiting for CI', 60_000)
    expect(admitRound(store)).toEqual({ kind: 'rejected', code: 'waiting' })
    expect(store.view()!.roundsStarted).toBe(0) // nothing was admitted
  })
})

/** Append an expired external wait, written as another writer would write it. */
function appendExpiredWait(directory: string, goal: GoalView, reason: string): void {
  mkdirSync(`${directory}/.opencode`, { recursive: true })
  appendFileSync(
    `${directory}/.opencode/goal-log.jsonl`,
    `${JSON.stringify({
      kind: 'goal/change',
      version: 1,
      operation: 'wait',
      goal: { ...goal, revision: goal.revision + 1, waitUntil: Date.now() - 1000, waitReason: reason },
    })}
`,
  )
}

/**
 * A goal whose external-wait deadline has already passed, held by the store that
 * made the create and has since adopted another writer's wait.
 *
 * The deadline is written into the durable log rather than set on the store
 * because the wait is durable now: `wait()` clamps a present deadline to at least
 * 10s out, so a passed deadline is exactly the state only an older log line can
 * express. Adoption is what arms this store, which is also the only way an
 * expired wait is reachable in production.
 */
function expiredWaiter(reason = 'waiting for CI'): GoalStore {
  const directory = mkdtempSync(join(tmpdir(), 'goal-admission-expired-'))
  const store = new GoalStore(directory)
  store.create('objective', 25, 0)
  appendExpiredWait(directory, store.view()!, reason)
  store.sync()
  return store
}

/** The same goal, but in a store born after both mutations — the disarmed restart. */
function disarmedExpiredWaiter(reason = 'waiting for CI'): GoalStore {
  const directory = mkdtempSync(join(tmpdir(), 'goal-admission-expired-dis-'))
  const first = new GoalStore(directory)
  first.create('objective', 25, 0)
  appendExpiredWait(directory, first.view()!, reason)
  return new GoalStore(directory)
}

describe('an expired external wait', () => {
  test('stops the goal rather than resuming it blind', () => {
    // Clearing and admitting the next round would resume the goal into the thing
    // it could not wait for, and it would spend a round re-discovering the same
    // impasse. So it stops, carrying the wait's own reason.
    const store = expiredWaiter()
    expect(admitRound(store)).toEqual({
      kind: 'blocked',
      reason: {
        code: 'wait-expired',
        message:
          'Goal stopped: its external wait deadline passed with nothing arriving to wake it. It was waiting for: waiting for CI',
      },
    })
    expect(store.view()!.phase).toBe('blocked')
    expect(store.view()!.blockedReason?.code).toBe('wait-expired')
  })

  test('the wait reason reaches the block reason, so the record says what was waited for', () => {
    const store = expiredWaiter('a review from the platform team')
    const verdict = admitRound(store)
    expect(verdict.kind).toBe('blocked')
    if (verdict.kind !== 'blocked') return
    expect(verdict.reason.message).toContain('a review from the platform team')
  })

  test('a wait with no recorded reason still stops the goal', () => {
    const store = expiredWaiter('')
    const verdict = admitRound(store)
    expect(verdict.kind).toBe('blocked')
    if (verdict.kind !== 'blocked') return
    expect(verdict.reason.message).toBe(
      'Goal stopped: its external wait deadline passed with nothing arriving to wake it.',
    )
  })

  test('is stopped by one policy, whichever entry point asks', () => {
    // This is the drift ticket 12 named: the human command plane used to check
    // the future deadline and return, and never clear it, so a goal whose
    // deadline had passed sat quiet forever with nothing recording why. Both
    // entry points now cross the same seam, so there is one decision about what
    // an expired wait means, and it is the same decision from either side.
    const store = expiredWaiter()
    expect(admitRound(store).kind).toBe('blocked')
    // a second admission finds a blocked goal, so there is nothing left to decide
    expect(admitRound(store)).toEqual({ kind: 'rejected', code: 'not-active' })
  })
})

describe('admission blocks', () => {
  test('a reached round cap blocks with round-limit', () => {
    const store = activeGoal(1)
    expect(admitRound(store)).toEqual({ kind: 'admitted', round: 1 })
    expect(admitRound(store)).toEqual({
      kind: 'blocked',
      reason: { code: 'round-limit', message: 'Goal reached its configured limit of 1 rounds.' },
    })
    expect(store.view()!.phase).toBe('blocked')
  })

  test('a reached token budget blocks with budget-limited', () => {
    const store = activeGoal(25, 10)
    store.addUsage({ inputTokens: 10, outputTokens: 0, cost: 0 })
    const verdict = admitRound(store)
    expect(verdict.kind).toBe('blocked')
    expect((verdict as { reason: { code: string } }).reason.code).toBe('budget-limited')
  })

  test('three identical rounds block with no-progress', () => {
    const store = activeGoal()
    // two identical rounds are not yet a stall: the third one is
    store.recordRoundOutput('the same answer')
    expect(admitRound(store).kind).toBe('admitted')
    store.recordRoundOutput('the same answer')
    expect(admitRound(store).kind).toBe('admitted')
    store.recordRoundOutput('the same answer')
    const verdict = admitRound(store)
    expect(verdict).toEqual({
      kind: 'blocked',
      reason: {
        code: 'no-progress',
        message: 'Goal blocked: three consecutive goal rounds produced empty or identical output.',
      },
    })
    expect(store.view()!.phase).toBe('blocked')
  })
})

/** A second writer on the same log, which is what the server driver is to the TUI. */
function rivalWriter(directory: string): GoalStore {
  return new GoalStore(directory)
}

describe('a goal another writer moved', () => {
  /**
   * The drift ticket 12 named. The human command plane used to read a view once
   * and then act on it — `store.block({ id: goal.id, revision: goal.revision })`
   * with the ref from the top of the function — and the server driver runs in
   * its own process writing the same log, so a mutation landing between those
   * two moments made the mutation throw. In an async command handler that
   * escaped as an unhandled rejection.
   *
   * The seam closes it by reading and committing back to back, so the ref it
   * acts on is the one it just read.
   */
  test('the legacy pattern throws; the seam does not', () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-admission-drift-'))
    const store = new GoalStore(directory)
    store.create('objective', 25, 0)
    const stale = store.view()!

    // the server driver, in its own process, admits a round behind this back
    rivalWriter(directory).continue({ id: stale.id, revision: stale.revision })

    // what the command plane used to do: act on the view it read at the top
    expect(() =>
      store.block({ id: stale.id, revision: stale.revision }, { code: 'no-progress', message: 'stalled' }),
    ).toThrow()

    // the seam re-reads, so it judges the goal's real state instead of a stale
    // view's, and it answers rather than throwing
    expect(admitRound(store)).toEqual({ kind: 'admitted', round: 2 })
  })

  test('the seam never acts on a view it read before another writer moved', () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-admission-double-'))
    const store = new GoalStore(directory)
    store.create('objective', 25, 0)
    const stale = store.view()!

    // another writer admits the round this caller was about to admit
    rivalWriter(directory).continue({ id: stale.id, revision: stale.revision })

    // the goal's real state is one round in, so the seam admits round 2 rather
    // than a second round 1 — no double admission
    const verdict = admitRound(store)
    expect(verdict).toEqual({ kind: 'admitted', round: 2 })
    expect(store.view()!.roundsStarted).toBe(2)
  })

  test('a goal another writer advanced to its cap is blocked on its real state', () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-admission-cap-'))
    const store = new GoalStore(directory)
    store.create('objective', 1, 0)
    const stale = store.view()!

    rivalWriter(directory).continue({ id: stale.id, revision: stale.revision })

    // this caller's stale view says the cap is not reached; the goal's real
    // state says it is, and the seam judges the real state
    expect(admitRound(store)).toEqual({
      kind: 'blocked',
      reason: { code: 'round-limit', message: 'Goal reached its configured limit of 1 rounds.' },
    })
    expect(store.view()!.phase).toBe('blocked')
  })

  /**
   * `stale-ref` covers the window that remains: a writer moving the goal between
   * the seam's own read and its commit. That window is real — the two entry
   * points are separate processes on one log — but it is narrower than a
   * synchronous test can open, so it is covered by "no path throws" below
   * rather than by a fabricated race.
   */
  test('no path through the seam throws', () => {
    const store = activeGoal()
    const verdicts: AdmissionVerdict[] = []
    for (let i = 0; i < 5; i++) verdicts.push(admitRound(store))
    expect(verdicts.length).toBe(5)
    // every call answered, including the ones the guardrails rejected
    expect(verdicts.every(v => v.kind === 'admitted' || v.kind === 'blocked' || v.kind === 'rejected')).toBe(true)
  })
})

describe('the order of the checks is policy', () => {
  test('a paused goal is not-active even when it is also disarmed', () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-admission-order-'))
    const writer = new GoalStore(directory)
    writer.create('objective', 25, 0)
    writer.pause({ id: writer.view()!.id, revision: writer.view()!.revision })
    const reader = new GoalStore(directory)
    expect(reader.view()?.activation).toBe('disarmed')
    expect(admitRound(reader)).toEqual({ kind: 'rejected', code: 'not-active' })
  })

  test('a waiting goal is rejected before its guardrails are evaluated', () => {
    const store = activeGoal(1)
    store.wait({ id: store.view()!.id, revision: store.view()!.revision }, 'waiting', 60_000)
    // the cap is not reached, so only the wait can reject this
    expect(admitRound(store)).toEqual({ kind: 'rejected', code: 'waiting' })
    expect(store.view()!.phase).toBe('active')
  })

  test('a disarmed goal is rejected before an expired wait is stopped', () => {
    // A store this process has not mutated stays disarmed, and a durable wait is
    // exactly what such a store can be holding — so the ordering matters now in a
    // way it did not when the wait lived only in the process that set it.
    const store = disarmedExpiredWaiter()
    expect(admitRound(store)).toEqual({ kind: 'rejected', code: 'disarmed' })
    expect(store.view()!.phase).toBe('active') // nothing was decided about the wait
    expect(store.waitUntil).toBeGreaterThan(0)
  })
})
