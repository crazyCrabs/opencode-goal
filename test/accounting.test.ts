import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GoalStore } from '../src/state.ts'
import { GoalAccounting, type StepEndedData, type TextEndedData } from '../src/accounting.ts'

/**
 * Fixtures are the recorded payloads from a live opencode 2.0.14 server
 * (`.scratch/goal-rework/assets/recording-runD-multistep-tools.jsonl`), not
 * invented shapes. The step deltas there are 10955/76 and 2722/9, and the turn's
 * cumulative report is 13714/10992 — the exact arithmetic below is the reason
 * this module exists.
 */
const STEP_ONE: StepEndedData = {
  sessionID: 'ses_A',
  assistantMessageID: 'msg_A1',
  finish: 'tool-calls',
  rawFinish: 'tool_calls',
  cost: 0,
  tokens: { input: 10955, output: 76, reasoning: 56, cache: { read: 0, write: 0 } },
}

const STEP_TWO: StepEndedData = {
  sessionID: 'ses_A',
  assistantMessageID: 'msg_A2',
  finish: 'stop',
  rawFinish: 'stop',
  cost: 0,
  tokens: { input: 2722, output: 9, reasoning: 60, cache: { read: 10752, write: 0 } },
}

const TEXT_TWO: TextEndedData = {
  sessionID: 'ses_A',
  assistantMessageID: 'msg_A2',
  ordinal: 0,
  text: 'DONE-TOOL-RUN',
}

function harness(tokenBudget = 0): { store: GoalStore; accounting: GoalAccounting; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'goal-accounting-'))
  const store = new GoalStore(directory)
  store.create('accounting objective', 25, tokenBudget)
  const accounting = new GoalAccounting({ storeFor: () => store, isGoalTurn: () => true })
  return { store, accounting, directory }
}

describe('the fold sums step deltas', () => {
  test('a two-step turn folds to the cumulative the turn reported', () => {
    const { store, accounting, directory } = harness()
    accounting.onStepEnded(directory, STEP_ONE)
    accounting.onStepEnded(directory, STEP_TWO)

    // the live turn reported cumulative 13714 in / 10992 out across two steps of
    // 10955/76 and 2722/9: 10955+2722 = 13677, + 10752 cache read = 24429 in;
    // 76+9 = 85, + 56+60 reasoning = 201 out. The fold is arithmetic, and it is
    // checked against the recording rather than against itself.
    const usage = store.view()!.usage
    expect(usage.inputTokens).toBe(10955 + 2722 + 10752)
    expect(usage.outputTokens).toBe(76 + 9 + 56 + 60)
  })

  test('the fold sums deltas rather than diffing a cumulative', () => {
    const { store, accounting, directory } = harness()
    // the same step reported twice is two deltas, not one cumulative read once
    accounting.onStepEnded(directory, STEP_ONE)
    accounting.onStepEnded(directory, STEP_ONE)
    expect(store.view()!.usage.inputTokens).toBe(10955 * 2)
  })

  test('a step with no usage still records its text', () => {
    const { store, accounting, directory } = harness()
    accounting.onTextEnded(directory, TEXT_TWO)
    const before = store.view()!.usage.inputTokens
    accounting.onStepEnded(directory, { ...STEP_TWO, tokens: undefined, cost: undefined })
    expect(store.view()!.usage.inputTokens).toBe(before)
    // the text was flushed even though nothing was billed
    expect(store.hasRepeatedRounds()).toBe(false)
  })
})

