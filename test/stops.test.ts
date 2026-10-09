import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { admitRound, stopGoal } from '../src/admission.ts'
import { blockTier, providerStopReason, TRANSPORT_FAILURE_LIMIT, transportFailureReason } from '../src/round-policy.ts'
import { GoalStore } from '../src/state.ts'
import type { GoalPhase } from '../src/types.ts'

/**
 * The refusal below is a recorded live payload, not an invented one:
 * `{ type: "provider.auth", message: "...", status: 403 }` from a turn the
 * provider refused for a missing subscription.
 */
const LIVE_REFUSAL = {
  type: 'provider.auth',
  message: 'Upstream request failed: An active OpenCode Go subscription is required to use Go models.',
  status: 403,
}

function activeGoal(maxGoalRounds = 25, tokenBudget = 0): GoalStore {
  const store = new GoalStore(mkdtempSync(join(tmpdir(), 'goal-stops-')))
  store.create('stops objective', maxGoalRounds, tokenBudget)
  return store
}

describe('the phase set', () => {
  test('is exactly four phases, so growing it becomes a deliberate act', () => {
    // The set is a decision, not an accident of what the code happens to write:
    // `unmet` ("tried and failed") was considered and rejected. This asserts the
    // decision so adding a phase cannot happen quietly.
    const phases: readonly GoalPhase[] = ['active', 'paused', 'blocked', 'complete']
    expect(phases.length).toBe(4)
    // and the store can reach every one of them
    const store = activeGoal()
    expect(store.view()!.phase).toBe('active')
    store.pause({ id: store.view()!.id, revision: store.view()!.revision })
    expect(store.view()!.phase).toBe('paused')
    store.resume({ id: store.view()!.id, revision: store.view()!.revision })
    expect(store.view()!.phase).toBe('active')
    store.block({ id: store.view()!.id, revision: store.view()!.revision }, { code: 'model-reported', message: 'a human decision is needed' })
    expect(store.view()!.phase).toBe('blocked')
  })

  test('every system stop is a code inside the blocked phase, not a separate phase', () => {
    // one goal, stopped four different ways by the system; each is a code
    const cap = activeGoal(1)
    admitRound(cap)
    expect(admitRound(cap).kind).toBe('blocked')

    const budget = activeGoal(25, 10)
    budget.addUsage({ inputTokens: 10, outputTokens: 0, cost: 0 })
    expect(admitRound(budget).kind).toBe('blocked')

    const stalled = activeGoal()
    for (let i = 0; i < 3; i++) stalled.recordRoundOutput('same')
    expect(admitRound(stalled).kind).toBe('blocked')

    const refused = activeGoal()
    expect(stopGoal(refused, providerStopReason(LIVE_REFUSAL)!)).toBe(true)

    for (const store of [cap, budget, stalled, refused]) {
      expect(store.view()!.phase).toBe('blocked')
      expect(store.view()!.blockedReason?.code).toBeDefined()
    }
    // and the four are told apart by one field each
    const codes = [cap, budget, stalled, refused].map(store => store.view()!.blockedReason?.code)
    expect(codes).toEqual(['round-limit', 'budget-limited', 'no-progress', 'usage-limited'])
    expect(new Set(codes).size).toBe(4)
  })
})

describe('a provider refusal', () => {
  test('the recorded 403 is classified as a stop', () => {
    const reason = providerStopReason(LIVE_REFUSAL)
    expect(reason).toBeDefined()
    expect(reason!.code).toBe('usage-limited')
    expect(reason!.message).toContain('HTTP 403')
    expect(reason!.message).toContain('OpenCode Go subscription')
  })

  test('a rate limit is the same stop as a quota refusal', () => {
    const reason = providerStopReason({ type: 'provider.rate', message: 'too many requests', status: 429 })
    expect(reason?.code).toBe('usage-limited')
    expect(reason?.message).toContain('HTTP 429')
  })

  test('auth and payment refusals stop too, because only a human can fix them', () => {
    for (const status of [401, 402, 408]) {
      expect(providerStopReason({ type: 'provider.auth', message: 'nope', status })?.code).toBe('usage-limited')
    }
  })

  test('a transient failure is not a stop, so the goal may carry on', () => {
    // a 500 or a dropped connection is retryable; stopping a goal for one would
    // lose work the next attempt would have finished
    expect(providerStopReason({ type: 'server', message: 'internal', status: 500 })).toBeUndefined()
    expect(providerStopReason({ type: 'network', message: 'ECONNRESET' })).toBeUndefined()
    expect(providerStopReason(undefined)).toBeUndefined()
    expect(providerStopReason(null)).toBeUndefined()
    expect(providerStopReason('a bare string')).toBeUndefined()
  })

  test('a provider-family error with no status is still a stop', () => {
    const reason = providerStopReason({ type: 'provider.auth', message: 'no credentials' })
    expect(reason?.code).toBe('usage-limited')
    expect(reason?.message).toContain('provider.auth')
  })

  test('an untyped error with no status is not classifiable and is left alone', () => {
    expect(providerStopReason({ message: 'something broke' })).toBeUndefined()
  })

  test('a thrown Error is read through the same shape', () => {
    // the command plane passes whatever a failed prompt submission threw
    const thrown = Object.assign(new Error('Upstream request failed: quota'), { status: 403 })
    expect(providerStopReason(thrown)?.code).toBe('usage-limited')
  })
})

