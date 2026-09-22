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
 * `{ sessionID, text }` prompt, a transcript read, and a session lookup. Usage
 * and round output are attributed from the transcript — opencode 2.x no longer
 * emits `message.updated` — so the mock carries one finished assistant turn.
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
    if (releasePrompt !== undefined) await new Promise<void>(resolve => { releasePrompt = resolve })
    return {}
  },
  context: async () => transcript,
  get: async (input: { sessionID: string }) => ({ directory: dir, parentID: undefined }),
}

/** When set, a submitted round prompt parks until this releases it. */
let releasePrompt: (() => void) | undefined

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
    await driver2.onTurnFinished('session-2', dir)
    expect(capped.current?.phase).toBe('blocked')
    expect(capped.current?.blockedReason?.code).toBe('round-limit')
  })

  test('token budget blocks with budget-limited on the next finished turn', async () => {
    const budgeted = new GoalStore(mkdtempSync(join(tmpdir(), 'goal-driver-budget-')))
    const driver3 = makeDriver(budgeted)
    budgeted.create('budget goal', 25, 10)
    await driver3.onSessionIdle('session-3', dir) // round 1 admitted
    await driver3.onTurnFinished('session-3', dir) // the finished turn already spent 100 >= 10
    await driver3.onTurnFinished('session-3', dir) // the guardrail has fired, nothing is admitted
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

describe('a session opening adopts the goal', () => {
  test('a goal that only survived a restart starts when a session opens', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-driver-adopt-'))
    // yesterday: a goal was created and left active
    const previous = new GoalStore(directory)
    previous.create('survivor objective', 5, 0)

    // today: a fresh store sees the goal as pre-existing, so it is disarmed —
    // the exact posture that used to require a manual /goal resume
    const today = new GoalStore(directory)
    expect(today.view()?.activation).toBe('disarmed')
    const adopted = makeDriver(today)

    // an idle with no session activity stays quiet
    const before = promptCalls.length
    await adopted.onSessionIdle('session-adopt', directory)
    expect(promptCalls.length).toBe(before)

    // the user opens a session: the goal is adopted and round 1 runs there
    await adopted.onSessionCreated('session-adopt', directory)
    expect(promptCalls.length).toBe(before + 1)
    expect(promptCalls[before].sessionID).toBe('session-adopt')
    expect(promptCalls[before].text).toContain('survivor objective')
    expect(promptCalls[before].text).toContain('round 1/5')
    expect(today.current?.roundsStarted).toBe(1)

    // and the loop continues when that round's turn reports back, with no
    // further action: opencode 2.x signals a finished turn through
    // session.execution.*, never through session.idle
    await adopted.onTurnFinished('session-adopt', directory)
    expect(promptCalls.length).toBe(before + 2)
    expect(promptCalls[before + 1].text).toContain('round 2/5')

    // re-opening the same session does not admit another round
    await adopted.onSessionCreated('session-adopt', directory)
    expect(promptCalls.length).toBe(before + 2)
  })

  test('a round in flight suppresses idle bursts and parallel rounds', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-driver-inflight-'))
    const store = new GoalStore(directory)
    store.create('inflight objective', 5, 0)
    const driver = makeDriver(store)
    const before = promptCalls.length

    // a session opens: round 1 is admitted and its prompt is submitted
    await driver.onSessionCreated('session-inflight', directory)
    expect(promptCalls.length).toBe(before + 1)
    expect(store.current?.roundsStarted).toBe(1)

    // a burst of idles while that round's turn runs admits nothing: opencode
    // coalesces a prompt submitted mid-turn, so each extra admission would
    // spend a round on a prompt that never executes
    for (let i = 0; i < 3; i++) await driver.onSessionIdle('session-inflight', directory)
    expect(promptCalls.length).toBe(before + 1)
    expect(store.current?.roundsStarted).toBe(1)

    // nor does a second session opening start a parallel round on the goal
    await driver.onSessionCreated('session-second', directory)
    expect(promptCalls.length).toBe(before + 1)

    // the turn reports back: round 2 is admitted exactly once
    await driver.onTurnFinished('session-inflight', directory)
    expect(promptCalls.length).toBe(before + 2)
    expect(store.current?.roundsStarted).toBe(2)
  })

  test('a user interrupt is accounted but not continued', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-driver-interrupt-'))
    const store = new GoalStore(directory)
    store.create('interrupt objective', 5, 0)
    const driver = makeDriver(store)
    const before = promptCalls.length

    await driver.onSessionCreated('session-interrupt', directory)
    expect(promptCalls.length).toBe(before + 1)

    // the human pressed escape: the round is accounted, no next round starts
    await driver.onTurnFinished('session-interrupt', directory, 'user')
    expect(promptCalls.length).toBe(before + 1)
    expect(store.view()?.usage.inputTokens).toBe(100)

    // a later non-user completion continues the loop again
    await driver.onTurnFinished('session-interrupt', directory)
    expect(promptCalls.length).toBe(before + 2)
  })

  test('a second session opening mid-round defers to the running one', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-driver-racing-'))
    const racing = new GoalStore(directory)
    racing.create('racing objective', 5, 0)
    const racingDriver = makeDriver(racing)

    let release = (): void => {}
    releasePrompt = () => release()
    try {
      const before = promptCalls.length
      // session A opens: its round is admitted and parked inside `prompt`
      await racingDriver.onSessionCreated('session-a', directory)
      expect(promptCalls.length).toBe(before + 1)

      // session B opens while A's round is still running: no parallel round
      await racingDriver.onSessionCreated('session-b', directory)
      expect(promptCalls.length).toBe(before + 1)
      expect(racing.current?.roundsStarted).toBe(1)
    } finally {
      release()
      releasePrompt = undefined
    }
  })

  test('paused, blocked and waiting goals are not auto-started', async () => {
    const before = promptCalls.length

    const pausedDir = mkdtempSync(join(tmpdir(), 'goal-driver-paused-adopt-'))
    const paused = new GoalStore(pausedDir)
    paused.create('paused objective', 25, 0)
    paused.pause({ id: paused.current!.id, revision: paused.current!.revision })
    await makeDriver(paused).onSessionCreated('session-paused', pausedDir)
    expect(promptCalls.length).toBe(before)

    const waitingDir = mkdtempSync(join(tmpdir(), 'goal-driver-wait-adopt-'))
    const waiting = new GoalStore(waitingDir)
    waiting.create('waiting objective', 25, 0)
    waiting.wait({ id: waiting.current!.id, revision: waiting.current!.revision }, 'waiting for review', 60_000)
    await makeDriver(waiting).onSessionCreated('session-waiting', waitingDir)
    expect(promptCalls.length).toBe(before)

    const emptyDir = mkdtempSync(join(tmpdir(), 'goal-driver-empty-'))
    const empty = new GoalStore(emptyDir)
    await makeDriver(empty).onSessionCreated('session-empty', emptyDir)
    expect(promptCalls.length).toBe(before)
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