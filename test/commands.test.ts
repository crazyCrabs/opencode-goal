import { describe, expect, test, beforeAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseGoalCommand, executeGoalCommand } from '../src/commands.ts'
import { GoalStore } from '../src/state.ts'

describe('goal command parsing', () => {
  test('empty input shows status', () => {
    expect(parseGoalCommand('').kind).toBe('show')
    expect(parseGoalCommand('status').kind).toBe('show')
  })
  test('control verbs', () => {
    expect(parseGoalCommand('pause').kind).toBe('pause')
    expect(parseGoalCommand('resume').kind).toBe('resume')
    expect(parseGoalCommand('clear').kind).toBe('clear')
  })
  test('edit objective', () => {
    const cmd = parseGoalCommand('edit ship the smaller fix')
    expect(cmd.kind).toBe('edit')
    expect(cmd.objective).toBe('ship the smaller fix')
  })
  test('create objective', () => {
    const cmd = parseGoalCommand('improve benchmark coverage')
    expect(cmd.kind).toBe('create')
    expect(cmd.objective).toBe('improve benchmark coverage')
  })
  test('token budget flag', () => {
    const cmd = parseGoalCommand('--tokens 100k finish the migration')
    expect(cmd.kind).toBe('create')
    expect(cmd.tokenBudget).toBe(100_000)
    expect(cmd.objective).toBe('finish the migration')
  })
  test('rounds flag', () => {
    const cmd = parseGoalCommand('--rounds 5 fix the tests')
    expect(cmd.kind).toBe('create')
    expect(cmd.maxGoalRounds).toBe(5)
  })
  test('invalid input', () => {
    expect(parseGoalCommand('edit').kind).toBe('invalid')
    expect(parseGoalCommand('--tokens x goal').kind).toBe('invalid')
  })
})

describe('goal command execution', () => {
  let dir = ''

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'goal-commands-'))
  })

  test('show reports usage when no goal exists', () => {
    const store = new GoalStore(dir)
    const outcome = executeGoalCommand(store, parseGoalCommand('status'))
    expect(outcome.ok).toBe(true)
    expect(outcome.text).toContain('No goal is currently set')
  })

  test('create persists and renders an armed goal', () => {
    const store = new GoalStore(dir)
    const outcome = executeGoalCommand(store, parseGoalCommand('--rounds 4 finish the migration'))
    expect(outcome.ok).toBe(true)
    expect(outcome.text).toContain('Goal created')
    expect(outcome.text).toContain('Status: active (activation: armed)')
    expect(outcome.text).toContain('Rounds: 0/4')
    expect(store.current?.objective).toBe('finish the migration')
  })

  test('create over a live goal is a rejected outcome, not a throw', () => {
    const store = new GoalStore(dir)
    const outcome = executeGoalCommand(store, parseGoalCommand('another objective'))
    expect(outcome.ok).toBe(false)
    expect(outcome.text).toContain('already active')
    expect(store.current?.objective).toBe('finish the migration')
  })

  test('pause and resume round-trip through the command', () => {
    const store = new GoalStore(dir)
    const paused = executeGoalCommand(store, parseGoalCommand('pause'))
    expect(paused.ok).toBe(true)
    expect(paused.text).toContain('Goal paused')

    // a fresh store (another process) observes the durable pause
    const observer = new GoalStore(dir)
    expect(observer.current?.phase).toBe('paused')

    const resumed = executeGoalCommand(observer, parseGoalCommand('resume'))
    expect(resumed.ok).toBe(true)
    expect(resumed.text).toContain('Goal resumed')
    expect(observer.current?.phase).toBe('active')
  })

  test('edit changes the objective without changing the phase', () => {
    const store = new GoalStore(dir)
    const outcome = executeGoalCommand(store, parseGoalCommand('edit a sharper objective'))
    expect(outcome.ok).toBe(true)
    expect(store.current?.objective).toBe('a sharper objective')
    expect(store.current?.phase).toBe('active')
  })

  test('clear removes the goal and keeps the tombstone history', () => {
    const store = new GoalStore(dir)
    const cleared = executeGoalCommand(store, parseGoalCommand('clear'))
    expect(cleared.ok).toBe(true)
    expect(cleared.text).toBe('Goal cleared.')
    expect(store.current).toBeUndefined()

    const again = executeGoalCommand(store, parseGoalCommand('clear'))
    expect(again.ok).toBe(true)
    expect(again.text).toBe('No goal to clear.')
  })

  test('a completed goal can be replaced by a new create', () => {
    const store = new GoalStore(dir)
    const first = executeGoalCommand(store, parseGoalCommand('first completed goal'))
    expect(first.ok).toBe(true)
    const ref = { id: store.current!.id, revision: store.current!.revision }
    store.complete(ref)
    const second = executeGoalCommand(store, parseGoalCommand('second goal'))
    expect(second.ok).toBe(true)
    expect(store.current?.objective).toBe('second goal')
    expect(store.current?.id).not.toBe(ref.id)
  })

  test('invalid usage is rejected with usage text', () => {
    const store = new GoalStore(dir)
    const outcome = executeGoalCommand(store, parseGoalCommand('edit'))
    expect(outcome.ok).toBe(false)
    expect(outcome.text).toContain('Invalid /goal command')
    expect(outcome.text).toContain('Usage: /goal')
  })
})