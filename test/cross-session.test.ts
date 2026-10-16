import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenCodeGoalPlugin } from '../src/index.ts'
import { GoalStore } from '../src/state.ts'

/**
 * The human's report, verbatim:
 *
 *   我在用户目录下打开了 opencode 并使用 goal 创建了一个目标。同时我也在其他 session
 *   里面对话，当其他 session 里面的任务完成时，goal 的任务触发了。
 *
 * Two sessions in one project: the goal runs in one, the human talks in another.
 * The human's other session finishing a turn must not advance the goal.
 *
 * This file is the Phase 1 feedback loop for that bug and the regression test for
 * its fix. The minimal repro is the first test: one goal, one round in flight, one
 * turn completing in another session of the same project.
 */

type RegisteredTool = { name: string; execute: (input: never) => Promise<unknown> }

/**
 * Wait for the plugin to finish with the events queued so far.
 *
 * Adaptive rather than a fixed tick count: the queue drains synchronously as the
 * subscription yields, so "empty and staying empty" is the signal, and it costs a
 * few ticks instead of forty. A fixed 40 ticks measured ~650ms per event under
 * this harness's event-loop load — eight times its nominal cost — which is what
 * made a five-event test exceed its timeout. The cap is a backstop, not the
 * mechanism.
 */
async function drain(pending: () => number): Promise<void> {
  let quiet = 0
  for (let tick = 0; tick < 400 && quiet < 4; tick++) {
    if (pending() === 0) quiet += 1
    else quiet = 0
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

/** Silence the plugin's lifecycle logs so test output carries the signal only. */
function silence(): () => void {
  const original = console.log
  console.log = () => {}
  return () => {
    console.log = original
  }
}

/**
 * The server half of the plugin, wired the way the real one is: one store per
 * directory, the driver fed by the event stream. Every session in this project
 * resolves to the same directory, which is the situation the human described.
 */
async function serverHalf(directory: string) {
  const prompts: Array<{ sessionID: string; text: string }> = []
  const tools: RegisteredTool[] = []
  const queue: Array<Record<string, unknown>> = []
  const settle = (): Promise<void> => drain(() => queue.length)

  const context = {
    location: { directory },
    tool: {
      transform: async (register: (editor: { add: (tool: RegisteredTool) => void }) => void) => {
        register({ add: tool => tools.push(tool) })
        return { dispose: async () => {} }
      },
    },
    session: {
      hook: async () => ({ dispose: async () => {} }),
      prompt: async (input: { sessionID: string; text: string }) => {
        prompts.push({ sessionID: input.sessionID, text: input.text })
        return {}
      },
      context: async () => [],
      get: async (input: { sessionID: string }) => ({
        location: { directory },
        parentID: undefined,
        id: input.sessionID,
      }),
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          for (;;) {
            while (queue.length > 0) yield queue.shift()!
            if (signal.aborted) return
            await new Promise(resolve => setTimeout(resolve, 1))
          }
        },
      }),
    },
  }

  const dispose = await OpenCodeGoalPlugin.setup(context as never)

  return {
    prompts,
    /** How many events are still queued for the subscription to yield. */
    pending: () => queue.length,
    tool: (name: string): RegisteredTool => tools.find(tool => tool.name === name)!,
    created: async (sessionID: string): Promise<void> => {
      queue.push({
        type: 'session.created',
        data: { sessionID, info: { id: sessionID, directory } },
        location: { directory },
      })
      await settle()
    },
    /** A step began in a session, which is how a directory is learned. */
    stepStarted: async (sessionID: string): Promise<void> => {
      queue.push({ type: 'session.step.started', data: { sessionID }, location: { directory } })
      await settle()
    },
    /** A tool ran in a session, which is how the goal is seen to have acted. */
    toolCalled: async (sessionID: string): Promise<void> => {
      queue.push({ type: 'session.tool.success', data: { sessionID, tool: 'bash' } })
      await settle()
    },
    turnFinished: async (
      sessionID: string,
      error?: { type: string; message: string; status?: number },
    ): Promise<void> => {
      const data: Record<string, unknown> = { sessionID }
      if (error !== undefined) data.error = error
      queue.push({ type: 'session.execution.succeeded', data })
      await settle()
    },
    /** Wait for the plugin to finish with whatever is queued, emitting nothing. */
    settle,
    cleanup: dispose,
  }
}