describe('the no-progress guard reads durable text', () => {
  test('one message with several ordinal parts folds as one round output', () => {
    const { store, accounting, directory } = harness()
    accounting.onTextEnded(directory, { ...TEXT_TWO, ordinal: 1, text: 'second part' })
    accounting.onTextEnded(directory, { ...TEXT_TWO, ordinal: 0, text: 'first part' })
    accounting.onStepEnded(directory, STEP_TWO)

    // the parts arrived out of order and are folded in ordinal order, so the
    // recorded output is the whole message rather than the last part
    expect(accounting.pendingParts('ses_A', 'msg_A2').length).toBe(0)
    // three identical messages stall; two do not
    for (let round = 0; round < 3; round++) {
      accounting.onTextEnded(directory, TEXT_TWO)
      accounting.onStepEnded(directory, STEP_TWO)
    }
    expect(store.hasRepeatedRounds()).toBe(true)
  })

  test('the joined parts keep their word boundaries in the fingerprint', () => {
    const { store, accounting, directory } = harness()
    accounting.onTextEnded(directory, { ...TEXT_TWO, ordinal: 0, text: 'first part' })
    accounting.onTextEnded(directory, { ...TEXT_TWO, ordinal: 1, text: 'second part' })
    accounting.onStepEnded(directory, STEP_TWO)

    // `normalizeOutput` strips control characters, so a newline separator would
    // fold this into "first partsecond part" and the guard would fingerprint a
    // message that does not read the way the model wrote it. A space survives.
    accounting.onTextEnded(directory, { ...TEXT_TWO, ordinal: 0, text: 'first part second part' })
    accounting.onStepEnded(directory, STEP_TWO)
    // the second message normalizes to the same fingerprint as the joined first
    // one, so the streak is running rather than restarted
    accounting.onTextEnded(directory, { ...TEXT_TWO, ordinal: 0, text: 'first part second part' })
    accounting.onStepEnded(directory, STEP_TWO)
    expect(store.hasRepeatedRounds()).toBe(true)
  })

  test('text with no matching step.ended is never recorded', () => {
    const { store, accounting, directory } = harness()
    for (let i = 0; i < 5; i++) accounting.onTextEnded(directory, TEXT_TWO)
    expect(accounting.pendingParts('ses_A', 'msg_A2').length).toBe(5)
    expect(store.hasRepeatedRounds()).toBe(false)
  })

  test('a tool call resets the streak, so a working agent is not stalled', () => {
    const { store, accounting, directory } = harness()
    for (let round = 0; round < 4; round++) {
      accounting.onTextEnded(directory, TEXT_TWO)
      accounting.onStepEnded(directory, STEP_TWO)
      // the model repeats its phrasing every round, but it also calls a tool
      accounting.onToolActivity(directory)
    }
    expect(store.hasRepeatedRounds()).toBe(false)
  })
})

describe('a missing step under-counts, never double-counts', () => {
  test('a step that never arrives is simply absent', () => {
    const { store, accounting, directory } = harness()
    accounting.onStepEnded(directory, STEP_ONE)
    accounting.onStepEnded(directory, { ...STEP_ONE, sessionID: 'ses_B', tokens: undefined })
    accounting.onStepEnded(directory, STEP_TWO)

    const usage = store.view()!.usage
    // STEP_ONE + STEP_TWO, and nothing for the middle step that reported none
    expect(usage.inputTokens).toBe(10955 + 10752 + 2722)
    expect(usage.outputTokens).toBe(76 + 56 + 9 + 60)
  })

  test('a redelivered step is folded once', () => {
    const { store, accounting, directory } = harness()
    accounting.onStepEnded(directory, STEP_ONE, 19)
    accounting.onStepEnded(directory, STEP_ONE, 19) // the same durable event again
    expect(store.view()!.usage.inputTokens).toBe(10955)
    expect(accounting.lastFoldedSeq('ses_A')).toBe(19)
  })

  test('a later sequence is folded even after an earlier one is replayed', () => {
    const { store, accounting, directory } = harness()
    accounting.onStepEnded(directory, STEP_ONE, 19)
    accounting.onStepEnded(directory, STEP_ONE, 19)
    accounting.onStepEnded(directory, STEP_TWO, 27)
    expect(store.view()!.usage.inputTokens).toBe(10955 + 2722 + 10752)
    expect(accounting.lastFoldedSeq('ses_A')).toBe(27)
  })

  test('an event with no sequence is folded, because omitting it would lose usage', () => {
    const { store, accounting, directory } = harness()
    accounting.onStepEnded(directory, STEP_ONE, undefined)
    accounting.onStepEnded(directory, STEP_ONE, undefined)
    expect(store.view()!.usage.inputTokens).toBe(10955 * 2)
  })
})

