import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { admitRound } from '../src/admission.ts'
import { GoalStore } from '../src/state.ts'
import { GoalAccounting } from '../src/accounting.ts'
import { blockTier } from '../src/round-policy.ts'

function activeGoal(maxGoalRounds = 25, tokenBudget = 0, maxTurnsWithoutToolCall?: number): GoalStore {
  const store = new GoalStore(mkdtempSync(join(tmpdir(), 'goal-stall-')))
  store.create('stall objective', maxGoalRounds, tokenBudget, maxTurnsWithoutToolCall)
  return store
}

/** One drain from 'yes' to 'no'. */
function turn(store: GoalStore): void {
  store.noteTurnWithoutToolCall()
}

describe('the defaults are visible', () => {
  test('the round cap defaults to 25 and the token budget to unlimited', () => {
    // The budget staying at all was the weakest verdict in this ticket's
    // decision set. Asserting the defaults makes changing them a visible test
    // failure rather than a silent edit.
    const goal = activeGoal().view()!
    expect(goal.maxGoalRounds).toBe(25)
    expect(goal.tokenBudget).toBe(0) // 0 means unlimited
  })

  test('the tool-less stall threshold defaults to the prior art value', () => {
    const goal = activeGoal().view()!
    expect(goal.maxTurnsWithoutToolCall).toBe(2)
    expect(goal.maxTurnsWithoutToolCall).toBe(GoalStore.DEFAULT_MAX_TURNS_WITHOUT_TOOL_CALL)
  })

  test('the threshold is configurable, and a typo cannot express never', () => {
    expect(activeGoal(25, 0, 5).view()!.maxTurnsWithoutToolCall).toBe(5)
    expect(activeGoal(25, 0, 0).view()!.maxTurnsWithoutToolCall).toBe(0) // disables the guard
    expect(() => activeGoal(25, 0, -1)).toThrow()
    expect(activeGoal(25, 0, 5000).view()!.maxTurnsWithoutToolCall).toBe(100) // capped
  })
})

describe('a goal that talks without acting is stopped', () => {
  test('consecutive tool-less turns stall the goal even when its text keeps changing', () => {
    // The no-progress guard resets the moment the text differs, so a goal that
    // rephrases every turn can loop forever under it. This is the counter that
    // sees that: the text changing is not the same as the goal acting.
    const store = activeGoal()
    store.recordRoundOutput('first phrasing of nothing')
    turn(store)
    expect(admitRound(store).kind).toBe('admitted')
    store.recordRoundOutput('a second, different phrasing of nothing')
    turn(store)

    const verdict = admitRound(store)
    expect(verdict).toEqual({
      kind: 'blocked',
      reason: {
        code: 'no-tool-call',
        message: 'Goal blocked: 2 consecutive goal turns ended with no tool call (limit 2). The goal is talking without acting.',
      },
    })
    expect(store.view()!.phase).toBe('blocked')
  })

  test('a tool call breaks the streak, so a working goal is not stalled', () => {
    const store = activeGoal()
    turn(store)
    expect(admitRound(store).kind).toBe('admitted')
    turn(store)
    // one tool call resets it, however long the run went
    store.noteToolCall()
    expect(store.turnsWithoutToolCallCount).toBe(0)
    expect(admitRound(store).kind).toBe('admitted')
  })

  test('a raised threshold waits that many turns', () => {
    const store = activeGoal(25, 0, 4)
    for (let i = 0; i < 3; i++) {
      turn(store)
      expect(admitRound(store).kind).toBe('admitted')
    }
    turn(store)
    expect(admitRound(store).kind).toBe('blocked')
  })

  test('a threshold of zero disables the guard', () => {
    const store = activeGoal(25, 0, 0)
    for (let i = 0; i < 10; i++) turn(store)
    expect(admitRound(store).kind).toBe('admitted')
  })

  test('the stop is judgment-tier, so it is challenged rather than immediate', () => {
    // Arithmetic stops on the first breach of a fact. This is an observation
    // about the model's behaviour, so it has to persist before it is accepted —
    // which is what the consecutive-turn threshold is.
    expect(blockTier('no-tool-call')).toBe('judgment')
  })
})