describe('a turn in another session of the same project', () => {
  test('does not advance the goal, and does not spend its guardrails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-cross-session-'))
    const restore = silence()
    try {
      const server = await serverHalf(directory)
      const store = new GoalStore(directory)

      // the human creates the goal, and the server driver starts round 1 in the
      // session that was just created — the goal's own room
      store.create('build an ancient Chinese architecture sandbox in html', 25, 0)
      await server.created('ses-goal')
      expect(server.prompts.length).toBe(1)
      expect(server.prompts[0].sessionID).toBe('ses-goal')

      // the goal's own round reports back: round 2 is admitted, in its own room
      await server.turnFinished('ses-goal')
      expect(server.prompts.length).toBe(2)
      expect(server.prompts[1].sessionID).toBe('ses-goal')

      // the goal acted, so its stall counter is clean and only the cross-session
      // defect can show
      await server.toolCalled('ses-goal')

      // the human talks in ANOTHER session of the same project, and that turn
      // completes. This is the reported symptom.
      await server.turnFinished('ses-human')

      expect(server.prompts.length).toBe(2)
      expect(store.view()!.roundsStarted).toBe(2)
      expect(store.view()!.phase).toBe('active')
      // nothing was submitted into the human's session
      expect(server.prompts.some(prompt => prompt.sessionID === 'ses-human')).toBe(false)
      // and the goal was not blocked by the human's tool-less turn
      expect(store.view()!.blockedReason).toBeUndefined()

      await server.cleanup()
    } finally {
      restore()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('many human turns in other sessions leave the goal completely alone', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-cross-many-'))
    const restore = silence()
    try {
      const server = await serverHalf(directory)
      const store = new GoalStore(directory)
      store.create('another objective', 25, 0)
      await server.created('ses-goal')
      await server.turnFinished('ses-goal')
      await server.toolCalled('ses-goal')
      const rounds = store.view()!.roundsStarted

      // a human working alongside a goal produces turns in several sessions
      for (let i = 0; i < 5; i++) await server.turnFinished(`ses-human-${i}`)

      expect(store.view()!.roundsStarted).toBe(rounds)
      expect(store.view()!.phase).toBe('active')
      expect(server.prompts.filter(p => p.sessionID.startsWith('ses-human')).length).toBe(0)

      await server.cleanup()
    } finally {
      restore()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('the goal still drives its own room, with no human input at all', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-cross-own-'))
    const restore = silence()
    try {
      const server = await serverHalf(directory)
      const store = new GoalStore(directory)
      store.create('self-sustaining objective', 25, 0)
      await server.created('ses-goal')

      // the loop must keep advancing on its own session's completions alone. The
      // goal acts each round, so the stall guard stays quiet and only the
      // self-sustaining property is under test.
      for (let round = 2; round <= 4; round++) {
        await server.toolCalled('ses-goal')
        await server.turnFinished('ses-goal')
        expect(server.prompts.length).toBe(round)
        expect(server.prompts[round - 1].sessionID).toBe('ses-goal')
        expect(store.view()!.roundsStarted).toBe(round)
      }

      await server.cleanup()
    } finally {
      restore()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a goal and session that both predate the process still start', async () => {
    // The case the fix must not break: `opencode run --standalone`, and a restart.
    // The goal predates the process and so does its session, so no
    // `session.created` will ever name it and the goal has no room of its own.
    const directory = mkdtempSync(join(tmpdir(), 'goal-cross-predate-'))
    const restore = silence()
    try {
      const yesterdays = await serverHalf(directory)
      await yesterdays.tool('create_goal').execute({ objective: 'yesterday objective' } as never)
      await yesterdays.stepStarted('ses-old')
      await yesterdays.cleanup()

      const server = await serverHalf(directory)
      expect(server.prompts.length).toBe(0)

      // the human sends a message in the session the goal belongs to
      await server.stepStarted('ses-old')
      await server.turnFinished('ses-old')

      expect(server.prompts.length).toBe(1)
      expect(server.prompts[0].sessionID).toBe('ses-old')
      expect(server.prompts[0].text).toContain('round 1/25')
      expect(server.prompts[0].text).toContain('yesterday objective')

      await server.cleanup()
    } finally {
      restore()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a session created later does not steal the goal away from its room', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-cross-steal-'))
    const restore = silence()
    try {
      const server = await serverHalf(directory)
      const store = new GoalStore(directory)
      store.create('steal objective', 25, 0)
      await server.created('ses-goal')
      await server.turnFinished('ses-goal')

      // the human opens a brand new session in the same project
      await server.created('ses-new')
      await server.turnFinished('ses-new')

      // the goal's room is the one it has been working in, not the newest one
      expect(store.session?.sessionID).toBe('ses-goal')
      expect(server.prompts.filter(p => p.sessionID === 'ses-new').length).toBe(0)
      expect(store.view()!.roundsStarted).toBe(2)

      await server.cleanup()
    } finally {
      restore()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