describe('the fold ignores what it cannot attribute', () => {
  test('no goal in the directory means nothing is folded', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'goal-accounting-empty-'))
    const accounting = new GoalAccounting({ storeFor: () => new GoalStore(emptyDir), isGoalTurn: () => true })
    expect(() => accounting.onStepEnded(emptyDir, STEP_ONE)).not.toThrow()
    expect(() => accounting.onTextEnded(emptyDir, TEXT_TWO)).not.toThrow()
    expect(() => accounting.onToolActivity(emptyDir)).not.toThrow()
  })

  test('a payload with no session id still folds its usage, but cannot buffer its text', () => {
    const { store, accounting, directory } = harness()
    accounting.onStepEnded(directory, { ...STEP_ONE, sessionID: undefined })
    accounting.onTextEnded(directory, { ...TEXT_TWO, sessionID: undefined })
    // the usage belongs to the goal in that directory, so a missing session id
    // must not throw it away — that would be an under-count of our own making,
    // not one a missing event caused
    expect(store.view()!.usage.inputTokens).toBe(10955)
    // but the text has nothing to be keyed by, so it is dropped rather than
    // attributed to whichever message happens to be next
    expect(accounting.pendingParts(undefined as unknown as string, 'msg_A2').length).toBe(0)
  })

  test('forgetting a session drops its buffered text and its folded sequence', () => {
    const { store, accounting, directory } = harness()
    accounting.onTextEnded(directory, TEXT_TWO)
    accounting.onStepEnded(directory, STEP_ONE, 19)
    accounting.forget('ses_A')
    expect(accounting.pendingParts('ses_A', 'msg_A2').length).toBe(0)
    expect(accounting.lastFoldedSeq('ses_A')).toBeUndefined()
    // and the goal's already-folded usage is not rolled back
    expect(store.view()!.usage.inputTokens).toBe(10955)
  })
})

describe('the overlay accumulates', () => {
  test('two addUsage calls sum rather than replace', () => {
    const { store } = harness()
    store.addUsage({ inputTokens: 100, outputTokens: 50, cost: 0.001 })
    store.addUsage({ inputTokens: 100, outputTokens: 50, cost: 0.001 })
    const usage = store.view()!.usage
    expect(usage.inputTokens).toBe(200)
    expect(usage.outputTokens).toBe(100)
    expect(usage.cost).toBeCloseTo(0.002)
  })

  test('a durable mutation carries the accumulated overlay forward', () => {
    const { store } = harness()
    store.addUsage({ inputTokens: 100, outputTokens: 50, cost: 0 })
    store.addUsage({ inputTokens: 100, outputTokens: 50, cost: 0 })
    // the next durable mutation (a resume) carries the usage into the snapshot
    store.pause({ id: store.current!.id, revision: store.current!.revision })
    expect(store.view()!.usage.inputTokens).toBe(200)
  })
})

