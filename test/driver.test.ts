import { describe, expect, test, beforeAll } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GoalStore } from '../src/state.ts'
import { GoalAccounting, type StepEndedData } from '../src/accounting.ts'
import { GoalDriver } from '../src/driver.ts'

let dir = ''
let store: GoalStore
let driver: GoalDriver
const promptCalls: Array<{ sessionID: string; text: string }> = []

/**
 * The slice of the opencode 2.x session domain the driver speaks to: a flat
 * `{ sessionID, text }` prompt. Usage and round output are no longer read here
 * — the accounting module folds them from the durable session events, so the
 * driver's only transport concern is submitting a round.
 */
const session = {
  prompt: async (input: { sessionID: string; text: string }) => {
    promptCalls.push({ sessionID: input.sessionID, text: input.text })
    if (releasePrompt !== undefined) await new Promise<void>(resolve => { releasePrompt = resolve })
    return {}
  },
}

/** One finished step, as a live server reports it. */
const STEP: StepEndedData = {
  sessionID: 'ses-driver',
  assistantMessageID: 'msg-driver-1',
  finish: 'stop',
  cost: 0,
  tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
}

/** When set, a submitted round prompt parks until this releases it. */
let releasePrompt: (() => void) | undefined

/**
 * Build a driver together with the accounting that feeds it, because a round's
 * guardrails are checked at admission and the usage they check is folded from
 * the durable events that arrive before the turn-completion event. Both halves
 * are wired the way the plugin wires them: one store per directory, accounting
 * first.
 */
function makeDriver(st: GoalStore, directory: string): { driver: GoalDriver; accounting: GoalAccounting } {
  const accounting = new GoalAccounting({ storeFor: () => st, isGoalTurn: () => true })
  const d = new GoalDriver({
    getStore: () => st,
    session,
    log: () => {},
  })
  d.setDirectory(directory)
  return { driver: d, accounting }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'goal-driver-'))
  store = new GoalStore(dir)
  driver = makeDriver(store, dir).driver
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
  })

  test('round cap blocks the goal with round-limit', async () => {
    const capped = new GoalStore(mkdtempSync(join(tmpdir(), 'goal-driver-cap-')))
    const { driver: driver2 } = makeDriver(capped, dir)
    capped.create('tiny goal', 1, 0)
    await driver2.onSessionIdle('session-2', dir)
    await driver2.onTurnFinished('session-2', dir)
    expect(capped.current?.phase).toBe('blocked')
    expect(capped.current?.blockedReason?.code).toBe('round-limit')
  })

  test('token budget blocks with budget-limited on the next finished turn', async () => {
    const budgeted = new GoalStore(mkdtempSync(join(tmpdir(), 'goal-driver-budget-')))
    const { driver: driver3, accounting } = makeDriver(budgeted, dir)
    budgeted.create('budget goal', 25, 10)
    await driver3.onSessionIdle('session-3', dir) // round 1 admitted
    // the turn's durable step event folds the usage, exactly as the plugin wires
    // it — the accounting runs before the completion event the driver acts on
    accounting.onStepEnded(dir, STEP)
    await driver3.onTurnFinished('session-3', dir) // 100 >= 10, so the guardrail fires
    expect(budgeted.current?.phase).toBe('blocked')
    expect(budgeted.current?.blockedReason?.code).toBe('budget-limited')
  })

  test('paused or disarmed goals are never continued', async () => {
    const quiet = new GoalStore(mkdtempSync(join(tmpdir(), 'goal-driver-quiet-')))
    const { driver: driver4 } = makeDriver(quiet, dir)
    quiet.create('quiet goal', 25, 0)
    quiet.activation = 'disarmed'
    const before = promptCalls.length
    await driver4.onSessionIdle('session-4', dir)
    expect(promptCalls.length).toBe(before)
    quiet.pause({ id: quiet.current!.id, revision: quiet.current!.revision })
    await driver4.onSessionIdle('session-4', dir)
    expect(promptCalls.length).toBe(before)
  })

  test('wait suppresses continuation, and a fresh process is suppressed by the same deadline', async () => {
    const waitingDir = mkdtempSync(join(tmpdir(), 'goal-driver-wait-'))
    const waiting = new GoalStore(waitingDir)
    const { driver: driver5 } = makeDriver(waiting, waitingDir)
    waiting.create('wait goal', 25, 0)
    waiting.wait({ id: waiting.current!.id, revision: waiting.current!.revision }, 'waiting for CI', 60_000)
    const before = promptCalls.length
    await driver5.onSessionIdle('session-5', waitingDir)
    expect(promptCalls.length).toBe(before)

    // The wait is durable, so this is the state a restart finds: a store that came
    // alive beside a waiting goal reads the same deadline and stays quiet. It used
    // to read nothing, find the goal armed, and run straight on into whatever the
    // goal had been waiting for.
    const restarted = new GoalStore(waitingDir)
    restarted.sync()
    expect(restarted.waitUntil).toBeGreaterThan(Date.now())
    expect(restarted.view()!.phase).toBe('active')
    const after = promptCalls.length
    await driver5.onSessionIdle('session-5', waitingDir)
    expect(promptCalls.length).toBe(after)
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
    const { driver: adopted } = makeDriver(today, directory)

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
    const { driver, accounting } = makeDriver(store, directory)
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
    const { driver, accounting } = makeDriver(store, directory)
    const before = promptCalls.length

    await driver.onSessionCreated('session-interrupt', directory)
    expect(promptCalls.length).toBe(before + 1)

    // the human pressed escape: the turn's usage was folded from its durable
    // step event, and no next round starts
    accounting.onStepEnded(directory, STEP)
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
    const { driver: racingDriver } = makeDriver(racing, directory)

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
    await makeDriver(paused, pausedDir).driver.onSessionCreated('session-paused', pausedDir)
    expect(promptCalls.length).toBe(before)

    const waitingDir = mkdtempSync(join(tmpdir(), 'goal-driver-wait-adopt-'))
    const waiting = new GoalStore(waitingDir)
    waiting.create('waiting objective', 25, 0)
    waiting.wait({ id: waiting.current!.id, revision: waiting.current!.revision }, 'waiting for review', 60_000)
    await makeDriver(waiting, waitingDir).driver.onSessionCreated('session-waiting', waitingDir)
    expect(promptCalls.length).toBe(before)

    const emptyDir = mkdtempSync(join(tmpdir(), 'goal-driver-empty-'))
    const empty = new GoalStore(emptyDir)
    await makeDriver(empty, emptyDir).driver.onSessionCreated('session-empty', emptyDir)
    expect(promptCalls.length).toBe(before)
  })
})