describe('a stop is durable, not process-local', () => {
  test('a provider stop survives a restart and says why', () => {
    // This is the whole point of the ticket. The refusal used to set the
    // process-local `activation` to `disarmed`, which left the goal reading
    // `active` in the log with nothing recording the reason, and a restart
    // re-armed it straight back into the same refusal.
    const directory = mkdtempSync(join(tmpdir(), 'goal-stops-durable-'))
    const writer = new GoalStore(directory)
    writer.create('durable objective', 25, 0)
    expect(stopGoal(writer, providerStopReason(LIVE_REFUSAL)!)).toBe(true)

    // a fresh process reads the same log
    const reader = new GoalStore(directory)
    const view = reader.view()!
    expect(view.phase).toBe('blocked')
    expect(view.blockedReason?.code).toBe('usage-limited')
    expect(view.blockedReason?.message).toContain('OpenCode Go subscription')
    // and it stays stopped: a fresh process does not re-arm a blocked goal
    expect(reader.view()?.activation).toBe('disarmed')
    expect(admitRound(reader)).toEqual({ kind: 'rejected', code: 'not-active' })
  })

  test('a stopped goal is distinguishable from every other kind of stop', () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-stops-tell-apart-'))
    const store = new GoalStore(directory)
    store.create('objective', 25, 0)
    stopGoal(store, providerStopReason(LIVE_REFUSAL)!)
    const stopped = store.view()!

    const finished = activeGoal()
    finished.complete(
      { id: finished.view()!.id, revision: finished.view()!.revision },
      {
        summary: 'the objective is achieved',
        criteria: [{ criterion: 'the thing', evidence: ['bun test passed'] }],
        checks: [{ command: 'bun test', result: 'passed', exitCode: 0 }],
      },
    )
    const impasse = activeGoal()
    impasse.block(
      { id: impasse.view()!.id, revision: impasse.view()!.revision },
      { code: 'model-reported', message: 'waiting on a human decision' },
    )
    const budget = activeGoal(25, 1)
    budget.addUsage({ inputTokens: 1, outputTokens: 0, cost: 0 })
    admitRound(budget)

    // four outcomes, one field each
    expect(stopped.phase).toBe('blocked')
    expect(stopped.blockedReason?.code).toBe('usage-limited')
    expect(finished.view()!.phase).toBe('complete')
    expect(impasse.view()!.blockedReason?.code).toBe('model-reported')
    expect(budget.view()!.blockedReason?.code).toBe('budget-limited')
  })

  test('stopping a goal that is not active does nothing', () => {
    const store = activeGoal()
    store.pause({ id: store.view()!.id, revision: store.view()!.revision })
    expect(stopGoal(store, providerStopReason(LIVE_REFUSAL)!)).toBe(false)
    expect(store.view()!.phase).toBe('paused')
  })

  test('a stop that loses a race with another writer does not throw', () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-stops-race-'))
    const store = new GoalStore(directory)
    store.create('objective', 25, 0)
    const stale = store.view()!
    // another writer blocks the goal behind this store's back
    const rival = new GoalStore(directory)
    rival.block({ id: stale.id, revision: stale.revision }, { code: 'no-progress', message: 'stalled' })
    expect(stopGoal(store, providerStopReason(LIVE_REFUSAL)!)).toBe(false)
    // and the rival's stop is the one that stands
    expect(store.view()!.blockedReason?.code).toBe('no-progress')
  })
})

describe('a transport failure is not a refusal', () => {
  // The recorded DNS failure: `provider.transport`, no status, and a message that
  // names the resolver. The provider never answered, so there is no refusal.
  const LIVE_DNS_FAILURE = {
    type: 'provider.transport',
    message: 'getaddrinfo ENOTFOUND api.stepfun.com',
  }

  test('the recorded DNS failure is not a stop', () => {
    expect(providerStopReason(LIVE_DNS_FAILURE)).toBeUndefined()
  })

  test('the recorded 403 still is one', () => {
    // the two shapes must not collapse: a subscription problem and a dead network
    // need different human action
    const reason = providerStopReason(LIVE_REFUSAL)
    expect(reason?.code).toBe('usage-limited')
    expect(reason?.message).toContain('OpenCode Go subscription')
  })

  test('every connection-level marker is ridden out', () => {
    for (const marker of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'socket hang up', 'fetch failed']) {
      expect(providerStopReason({ type: 'provider.whatever', message: `upstream: ${marker}` })).toBeUndefined()
    }
  })

  test('a status in the refusal set still stops, whatever the message says', () => {
    // a 403 whose message happens to mention the network is still a refusal: the
    // status is the provider answering, and it answered no
    expect(providerStopReason({ type: 'provider.auth', message: 'ECONNRESET while reading the body', status: 403 })?.code)
      .toBe('usage-limited')
  })

  test('a non-refusal status is still left alone', () => {
    expect(providerStopReason({ type: 'provider.transport', message: 'boom', status: 500 })).toBeUndefined()
  })

  test('a sustained outage stops with a code that names the network', () => {
    const reason = transportFailureReason(TRANSPORT_FAILURE_LIMIT, LIVE_DNS_FAILURE.message)
    expect(reason.code).toBe('provider-unavailable')
    expect(reason.message).toContain('getaddrinfo ENOTFOUND')
    expect(reason.message).toContain('never arrived')
    // and it must not read as a refusal: the provider never answered, so there is
    // nothing it could have refused. The word "subscription" does appear, but only
    // to rule that diagnosis out — which is the point of a separate code.
    expect(reason.message).not.toContain('refused')
    expect(reason.message).not.toContain('HTTP')
  })

  test('provider-unavailable is arithmetic: a fact, not a judgment', () => {
    expect(blockTier('provider-unavailable')).toBe('arithmetic')
  })

  test('the two error shapes are told apart by the classifier alone', () => {
    const dns = providerStopReason(LIVE_DNS_FAILURE)
    const refused = providerStopReason(LIVE_REFUSAL)
    expect(dns).toBeUndefined()
    expect(refused).toBeDefined()
  })
})
