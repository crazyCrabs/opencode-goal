import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GoalStore } from '../src/state.ts'
import { goalBlockReason, renderGoalRoundPrompt } from '../src/round-policy.ts'

function freshStore(objective = 'ship the thing', maxGoalRounds = 5, tokenBudget = 0): GoalStore {
  const store = new GoalStore(mkdtempSync(join(tmpdir(), 'goal-round-policy-')))
  store.create(objective, maxGoalRounds, tokenBudget)
  return store
}

/**
 * The prompt is the model-facing half of the policy, so it is pinned as exact
 * text. Every line here is quoted from a recorded golden snapshot taken before
 * these functions moved out of `driver.ts` (ticket 13); a loose "contains"
 * assertion would let a reworded rule pass unnoticed.
 */
const GOLDEN_PROMPT = [
  '[opencode-goal continuation round 2/5]',
  '',
  'You are continuing an autonomous goal. The objective is:',
  '',
  'ship the thing',
  '',
  'Rules for this round:',
  '- Treat the objective as the task; derive concrete requirements from it and from the current worktree.',
  '- Verify work against real evidence (commands, tests, files, runtime behavior) before claiming completion.',
  '- If the objective is fully achieved with evidence, call update_goal with action "complete" and a structured claim: a summary, the criteria you derived from the objective each with its evidence, and the checks you ran with the exit codes they returned.',
  '- If progress is genuinely blocked by something only the user or an external system can resolve (and the same blocker has persisted for at least 3 goal rounds), call update_goal with action "blocked" with a concrete reason.',
  '- If you are waiting on an external event (e.g. a monitor or review), call goal_wait with a reason and a resume_after_ms deadline instead of looping.',
  '- Do not claim completion without evidence. Do not mark blocked merely because work is difficult.',
].join('\n')

describe('round prompt rendering', () => {
  test('renders objective and rules', () => {
    const goal = freshStore().view()!
    const text = renderGoalRoundPrompt(goal, 2)
    expect(text).toContain('[opencode-goal continuation round 2/5]')
    expect(text).toContain('update_goal')
    expect(text).toContain('goal_wait')
  })

  test('renders the exact golden text, so a reworded rule cannot pass unnoticed', () => {
    const goal = freshStore().view()!
    expect(renderGoalRoundPrompt(goal, 2)).toBe(GOLDEN_PROMPT)
  })

  test('shows the budget only when one is configured, and only on the header line', () => {
    const unbudgeted = freshStore('ship the thing', 5, 0).view()!
    expect(renderGoalRoundPrompt(unbudgeted, 1)).not.toContain('budget')

    const budgeted = new GoalStore(mkdtempSync(join(tmpdir(), 'goal-round-policy-b-')))
    budgeted.create('ship the thing', 5, 42)
    budgeted.addUsage({ inputTokens: 10, outputTokens: 7, cost: 0 })
    const view = budgeted.view()!
    const text = renderGoalRoundPrompt(view, 3)
    expect(text.split('\n')[0]).toBe('[opencode-goal continuation round 3/5 | budget 17/42]')
    // the budget line is the only place the number appears
    expect(text.split('\n').filter(line => line.includes('17/42')).length).toBe(1)
  })

  test('rounds a budget of zero tokens through as unlimited, not as budget 0/N', () => {
    const goal = freshStore('ship the thing', 5, 0).view()!
    goal.usage // usage is present but the budget clause is suppressed by design
    expect(renderGoalRoundPrompt(goal, 1)).not.toContain('budget 0/')
  })
})

describe('guardrail verdict', () => {
  test('admits a round when no guardrail is tripped', () => {
    const store = freshStore()
    expect(goalBlockReason(store, store.view()!)).toBeUndefined()
  })

  test('no-progress needs three identical rounds, not two', () => {
    const store = freshStore('objective', 5, 0)
    store.recordRoundOutput('same text')
    store.recordRoundOutput('same text')
    expect(goalBlockReason(store, store.view()!)).toBeUndefined()

    store.recordRoundOutput('same text')
    expect(goalBlockReason(store, store.view()!)).toEqual({
      code: 'no-progress',
      message: 'Goal blocked: three consecutive goal rounds produced empty or identical output.',
    })
  })

  test('no-progress also trips on three empty rounds', () => {
    const store = freshStore('objective', 5, 0)
    store.recordRoundOutput('')
    store.recordRoundOutput('')
    store.recordRoundOutput('')
    expect(goalBlockReason(store, store.view()!)?.code).toBe('no-progress')
  })

  test('round cap blocks at the configured limit, not before it', () => {
    const store = freshStore('objective', 1, 0)
    expect(goalBlockReason(store, store.view()!)).toBeUndefined()
    store.continue({ id: store.view()!.id, revision: store.view()!.revision })
    expect(goalBlockReason(store, store.view()!)).toEqual({
      code: 'round-limit',
      message: 'Goal reached its configured limit of 1 rounds.',
    })
  })

  test('token budget blocks once usage reaches it, and 0 means unlimited', () => {
    const below = freshStore('objective', 5, 100)
    below.addUsage({ inputTokens: 40, outputTokens: 30, cost: 0 })
    expect(goalBlockReason(below, below.view()!)).toBeUndefined()

    const at = freshStore('objective', 5, 100)
    at.addUsage({ inputTokens: 40, outputTokens: 60, cost: 0 })
    expect(goalBlockReason(at, at.view()!)).toEqual({
      code: 'budget-limited',
      message: 'Goal reached its token budget of 100 tokens (used 100).',
    })

    const unlimited = freshStore('objective', 5, 0)
    unlimited.addUsage({ inputTokens: 10_000_000, outputTokens: 10_000_000, cost: 0 })
    expect(goalBlockReason(unlimited, unlimited.view()!)).toBeUndefined()
  })

  test('no-progress takes precedence over the round cap when both hold', () => {
    const store = freshStore('objective', 1, 0)
    store.recordRoundOutput('x')
    store.recordRoundOutput('x')
    store.recordRoundOutput('x')
    store.continue({ id: store.view()!.id, revision: store.view()!.revision })
    // a goal that stopped changing its answer is stalled, not merely exhausted
    expect(goalBlockReason(store, store.view()!)?.code).toBe('no-progress')
  })

  test('round cap takes precedence over the token budget when both hold', () => {
    const store = freshStore('objective', 1, 50)
    store.addUsage({ inputTokens: 40, outputTokens: 40, cost: 0 })
    store.continue({ id: store.view()!.id, revision: store.view()!.revision })
    expect(goalBlockReason(store, store.view()!)?.code).toBe('round-limit')
  })
})
