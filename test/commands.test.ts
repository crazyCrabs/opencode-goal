import { describe, expect, test } from 'bun:test'
import { parseGoalCommand } from '../src/commands.ts'

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