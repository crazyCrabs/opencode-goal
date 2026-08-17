import { describe, expect, test, beforeAll } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GoalStore } from '../src/state.ts'

let dir = ''
let store: GoalStore

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'goal-store2-'))
  store = new GoalStore(dir)
})

describe('event-sourced goal store: transitions', () => {
  test('pause and resume round-trip', () => {
    store.create('transition goal', 25, 0)
    const current = store.view()!
    const ref = { id: current.id, revision: current.revision }
    const paused = store.pause(ref)
    expect(paused.phase).toBe('paused')
    expect(paused.activation).toBe('disarmed')
    const resumed = store.resume({ id: paused.id, revision: paused.revision })
    expect(resumed.phase).toBe('active')
    expect(resumed.activation).toBe('armed')
  })

  test('complete transitions and disarms', () => {
    const current = store.view()!
    const done = store.complete({ id: current.id, revision: current.revision })
    expect(done.phase).toBe('complete')
    expect(done.activation).toBe('disarmed')
  })

  test('a completed goal can be replaced', () => {
    const view = store.create('next objective', 10, 100_000)
    expect(view.objective).toBe('next objective')
    expect(view.tokenBudget).toBe(100_000)
    expect(view.revision).toBe(1)
  })
})