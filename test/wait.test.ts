import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GoalStore } from '../src/state.ts'
import { GoalError, type GoalRef } from '../src/types.ts'

describe('the external wait is durable', () => {
  test('a wait survives a restart and is still waiting after it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-wait-durable-'))
    try {
      const store = new GoalStore(directory)
      store.create('wait objective', 25, 0)
      const ref = { id: store.view()!.id, revision: store.view()!.revision }
      store.wait(ref, 'waiting for the platform review', 60_000)

      // a fresh process reads the same log
      const restarted = new GoalStore(directory)
      expect(restarted.waitUntil).toBeGreaterThan(Date.now())
      expect(restarted.waitReason).toBe('waiting for the platform review')
      expect(restarted.view()!.phase).toBe('active')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('the wait is written to the log, not held in the process', () => {
    // The old failure was not a missing write but a missing *place*: the deadline
    // lived in `runtime`, so the log recorded that a wait had been asked for and
    // never when it ended. The log is where the answer has to be.
    const directory = mkdtempSync(join(tmpdir(), 'goal-wait-logged-'))
    try {
      const store = new GoalStore(directory)
      store.create('wait objective', 25, 0)
      store.wait({ id: store.view()!.id, revision: store.view()!.revision }, 'waiting for CI', 60_000)
      const lines = readFileSync(`${directory}/.opencode/goal-log.jsonl`, 'utf8')
        .split('\n')
        .filter((line: string) => line.trim().length > 0)
      const last = JSON.parse(lines[lines.length - 1]!)
      expect(last.operation).toBe('wait')
      expect(last.goal.waitUntil).toBeGreaterThan(Date.now())
      expect(last.goal.waitReason).toBe('waiting for CI')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('ending a wait is durable too, so a restart does not re-enter it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-wait-ended-'))
    try {
      const store = new GoalStore(directory)
      store.create('wait objective', 25, 0)
      const goal = store.view()!
      store.wait({ id: goal.id, revision: goal.revision }, 'waiting for CI', 60_000)
      const waiting = store.view()!
      store.endWait({ id: waiting.id, revision: waiting.revision })

      const restarted = new GoalStore(directory)
      expect(restarted.waitUntil).toBe(0)
      expect(restarted.waitReason).toBeUndefined()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('ending a wait the goal is not in does nothing', () => {
    // The inbox wake can arrive after the deadline already stopped the goal, so
    // the end has to be safe on a goal that is not waiting.
    const directory = mkdtempSync(join(tmpdir(), 'goal-wait-idempotent-'))
    try {
      const store = new GoalStore(directory)
      store.create('wait objective', 25, 0)
      const goal = store.view()!
      const revision = goal.revision
      store.endWait({ id: goal.id, revision })
      expect(store.view()!.revision).toBe(revision) // nothing was written
      expect(store.waitUntil).toBe(0)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('the deadline is required', () => {
  test('a wait with no deadline cannot be expressed', () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-wait-nodeadline-'))
    try {
      const store = new GoalStore(directory)
      store.create('wait objective', 25, 0)
      const ref = { id: store.view()!.id, revision: store.view()!.revision }
      // The signature takes a required `number`, so this is a compile-time
      // guarantee. What is testable is that a nonsense deadline is refused rather
      // than folded to the value that means "not waiting".
      for (const nonsense of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => store.wait(ref, 'waiting', nonsense)).toThrow(GoalError)
      }
      // and the goal is untouched by each refusal
      expect(store.view()!.waitUntil).toBe(0)
      expect(store.view()!.revision).toBe(1)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('the sentinel collision is gone: zero means not waiting and nothing else', () => {
    // Before this, an absent deadline was folded to 0 — the same value that meant
    // "not waiting" — so a wait with no deadline did not wait at all: admission
    // saw 0, read the goal as not waiting, and ran the next round immediately.
    // Zero now names exactly one state, and the only way to be waiting is to have
    // a deadline in the future.
    const directory = mkdtempSync(join(tmpdir(), 'goal-wait-sentinel-'))
    try {
      const store = new GoalStore(directory)
      store.create('wait objective', 25, 0)
      expect(store.waitUntil).toBe(0)
      store.wait({ id: store.view()!.id, revision: store.view()!.revision }, 'waiting for CI', 60_000)
      expect(store.waitUntil).toBeGreaterThan(Date.now())
      // ...and there is no way back to 0 except by ending the wait
      const waiting = store.view()!
      store.endWait({ id: waiting.id, revision: waiting.revision })
      expect(store.waitUntil).toBe(0)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a very short deadline is clamped rather than refused', () => {
    // A model passing 1 ms should not get an instant expiry; the clamp is what
    // keeps a typo from stopping the goal a millisecond later.
    const directory = mkdtempSync(join(tmpdir(), 'goal-wait-clamp-'))
    try {
      const store = new GoalStore(directory)
      store.create('wait objective', 25, 0)
      store.wait({ id: store.view()!.id, revision: store.view()!.revision }, 'waiting', 1)
      expect(store.waitUntil).toBeGreaterThanOrEqual(Date.now() + 9_000)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('the wait is cleared by every phase transition', () => {
  /** A goal that is waiting, in one store. */
  function waiter(): { directory: string; store: GoalStore; goal: GoalRef } {
    const directory = mkdtempSync(join(tmpdir(), 'goal-wait-transitions-'))
    const store = new GoalStore(directory)
    store.create('wait objective', 25, 0)
    const goal = store.view()!
    store.wait({ id: goal.id, revision: goal.revision }, 'waiting for CI', 60_000)
    const waiting = store.view()!
    return { directory, store, goal: { id: waiting.id, revision: waiting.revision } }
  }

  test('pause ends the wait', () => {
    const { directory, store, goal } = waiter()
    try {
      store.pause(goal)
      expect(store.view()!.phase).toBe('paused')
      expect(store.waitUntil).toBe(0)
      expect(store.waitReason).toBeUndefined()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('resume ends the wait', () => {
    // A human resuming a goal has taken over whatever it was waiting for. The
    // goal has to be not-armed for a resume to be legal, which is exactly what a
    // store that came alive beside a waiting goal looks like — and, since the
    // wait is durable now, exactly what a restart produces.
    const directory = mkdtempSync(join(tmpdir(), 'goal-wait-resume-'))
    try {
      const first = new GoalStore(directory)
      first.create('wait objective', 25, 0)
      const goal = first.view()!
      first.wait({ id: goal.id, revision: goal.revision }, 'waiting for CI', 60_000)

      const restarted = new GoalStore(directory)
      expect(restarted.waitUntil).toBeGreaterThan(Date.now())
      const waiting = restarted.view()!
      restarted.resume({ id: waiting.id, revision: waiting.revision })
      expect(restarted.view()!.phase).toBe('active')
      expect(restarted.waitUntil).toBe(0)
      expect(restarted.waitReason).toBeUndefined()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('complete ends the wait', () => {
    const { directory, store, goal } = waiter()
    try {
      store.complete(goal)
      expect(store.view()!.phase).toBe('complete')
      expect(store.waitUntil).toBe(0)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('block ends the wait', () => {
    const { directory, store, goal } = waiter()
    try {
      store.block(goal, { code: 'wait-expired', message: 'the deadline passed' })
      expect(store.view()!.phase).toBe('blocked')
      expect(store.waitUntil).toBe(0)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('edit leaves the wait alone', () => {
    // A human editing the objective has not resolved what the goal was waiting
    // for, so the wait stands. This is the one mutation that is not a transition.
    const { directory, store, goal } = waiter()
    try {
      store.edit(goal, 'a different objective', 30)
      expect(store.waitUntil).toBeGreaterThan(Date.now())
      expect(store.waitReason).toBe('waiting for CI')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('a legacy log line', () => {
  test('a wait recorded before the deadline was durable folds as not waiting', () => {
    // Backward compatibility for logs written while the wait was process-local:
    // such a line has no `waitUntil`, and the store must read it as not waiting
    // rather than as waiting forever on a deadline of `undefined`.
    const directory = mkdtempSync(join(tmpdir(), 'goal-wait-legacy-'))
    try {
      mkdirSync(`${directory}/.opencode`, { recursive: true })
      appendFileSync(
        `${directory}/.opencode/goal-log.jsonl`,
        `${JSON.stringify({
          kind: 'goal/change',
          version: 1,
          operation: 'create',
          goal: {
            id: 'goal-legacy',
            revision: 1,
            objective: 'legacy objective',
            phase: 'active',
            maxGoalRounds: 25,
            tokenBudget: 0,
            createdAt: 1,
            updatedAt: 1,
            roundsStarted: 0,
          },
        })}\n`,
      )
      const store = new GoalStore(directory)
      expect(store.waitUntil).toBe(0)
      expect(store.waitReason).toBeUndefined()
      expect(store.view()!.phase).toBe('active')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
