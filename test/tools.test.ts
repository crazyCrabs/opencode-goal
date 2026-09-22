import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { goalTools } from '../src/tools.ts'
import { GoalStore } from '../src/state.ts'

describe('goal tools', () => {
  test('every tool is registered as a direct, name-callable tool', () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-tools-'))
    try {
      const tools = goalTools(directory, dir => new GoalStore(dir))
      expect(tools.map(tool => tool.name)).toEqual(['get_goal', 'create_goal', 'update_goal', 'goal_wait'])
      for (const tool of tools) {
        // opencode 2.x keeps plugin tools in the Code Mode catalog unless they
        // opt out: only `codemode: false` makes the tool callable by name, the
        // way the system prompt and the continuation prompt instruct the model
        expect(tool.options).toEqual({ codemode: false })
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('create then get returns the created goal with its exact ref', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-tools-'))
    try {
      const tools = goalTools(directory, dir => new GoalStore(dir))
      const create = tools.find(tool => tool.name === 'create_goal')!
      const get = tools.find(tool => tool.name === 'get_goal')!

      const created = JSON.parse((await create.execute({ objective: 'tool objective' }, {} as never)).content as string)
      expect(created.goal.objective).toBe('tool objective')
      expect(created.goal.roundsStarted).toBe(0)

      const read = JSON.parse((await get.execute({}, {} as never)).content as string)
      expect(read.goal.id).toBe(created.goal.id)
      expect(read.goal.revision).toBe(1)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
