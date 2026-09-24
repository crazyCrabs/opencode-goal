import { describe, expect, test, beforeAll } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GoalStore, foldGoalLog } from '../src/state.ts'

let dir = ''
let store: GoalStore

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'goal-store3-'))
  store = new GoalStore(dir)
})

describe('event-sourced goal store: durability', () => {
  test('clear writes a durable tombstone', () => {
    store.create('tombstone goal', 5, 0)
    const current = store.view()!
    store.clear({ id: current.id, revision: current.revision })
    expect(store.view()).toBeUndefined()
    const lines = readFileSync(join(dir, '.opencode', 'goal-log.jsonl'), 'utf8').split('\n')
    const folded = foldGoalLog(lines)
    expect(folded.goal).toBeUndefined()
    expect(folded.lastRef).toBeDefined()
  })

  test('store reload folds the same durable state', () => {
    store.create('persisted goal', 3, 0)
    const reloaded = new GoalStore(dir)
    expect(reloaded.current?.objective).toBe('persisted goal')
    expect(reloaded.view()?.activation).toBe('disarmed')
  })

  test('no-progress guard detects three repeated outputs', () => {
    expect(store.recordRoundOutput('hello')).toBe(false)
    expect(store.recordRoundOutput('hello')).toBe(false)
    expect(store.hasRepeatedRounds()).toBe(false)
    expect(store.recordRoundOutput('hello')).toBe(true)
    expect(store.hasRepeatedRounds()).toBe(true)
    store.resetStallCounters()
    expect(store.hasRepeatedRounds()).toBe(false)
  })
})