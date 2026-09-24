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

  test('a reported impasse is challenged for three rounds before it stops the goal', async () => {
    // The prompt already asks the model to report an impasse only once it has
    // persisted three rounds. This is what enforces that instead of trusting it:
    // the first two reports are recorded and answered with "keep working", and
    // only the third stops the goal.
    const directory = mkdtempSync(join(tmpdir(), 'goal-tools-gate-'))
    try {
      const tools = goalTools(directory, dir => new GoalStore(dir))
      const create = tools.find(tool => tool.name === 'create_goal')!
      const update = tools.find(tool => tool.name === 'update_goal')!
      const get = tools.find(tool => tool.name === 'get_goal')!

      const created = JSON.parse((await create.execute({ objective: 'gated objective' }, {} as never)).content as string)
      const ref = { goal_id: created.goal.id, revision: created.goal.revision }

      const report = async (): Promise<Record<string, never>> =>
        JSON.parse((await update.execute({ ...ref, action: 'blocked', blocked_reason: 'waiting on a human decision' }, {} as never)).content as string) as Record<string, never>

      // rounds 1 and 2: recorded, not accepted
      const first = await report()
      expect(first.status).toBe('recorded')
      expect(first.consecutiveRounds).toBe(1)
      expect(first.note).toContain('keep working')
      const second = await report()
      expect(second.status).toBe('recorded')
      expect(second.consecutiveRounds).toBe(2)

      // the goal is still running, so the model can go on working
      const mid = JSON.parse((await get.execute({}, {} as never)).content as string)
      expect(mid.goal.phase).toBe('active')

      // round 3: the same impasse has now persisted, so the goal stops
      const third = await report()
      expect(third.goal.phase).toBe('blocked')
      expect(third.goal.blockedReason.code).toBe('model-reported')
      expect(third.goal.blockedReason.message).toBe('waiting on a human decision')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a different obstacle each round never accumulates into a stop', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-tools-gate-diff-'))
    try {
      const tools = goalTools(directory, dir => new GoalStore(dir))
      const create = tools.find(tool => tool.name === 'create_goal')!
      const update = tools.find(tool => tool.name === 'update_goal')!
      const get = tools.find(tool => tool.name === 'get_goal')!

      const created = JSON.parse((await create.execute({ objective: 'diff objective' }, {} as never)).content as string)
      const ref = { goal_id: created.goal.id, revision: created.goal.revision }

      for (const obstacle of ['no network in the sandbox', 'the API key is missing', 'the build cache is corrupt']) {
        const result = JSON.parse(
          (await update.execute({ ...ref, action: 'blocked', blocked_reason: obstacle }, {} as never)).content as string,
        )
        // a new condition resets the run rather than adding to it
        expect(result.status).toBe('recorded')
        expect(result.consecutiveRounds).toBe(1)
      }
      const read = JSON.parse((await get.execute({}, {} as never)).content as string)
      expect(read.goal.phase).toBe('active')
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
