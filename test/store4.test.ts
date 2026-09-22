import { describe, expect, test, beforeAll } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GoalStore } from '../src/state.ts'
import { GoalError } from '../src/types.ts'

let dir = ''

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'goal-store4-'))
})

describe('cross-writer log sync (TUI command plane <-> server driver)', () => {
  test('an observer adopts an externally created active goal and arms', () => {
    const observer = new GoalStore(dir)
    expect(observer.view()).toBeUndefined()

    const writer = new GoalStore(dir)
    writer.create('objective from the TUI command', 10, 0)

    const view = observer.view()
    expect(view?.objective).toBe('objective from the TUI command')
    expect(view?.phase).toBe('active')
    expect(view?.activation).toBe('armed')
  })

  test('external pause disarms and external resume re-arms the observer', () => {
    const writer = new GoalStore(dir)
    const observer = new GoalStore(dir)
    const ref = { id: writer.current!.id, revision: writer.current!.revision }

    writer.pause(ref)
    expect(observer.view()?.phase).toBe('paused')
    expect(observer.view()?.activation).toBe('disarmed')

    writer.resume({ id: writer.current!.id, revision: writer.current!.revision })
    expect(observer.view()?.phase).toBe('active')
    expect(observer.view()?.activation).toBe('armed')
  })

  test('external edit updates the objective without losing activation', () => {
    const writer = new GoalStore(dir)
    const observer = new GoalStore(dir)
    const ref = { id: writer.current!.id, revision: writer.current!.revision }

    writer.edit(ref, 'revised objective', undefined)

    const view = observer.view()
    expect(view?.objective).toBe('revised objective')
    expect(view?.activation).toBe('armed')
  })

  test('external clear resets every process-local trace in the observer', () => {
    const writer = new GoalStore(dir)
    const observer = new GoalStore(dir)
    observer.recordRoundOutput('some output')
    expect(observer.view()?.phase).toBe('active')

    writer.clear({ id: writer.current!.id, revision: writer.current!.revision })

    expect(observer.view()).toBeUndefined()
    expect(observer.activation).toBe('disarmed')
    expect(observer.hasRepeatedRounds()).toBe(false)
  })

  test('a fresh store still starts disarmed (explicit resume is required after a restart)', () => {
    const writer = new GoalStore(dir)
    writer.create('restart objective', 3, 0)

    const reloaded = new GoalStore(dir)
    expect(reloaded.view()?.phase).toBe('active')
    expect(reloaded.view()?.activation).toBe('disarmed')
  })

  test('own commits never toggle activation through the sync path', () => {
    const store = new GoalStore(dir)
    store.clear({ id: store.current!.id, revision: store.current!.revision })
    const view = store.create('own objective', 4, 0)
    expect(view.activation).toBe('armed')
    expect(store.view()?.activation).toBe('armed')
    store.pause({ id: store.current!.id, revision: store.current!.revision })
    expect(store.view()?.activation).toBe('disarmed')
  })

  test('a stale ref is rejected once another writer mutated the goal', () => {
    const store = new GoalStore(dir)
    const stale = { id: store.current!.id, revision: store.current!.revision }

    const writer = new GoalStore(dir)
    writer.edit({ id: writer.current!.id, revision: writer.current!.revision }, 'externally edited', undefined)

    expect(() => store.pause(stale)).toThrow(GoalError)
    expect(store.view()?.objective).toBe('externally edited')
  })

  test('token budget is durable and survives a reload', () => {
    const store = new GoalStore(dir)
    store.clear({ id: store.current!.id, revision: store.current!.revision })
    store.create('budgeted objective', 5, 100_000)

    const reloaded = new GoalStore(dir)
    expect(reloaded.view()?.tokenBudget).toBe(100_000)
    expect(reloaded.tokenBudget).toBe(100_000)
  })

  test('a legacy log line without tokenBudget folds as unlimited', () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'goal-store4-legacy-'))
    mkdirSync(`${legacyDir}/.opencode`, { recursive: true })
    appendFileSync(
      `${legacyDir}/.opencode/goal-log.jsonl`,
      `${JSON.stringify({
        kind: 'goal/change',
        version: 1,
        operation: 'create',
        goal: {
          id: 'goal-legacy',
          revision: 1,
          objective: 'legacy objective',
          phase: 'active',
          maxGoalRounds: 7,
          createdAt: 1,
          updatedAt: 1,
          usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
          roundsStarted: 0,
        },
      })}\n`,
    )
    const store = new GoalStore(legacyDir)
    expect(store.view()?.tokenBudget).toBe(0)
    expect(store.view()?.objective).toBe('legacy objective')
  })
})