describe('a finished human turn re-arms a goal that predates the process', () => {
  test('the goal starts, in the session the human is already in', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-driver-human-turn-'))
    // yesterday: the goal was created and left active
    const previous = new GoalStore(directory)
    previous.create('survivor objective', 5, 0)

    // today: a fresh store reads it as pre-existing, so disarmed — the state a
    // restart leaves, and the state `opencode run --standalone` starts in, where
    // `session.created` never fires at all (four live runs, zero events)
    const today = new GoalStore(directory)
    expect(today.activation).toBe('disarmed')
    const { driver: turnDriver } = makeDriver(today, directory)

    const before = promptCalls.length
    // the human sends a message and it finishes: that is the go-ahead
    await turnDriver.adoptOnHumanTurn('session-human', directory)
    expect(today.activation).toBe('armed')
    await turnDriver.onTurnFinished('session-human', directory)
    expect(promptCalls.length).toBe(before + 1)
    expect(promptCalls[before].sessionID).toBe('session-human')
    expect(promptCalls[before].text).toContain('round 1/5')

    // The arm is tied to a finished turn, not to the goal merely being present:
    // a goal created while this store was alive is already armed (mutatedWhileAlive),
    // so the case this method exists for is only ever a goal that predates it.
  })

  test("a goal round's own completion cannot consent for the goal", async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-driver-own-turn-'))
    const own = new GoalStore(directory)
    own.create('own round objective', 5, 0)
    const { driver: ownDriver } = makeDriver(own, directory)

    // a session opens: round 1 is admitted, so its round is in flight and the
    // driver knows the turn running there is the goal's own
    await ownDriver.onSessionCreated('session-own', directory)
    expect(own.current?.roundsStarted).toBe(1)

    // Disarm by hand to the state a paused goal is in, so the re-arm would be
    // visible if it happened. `finish` releases the round AFTER the arm runs, so
    // this is the exact ordering the plugin event handler uses.
    own.activation = 'disarmed'
    ownDriver.adoptOnHumanTurn('session-own', directory)
    expect(own.activation).toBe('disarmed')

    // a human turn in another session is a different story, and re-arms it
    ownDriver.adoptOnHumanTurn('session-human', directory)
    expect(own.activation).toBe('armed')
  })

  test('a goal that is not running is never re-armed into running', async () => {
    const before = promptCalls.length

    const completeDir = mkdtempSync(join(tmpdir(), 'goal-driver-human-complete-'))
    const complete = new GoalStore(completeDir)
    complete.create('finished objective', 5, 0)
    complete.complete({ id: complete.current!.id, revision: complete.current!.revision })
    const completeDriver = makeDriver(complete, completeDir).driver
    await completeDriver.adoptOnHumanTurn('session-complete', completeDir)
    expect(complete.activation).toBe('disarmed')
    expect(promptCalls.length).toBe(before)

    const pausedDir = mkdtempSync(join(tmpdir(), 'goal-driver-human-paused-'))
    const paused = new GoalStore(pausedDir)
    paused.create('paused objective', 5, 0)
    paused.pause({ id: paused.current!.id, revision: paused.current!.revision })
    await makeDriver(paused, pausedDir).driver.adoptOnHumanTurn('session-paused', pausedDir)
    expect(paused.activation).toBe('disarmed')
    expect(promptCalls.length).toBe(before)

    const blockedDir = mkdtempSync(join(tmpdir(), 'goal-driver-human-blocked-'))
    const blocked = new GoalStore(blockedDir)
    blocked.create('blocked objective', 5, 0)
    blocked.block(
      { id: blocked.current!.id, revision: blocked.current!.revision },
      { code: 'no-progress', message: 'the goal stopped making progress' },
    )
    await makeDriver(blocked, blockedDir).driver.adoptOnHumanTurn('session-blocked', blockedDir)
    expect(blocked.activation).toBe('disarmed')
    expect(promptCalls.length).toBe(before)
  })
})