describe('usage folded after the last durable mutation is durable at the fold', () => {
  // Reproduced on a live opencode v2 server. A one-round goal ran four steps and
  // folded 46196 input tokens; the goal recorded 22839. Every one of the four
  // `session.step.ended` events reached `onStepEnded` and none was skipped by any
  // of its guards — the first two steps sum to exactly 22839, and the goal's
  // `complete` mutation was stamped 12ms before the third step arrived.
  //
  // `GoalStore.addUsage` was accumulating that into an in-memory overlay that the
  // next mutation carried, and nothing followed the completing step. It now
  // appends its own change at the moment of the fold, so this describe is a
  // regression suite rather than a record of a red test.
  const STEP_ONE_IN = 11390
  const STEP_ONE_OUT = 45
  const STEP_THREE_IN = 11495
  const STEP_THREE_OUT = 191

  test('a fresh reader of the log sees usage folded after the last mutation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-acc-overlay-'))
    const store = new GoalStore(dir)
    store.create('overlay objective', 25, 0)
    store.addUsage({ inputTokens: STEP_ONE_IN, outputTokens: STEP_ONE_OUT })
    const current = store.view()!
    store.continue({ id: current.id, revision: current.revision })
    // step 3 arrives after the goal has stopped changing: nothing follows it
    store.addUsage({ inputTokens: STEP_THREE_IN, outputTokens: STEP_THREE_OUT })

    // the live run recorded 22839, which was steps 1 and 2 exactly
    expect(store.view()!.usage.inputTokens).toBe(STEP_ONE_IN + STEP_THREE_IN)
    const reread = new GoalStore(dir).view()!
    expect(reread.usage.inputTokens).toBe(STEP_ONE_IN + STEP_THREE_IN)
    expect(reread.usage.outputTokens).toBe(STEP_ONE_OUT + STEP_THREE_OUT)
  })

  test('each fold writes its own line instead of riding a later mutation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-acc-overlay-lines-'))
    const store = new GoalStore(dir)
    store.create('overlay objective', 25, 0)
    store.addUsage({ inputTokens: 100, outputTokens: 5, cost: 0.01 })
    store.addUsage({ inputTokens: 50, outputTokens: 2, cost: 0.002 })

    const lines = readFileSync(`${dir}/.opencode/goal-log.jsonl`, 'utf8')
      .split('\n')
      .filter(line => line.trim().length > 0)
    // one create and two folds, not one create carrying both
    expect(lines.length).toBe(3)
    const folds = lines.slice(1).map(line => JSON.parse(line))
    expect(folds.map(fold => fold.operation)).toEqual(['usage', 'usage'])
    // a delta, not a snapshot, so it cannot replace the goal as another writer
    // last saw it
    expect(folds[0].goal).toBeUndefined()
    expect(folds[0].delta).toMatchObject({ inputTokens: 100, outputTokens: 5 })
    // and it is not a state verb: the revision it names does not move
    expect(folds[0].ref).toMatchObject({ revision: 1 })
  })

  test('a usage line cannot undo a snapshot another writer appended after it', () => {
    // The ordering this protects against: the server folds a step while the human
    // pauses the goal from the TUI. A usage line carrying a full snapshot would
    // arrive last and replace the goal as the folding process last saw it —
    // undoing the pause, while a round is still in flight for it. The log is
    // written by hand so the fold, not the writer, decides the outcome.
    const dir = mkdtempSync(join(tmpdir(), 'goal-acc-overlay-clobber-'))
    const store = new GoalStore(dir)
    store.create('clobber objective', 25, 0)
    const ref = { id: store.current!.id, revision: store.current!.revision }
    store.pause(ref)
    appendFileSync(
      `${dir}/.opencode/goal-log.jsonl`,
      `${JSON.stringify({
        kind: 'goal/change',
        version: 1,
        operation: 'usage',
        ref: { id: ref.id, revision: 1 },
        delta: { inputTokens: STEP_ONE_IN, outputTokens: STEP_ONE_OUT },
        at: Date.now(),
      })}\n`,
    )

    const reread = new GoalStore(dir).view()!
    expect(reread.phase).toBe('paused')
    expect(reread.usage.inputTokens).toBe(STEP_ONE_IN)
  })

  test('a log written before usage became durable still folds its total', () => {
    // Such a log has no `usage` lines at all: its total lives only in the
    // snapshots, so summing nothing would fold every goal the previous build
    // wrote as zero usage. Written by hand because a live store can no longer
    // produce this shape.
    const dir = mkdtempSync(join(tmpdir(), 'goal-acc-overlay-legacy-'))
    const seed = new GoalStore(dir)
    seed.create('legacy objective', 25, 0)
    const base = seed.current!
    appendFileSync(
      `${dir}/.opencode/goal-log.jsonl`,
      [`{"kind":"goal/change","version":1,"operation":"continue","goal":${JSON.stringify({
        ...base,
        revision: 2,
        roundsStarted: 1,
        usage: { inputTokens: STEP_ONE_IN, outputTokens: STEP_ONE_OUT, cost: 0 },
      })}}`,
       `{"kind":"goal/change","version":1,"operation":"complete","goal":${JSON.stringify({
        ...base,
        revision: 3,
        phase: 'complete',
        roundsStarted: 1,
        usage: { inputTokens: STEP_ONE_IN + STEP_THREE_IN, outputTokens: STEP_ONE_OUT + STEP_THREE_OUT, cost: 0 },
      })}}`].join('\n') + '\n',
    )

    const reread = new GoalStore(dir).view()!
    expect(reread.phase).toBe('complete')
    expect(reread.usage.inputTokens).toBe(STEP_ONE_IN + STEP_THREE_IN)
  })

  test('a goal that replaces a completed one does not inherit its usage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-acc-overlay-next-'))
    const first = new GoalStore(dir)
    first.create('first objective', 25, 0)
    const ref = { id: first.current!.id, revision: first.current!.revision }
    first.addUsage({ inputTokens: STEP_ONE_IN, outputTokens: STEP_ONE_OUT })
    first.complete(ref)

    // the next goal starts from zero rather than from the previous one's steps
    const second = new GoalStore(dir)
    second.create('second objective', 25, 0)
    second.addUsage({ inputTokens: 100, outputTokens: 1 })
    const reread = new GoalStore(dir).view()!
    expect(reread.objective).toBe('second objective')
    expect(reread.usage.inputTokens).toBe(100)
  })

  test('a usage line for another goal is not added to this one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-acc-overlay-foreign-'))
    const store = new GoalStore(dir)
    store.create('owned objective', 25, 0)
    appendFileSync(
      `${dir}/.opencode/goal-log.jsonl`,
      `${JSON.stringify({
        kind: 'goal/change',
        version: 1,
        operation: 'usage',
        ref: { id: 'goal-someone-else', revision: 9 },
        delta: { inputTokens: 999_999, outputTokens: 999_999 },
        at: Date.now(),
      })}\n`,
    )

    expect(new GoalStore(dir).view()!.usage.inputTokens).toBe(0)
  })
})
