import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GoalStore } from '../src/state.ts'

describe('a goal written before the stall threshold existed', () => {
  test('folds with the default, so the guard is not silently off', () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-compat-stall-'))
    try {
      mkdirSync(`${directory}/.opencode`, { recursive: true })
      appendFileSync(
        `${directory}/.opencode/goal-log.jsonl`,
        `${JSON.stringify({
          kind: 'goal/change', version: 1, operation: 'create',
          goal: {
            id: 'goal-old', revision: 1, objective: 'old objective', phase: 'active',
            maxGoalRounds: 25, tokenBudget: 0, createdAt: 1, updatedAt: 1, roundsStarted: 0,
          },
        })}\n`,
      )
      const store = new GoalStore(directory)
      expect(store.view()!.maxTurnsWithoutToolCall).toBe(GoalStore.DEFAULT_MAX_TURNS_WITHOUT_TOOL_CALL)
      store.noteTurnWithoutToolCall()
      store.noteTurnWithoutToolCall()
      expect(store.hasStalledWithoutTools()).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
