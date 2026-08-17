import { describe, expect, test, beforeAll } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GoalStore } from '../src/state.ts'
import { GoalError } from '../src/types.ts'

let dir = ''
let store: GoalStore

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'goal-store1-'))
  store = new GoalStore(dir)
})

describe('event-sourced goal store: lifecycle', () => {
  test('create arms an active goal with revision 1', () => {
    const view = store.create('implement the feature', 25, 0)
    expect(view.phase).toBe('active')
    expect(view.activation).toBe('armed')
    expect(view.revision).toBe(1)
    expect(view.roundsStarted).toBe(0)
    expect(view.maxGoalRounds).toBe(25)
  })

  test('create rejects a second non-complete goal', () => {
    expect(() => store.create('another goal', 25, 0)).toThrow(GoalError)
  })

  test('continue advances rounds with CAS', () => {
    const ref = { id: store.current!.id, revision: store.current!.revision }
    const view = store.continue(ref)
    expect(view.roundsStarted).toBe(1)
    expect(view.revision).toBe(2)
    expect(() => store.continue(ref)).toThrow(GoalError)
  })
})