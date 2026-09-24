import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { admitRound } from '../src/admission.ts'
import { JUDGMENT_ROUNDS, blockTier, gateBlock } from '../src/round-policy.ts'
import { GoalStore } from '../src/state.ts'
import type { GoalBlockCode } from '../src/types.ts'

function activeGoal(maxGoalRounds = 25, tokenBudget = 0): GoalStore {
  const store = new GoalStore(mkdtempSync(join(tmpdir(), 'goal-gate-')))
  store.create('gate objective', maxGoalRounds, tokenBudget)
  return store
}

/** Take one round through the admission seam, as both entry points do. */
function admit(store: GoalStore): ReturnType<typeof admitRound> {
  return admitRound(store)
}

describe('the gate is by tier, not per code', () => {
  test('every block code has a tier, and the two tiers partition the set', () => {
    // A code outside the union cannot reach `blockTier`, so this list is the
    // whole set. Adding a code without placing it is a compile error, which is
    // the point: the tier is a decision someone has to make.
    const codes: readonly GoalBlockCode[] = [
      'model-reported',
      'no-progress',
      'round-limit',
      'budget-limited',
      'usage-limited',
      'wait-expired',
    ]
    const tiers = codes.map(blockTier)
    expect(tiers).toEqual([
      'judgment', // the model's own claim
      'judgment', // three identical rounds
      'arithmetic', // a cap already reached
      'arithmetic', // a budget already spent
      'arithmetic', // a refusal already returned
      'arithmetic', // a deadline already passed
    ])
    // and the partition is disjoint and total
    expect(new Set(tiers).size).toBe(2)
    expect(tiers.filter(tier => tier === 'judgment')).toHaveLength(2)
    expect(tiers.filter(tier => tier === 'arithmetic')).toHaveLength(4)
  })

  test('a new arithmetic code takes the immediate behaviour', () => {
    // `usage-limited` joined the arithmetic tier in ticket 17 and this is the
    // behaviour it took: first breach, stop.
    const reason = { code: 'usage-limited' as const, message: 'the provider refused the request (HTTP 403)' }
    expect(blockTier('usage-limited')).toBe('arithmetic')
    expect(gateBlock(activeGoal(), reason)).toEqual(reason)
  })

  test('a new judgment code takes the three-round behaviour', () => {
    // `model-reported` joined the judgment tier, so it is challenged instead.
    const reason = { code: 'model-reported' as const, message: 'waiting on a human decision' }
    expect(blockTier('model-reported')).toBe('judgment')
    expect(gateBlock(activeGoal(), reason)).toBeUndefined()
  })
})

describe('the judgment tier: challenged until it persists', () => {
  test('the same impasse survives three identical rounds before it is accepted', () => {
    // This is the tier test, not a per-code test: any judgment condition behaves
    // this way, and `model-reported` is the member that exercises it end to end.
    const store = activeGoal()
    const reason = { code: 'model-reported' as const, message: 'waiting on a human decision' }

    // round 1 reports it: recorded, not accepted
    expect(store.noteJudgment(reason.message)).toBe(false)
    expect(gateBlock(store, reason)).toBeUndefined()
    // a round boundary crossed with no report would reset the count; here the
    // report stands, so the round that ended carried it
    store.endJudgmentRound()

    // round 2 reports the same impasse: still not enough
    expect(store.noteJudgment(reason.message)).toBe(false)
    expect(gateBlock(store, reason)).toBeUndefined()
    store.endJudgmentRound()

    // round 3 reports it again: now it has persisted
    expect(store.noteJudgment(reason.message)).toBe(true)
    expect(gateBlock(store, reason)).toEqual(reason)
  })

  test('the count is consecutive rounds with the same condition, not any judgment block', () => {
    const store = activeGoal()
    store.noteJudgment('waiting on a human decision')
    store.endJudgmentRound()
    store.noteJudgment('waiting on a human decision')
    store.endJudgmentRound()
    // a different obstacle is a different condition: the run resets rather than
    // adding to it, so a model naming a new problem each round never accumulates
    expect(store.noteJudgment('the sandbox has no network')).toBe(false)
    expect(store.judgmentRounds()).toBe(1)
    expect(gateBlock(store, { code: 'model-reported', message: 'the sandbox has no network' })).toBeUndefined()
  })

  test('an impasse that clears on the next round resets the count', () => {
    const store = activeGoal()
    store.noteJudgment('waiting on a human decision')
    store.endJudgmentRound()
    store.noteJudgment('waiting on a human decision')
    store.endJudgmentRound()
    expect(store.judgmentRounds()).toBe(2)

    // the next round reports nothing: the impasse cleared
    store.endJudgmentRound()
    expect(store.judgmentRounds()).toBe(0)
    // so a later report starts from one again rather than from three
    expect(store.noteJudgment('waiting on a human decision')).toBe(false)
    expect(store.judgmentRounds()).toBe(1)
  })

  test('a judgment that has not persisted does not stop the goal, and admission says so', () => {
    // The goal keeps running rather than being told "never". `no-progress` is
    // the member admission itself raises, and it is already a three-round
    // observation, so the gate lets it through on the first breach of its own
    // condition — the tier is about how many rounds the condition took, not
    // about delaying the block once it has taken them.
    const store = activeGoal()
    for (let round = 0; round < JUDGMENT_ROUNDS; round++) {
      store.recordRoundOutput('the same narration every time')
    }
    const verdict = admit(store)
    expect(verdict).toEqual({
      kind: 'blocked',
      reason: {
        code: 'no-progress',
        message: 'Goal blocked: three consecutive goal rounds produced empty or identical output.',
      },
    })
    expect(store.view()!.phase).toBe('blocked')
  })

  test('no-progress before its three rounds is not a judgment block at all', () => {
    // The judgment tier's challenge is upstream of `goalBlockReason`: two
    // identical rounds raise nothing, so there is nothing to gate.
    const store = activeGoal()
    store.recordRoundOutput('the same narration every time')
    store.recordRoundOutput('the same narration every time')
    expect(admit(store).kind).toBe('admitted')
  })
})

