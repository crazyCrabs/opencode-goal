import { describe, expect, test, beforeAll } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GoalStore } from '../src/state.ts'
import { GoalDriver, renderGoalRoundPrompt } from '../src/driver.ts'

let dir = ''
let store: GoalStore
let driver: GoalDriver
const promptCalls: Array<{ sessionID: string; text: string }> = []

/**
 * The slice of the opencode 2.x session domain the driver speaks to: a flat
 * `{ sessionID, text }` prompt and a transcript read. Usage and round output
 * are attributed from the transcript — opencode 2.x no longer emits
 * `message.updated` — so the mock carries one finished assistant turn.
 */
const transcript = [
  {
    id: 'msg-driver-1',
    type: 'assistant',
    tokens: { input: 100, output: 50 },
    cost: 0.001,
    content: [{ type: 'text', text: 'work done for this round' }],
  },
]

const session = {
  prompt: async (input: { sessionID: string; text: string }) => {
    promptCalls.push({ sessionID: input.sessionID, text: input.text })
    return {}
  },
  context: async () => transcript,
}

function makeDriver(st: GoalStore): GoalDriver {
  const d = new GoalDriver({
    getStore: () => st,
    session,
    log: () => {},
  })
  d.setDirectory(dir)
  return d
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'goal-driver-'))
  store = new GoalStore(dir)
  driver = makeDriver(store)
})

describe('continuation driver', () => {
  test('idle with armed active goal injects one round', async () => {
    store.create('driver objective', 5, 0)
    const before = promptCalls.length
    await driver.onSessionIdle('session-1', dir)
    expect(promptCalls.length).toBe(before + 1)
    expect(promptCalls[before].sessionID).toBe('session-1')
    expect(promptCalls[before].text).toContain('driver objective')
    expect(promptCalls[before].text).toContain('round 1/5')
    expect(store.current?.roundsStarted).toBe(1)
    expect(store.current?.revision).toBe(2)
    expect(store.view()?.usage.inputTokens).toBe(100)
  })

  test('round cap blocks the goal with round-limit', async () => {
    const capped = new GoalStore(mkdtempSync(join(tmpdir(), 'goal-driver-cap-')))
    const driver2 = makeDriver(capped)
    capped.create('tiny goal', 1, 0)
    await driver2.onSessionIdle('session-2', dir)
    await driver2.onSessionIdle('session-2', dir)
    expect(capped.current?.phase).toBe('blocked')
    expect(capped.current?.blockedReason?.code).toBe('round-limit')
  })

  test('token budget blocks with budget-limited on the next idle', async () => {
    const budgeted = new GoalStore(mkdtempSync(join(tmpdir(), 'goal-driver-budget-')))
    const driver3 = makeDriver(budgeted)
    budgeted.create('budget goal', 25, 10)
    await driver3.onSessionIdle('session-3', dir) // the finished turn already spent 100 >= 10
    await driver3.onSessionIdle('session-3', dir) // the guardrail has fired, nothing is admitted
    expect(budgeted.current?.phase).toBe('blocked')
    expect(budgeted.current?.blockedReason?.code).toBe('budget-limited')
  })

  test('paused or disarmed goals are never continued', async () => {
    const quiet = new GoalStore(mkdtempSync(join(tmpdir(), 'goal-driver-quiet-')))
    const driver4 = makeDriver(quiet)
    quiet.create('quiet goal', 25, 0)
    quiet.activation = 'disarmed'
    const before = promptCalls.length
    await driver4.onSessionIdle('session-4', dir)
    expect(promptCalls.length).toBe(before)
    quiet.pause({ id: quiet.current!.id, revision: quiet.current!.revision })
    await driver4.onSessionIdle('session-4', dir)
    expect(promptCalls.length).toBe(before)
  })

  test('wait suppresses continuation until the deadline', async () => {
    const waiting = new GoalStore(mkdtempSync(join(tmpdir(), 'goal-driver-wait-')))
    const driver5 = makeDriver(waiting)
    waiting.create('wait goal', 25, 0)
    waiting.wait({ id: waiting.current!.id, revision: waiting.current!.revision }, 'waiting for CI', 60_000)
    const before = promptCalls.length
    await driver5.onSessionIdle('session-5', dir)
    expect(promptCalls.length).toBe(before)
    // expired deadline allows continuation
    waiting.waitUntil = Date.now() - 1000
    await driver5.onSessionIdle('session-5', dir)
    expect(promptCalls.length).toBe(before + 1)
  })
})

describe('round prompt rendering', () => {
  test('renders objective and rules', () => {
    const goal = store.view()!
    const text = renderGoalRoundPrompt(goal, 2)
    expect(text).toContain('[opencode-goal continuation round 2/5]')
    expect(text).toContain('update_goal')
    expect(text).toContain('goal_wait')
  })
})