describe('the two stall counters do not conflict', () => {
  test('one tool call resets the no-progress streak and breaks the tool-less streak, in the same turn', () => {
    // Both counters holding at once is the case that matters: a goal that is
    // repeating itself AND making no tool calls. One fact — the goal acted —
    // clears both, and the test asserts both clear on the same event.
    const store = activeGoal()
    // build up both streaks
    store.recordRoundOutput('the same words')
    turn(store)
    store.recordRoundOutput('the same words')
    turn(store)
    expect(store.hasRepeatedRounds()).toBe(false) // two, not three
    expect(store.turnsWithoutToolCallCount).toBe(2)

    // the goal acts
    store.noteToolCall()
    expect(store.hasRepeatedRounds()).toBe(false)
    expect(store.turnsWithoutToolCallCount).toBe(0)

    // and a fresh repeated output still needs three to trip the guard
    store.recordRoundOutput('the same words')
    expect(store.hasRepeatedRounds()).toBe(false)
  })

  test('a goal can be stalled by either counter independently', () => {
    // no-progress alone: three identical outputs with nothing in between. The
    // tool calls are deliberately absent — an agent that repeats its phrasing
    // between two `write` calls is working, and the guard must not call that an
    // impasse.
    const repeating = activeGoal()
    for (let round = 0; round < 3; round++) repeating.recordRoundOutput('identical narration')
    expect(admitRound(repeating)).toEqual({
      kind: 'blocked',
      reason: {
        code: 'no-progress',
        message: 'Goal blocked: three consecutive goal rounds produced empty or identical output.',
      },
    })

    // no-tool-call alone: changing text, no tool calls
    const idle = activeGoal()
    for (let round = 0; round < 2; round++) {
      idle.recordRoundOutput(`a fresh phrasing number ${round}`)
      turn(idle)
    }
    expect(admitRound(idle).kind).toBe('blocked')
    expect(idle.view()!.blockedReason?.code).toBe('no-tool-call')
  })

  test('a mutation resets both, so a resumed goal starts clean', () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-stall-reset-'))
    try {
      const store = new GoalStore(directory)
      store.create('stall objective', 25, 0)
      store.recordRoundOutput('same')
      turn(store)
      const ref = { id: store.view()!.id, revision: store.view()!.revision }
      store.pause(ref)
      const paused = store.view()!
      store.resume({ id: paused.id, revision: paused.revision })
      expect(store.turnsWithoutToolCallCount).toBe(0)
      expect(store.hasRepeatedRounds()).toBe(false)
    } finally {
      // eslint-disable-next-line no-unsafe-finally
    }
  })
})

describe('a human turn does not spend the goal', () => {
  test('a human turn spends neither the round budget nor the token budget, and does not move the fingerprint', () => {
    // Accounting decides this, and the decision is about whose turn it was.
    const directory = mkdtempSync(join(tmpdir(), 'goal-stall-human-'))
    try {
      const store = new GoalStore(directory)
      store.create('human objective', 25, 100_000)
      const before = store.view()!

      // the goal's own turn: folded
      const goalTurns = new GoalAccounting({ storeFor: () => store, isGoalTurn: () => true })
      goalTurns.onStepEnded(directory, {
        sessionID: 'ses-goal',
        assistantMessageID: 'msg-1',
        finish: 'stop',
        cost: 1,
        tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      const afterGoalTurn = store.view()!
      expect(afterGoalTurn.usage.inputTokens).toBe(before.usage.inputTokens + 100)
      expect(afterGoalTurn.usage.outputTokens).toBe(before.usage.outputTokens + 50)

      // a human turn: not folded
      const humanTurns = new GoalAccounting({ storeFor: () => store, isGoalTurn: () => false })
      humanTurns.onStepEnded(directory, {
        sessionID: 'ses-human',
        assistantMessageID: 'msg-2',
        finish: 'stop',
        cost: 5,
        tokens: { input: 900, output: 900, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      const afterHumanTurn = store.view()!
      expect(afterHumanTurn.usage.inputTokens).toBe(afterGoalTurn.usage.inputTokens)
      expect(afterHumanTurn.usage.outputTokens).toBe(afterGoalTurn.usage.outputTokens)

      // and a human's rephrasing does not read as progress
      humanTurns.onTextEnded(directory, { sessionID: 'ses-human', assistantMessageID: 'msg-2', ordinal: 0, text: 'a question' })
      expect(store.hasRepeatedRounds()).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})


describe('a human turn does not consume a round', () => {
  test('only the admit mutation bumps the round counter', () => {
    // This is the one part of the ticket that already held, and the test is what
    // keeps it holding: the counter moves in `GoalStore.continue`, which only
    // admission calls, so a turn nobody admitted cannot consume a round.
    const store = activeGoal(3)
    expect(store.view()!.roundsStarted).toBe(0)
    // a human asks a question: the turn happens, and nothing is admitted
    expect(store.view()!.roundsStarted).toBe(0)
    // the goal's own round is what moves it
    expect(admitRound(store)).toEqual({ kind: 'admitted', round: 1 })
    expect(store.view()!.roundsStarted).toBe(1)
    // and another human turn after it still costs nothing
    expect(store.view()!.roundsStarted).toBe(1)

    const verdict = admitRound(store)
    expect(verdict).toEqual({ kind: 'admitted', round: 2 })
    expect(store.view()!.roundsStarted).toBe(2)
  })
})