describe('the arithmetic tier: stops on the first breach', () => {
  test('the round cap stops on the first breach', () => {
    // The tier test for arithmetic: one breach, one stop, no challenge.
    const store = activeGoal(1)
    expect(admit(store).kind).toBe('admitted')
    expect(admit(store)).toEqual({
      kind: 'blocked',
      reason: { code: 'round-limit', message: 'Goal reached its configured limit of 1 rounds.' },
    })
    expect(store.view()!.phase).toBe('blocked')
  })

  test('the token budget stops on the first breach', () => {
    const store = activeGoal(25, 10)
    store.addUsage({ inputTokens: 9, outputTokens: 0, cost: 0 })
    expect(admit(store).kind).toBe('admitted')
    store.addUsage({ inputTokens: 1, outputTokens: 0, cost: 0 })
    expect(admit(store).kind).toBe('blocked')
    expect(store.view()!.blockedReason?.code).toBe('budget-limited')
  })

  test('the provider quota stops on the first breach', () => {
    const store = activeGoal()
    const reason = { code: 'usage-limited' as const, message: 'Goal stopped: the provider refused the request (HTTP 403)' }
    expect(gateBlock(store, reason)).toEqual(reason)
    // and it reaches the goal through the stop path, not through a challenge
    expect(admitRound(store).kind).toBe('admitted')
  })

  test('gating an arithmetic limit is not implemented anywhere', () => {
    // Not merely unnecessary — wrong. Gating a reached cap would spend rounds
    // proving arithmetic: the goal would run, hit the same cap, be told "not
    // yet", run again, hit it again. Every one of those rounds costs the model
    // tokens and produces nothing, and the cap was never in doubt. The tiers
    // exist to keep the challenge aimed at claims that might be wrong.
    //
    // What this test asserts is that no code path delays an arithmetic block:
    // each arithmetic reason survives `gateBlock` untouched on its first
    // appearance, with no round history required.
    const arithmetic: readonly { code: GoalBlockCode; message: string }[] = [
      { code: 'round-limit', message: 'Goal reached its configured limit of 1 rounds.' },
      { code: 'budget-limited', message: 'Goal reached its token budget of 10 tokens (used 10).' },
      { code: 'usage-limited', message: 'Goal stopped: the provider refused the request (HTTP 403)' },
      { code: 'wait-expired', message: 'Goal stopped: its external wait deadline passed with nothing waking it.' },
    ]
    for (const reason of arithmetic) {
      const store = activeGoal()
      expect(blockTier(reason.code)).toBe('arithmetic')
      expect(gateBlock(store, reason)).toEqual(reason)
    }
  })
})

describe('a judgment that has not persisted does not stop the goal', () => {
  test('a goal with a pending impasse keeps running its rounds', () => {
    // The model reported the same impasse twice. That is a challenge in
    // progress, not a stop: the goal is still active and admission keeps
    // admitting, so the model can go on working rather than being told to halt.
    const store = activeGoal()
    store.noteJudgment('waiting on a human decision')
    store.noteJudgment('waiting on a human decision')
    expect(store.judgmentRounds()).toBe(2)
    expect(store.view()!.phase).toBe('active')

    // and the seam agrees: a pending judgment is not a rejection
    expect(admit(store).kind).toBe('admitted')
    expect(store.view()!.phase).toBe('active')
  })

  test('the third report is what stops it, and the seam is where it lands', () => {
    // Once the streak reaches three the tool stops the goal, and a store that
    // missed that (a restart, another writer) still honours the condition at the
    // seam rather than running on into it.
    const directory = mkdtempSync(join(tmpdir(), 'goal-gate-third-'))
    try {
      const store = new GoalStore(directory)
      store.create('third objective', 25, 0)
      for (let round = 0; round < JUDGMENT_ROUNDS; round++) store.noteJudgment('waiting on a human decision')
      const reason = { code: 'model-reported' as const, message: 'waiting on a human decision' }
      expect(gateBlock(store, reason)).toEqual(reason)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
