/**
 * End-to-end wiring of the two plugin halves: the TUI `/goal` command plane
 * creates and drives the first round locally, while the server-side tools and
 * continuation driver observe the same durable log and take over from there.
 */

import { describe, expect, test, afterEach, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGoalTuiPlugin, type TuiGoalContext, type TuiKeymapCommandInput, type TuiKeymapLayerInput } from '../src/tui.tsx'
import { OpenCodeGoalPlugin } from '../src/index.ts'

/** One goal tool as the plugin registers it (opencode 2.x tool shape). */
interface RegisteredTool {
  name: string
  execute(args: unknown): Promise<{ content: string }>
}

/** One system-prompt hook event. */
interface SystemHookEvent {
  sessionID: string
  system: Array<{ type: string; text: string }>
}

/** One event the server plugin observes (opencode 2.x event shape). */
interface ServerEvent {
  type: string
  data: Record<string, unknown>
  location?: { directory: string }
}

/**
 * Let the plugin's event loop drain the queued events and the driver finish:
 * the loop awaits each event's handling before it pulls the next one, so the
 * work is microtask-bound once it picks the event up (the loop polls at 1ms).
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 30; turn++) await new Promise(resolve => setTimeout(resolve, 2))
}

/** The plugin logs its lifecycle through the console; keep test output readable. */
function silenceGoalLogs(): () => void {
  const original = console.log
  console.log = () => {}
  return () => {
    console.log = original
  }
}

let restoreLog: (() => void) | undefined

beforeEach(() => {
  restoreLog = silenceGoalLogs()
})

afterEach(() => {
  restoreLog?.()
  restoreLog = undefined
})

/** The TUI half: a mock of the real TUI context with an in-process client. */
function tuiHalf(directory: string) {
  const prompts: Array<{ sessionID: string; text: string }> = []
  const toasts: Array<{ variant?: string; message: string }> = []
  const layers: TuiKeymapLayerInput[] = []
  const slots: Array<{ append: string; render: () => unknown }> = []
  const context = {
    location: { directory },
    client: {
      session: {
        prompt: async (input: { sessionID: string; text: string }) => {
          prompts.push({ sessionID: input.sessionID, text: input.text })
          return {}
        },
      },
    },
    data: { on: () => () => {}, session: { status: () => 'idle' } },
    keymap: {
      layer: (input: () => TuiKeymapLayerInput) => {
        layers.push(input())
      },
    },
    ui: {
      toast: { show: (toast: { variant?: string; message: string }) => toasts.push(toast) },
      dialog: {
        confirm: async () => true,
        prompt: async () => undefined,
        alert: async () => {},
        clear: () => {},
      },
      router: { current: () => ({ type: 'session', sessionID: 'ses-integration' }) },
      slot: (claim: { append: string; render: () => unknown }) => {
        slots.push(claim)
      },
    },
  } as unknown as TuiGoalContext
  const plugin = createGoalTuiPlugin({ refreshIntervalMs: 0 })
  const cleanup = plugin.setup(context)
  // the keymap layer registers from the TUI render tree, not from setup
  slots.find(claim => claim.append === 'app')?.render()
  const command = layers[0]?.commands.find((entry: TuiKeymapCommandInput) => entry.id === 'goal.command')
  return { prompts, toasts, cleanup, command: command! }
}

/**
 * The server half: the opencode 2.x plugin definition runs its `setup` against
 * a mock plugin context, and everything it registers imperatively — the goal
 * tools, the system-prompt hook, and the `session.idle` continuation loop — is
 * captured for the assertions below.
 */
async function serverHalf(directory: string) {
  const prompts: Array<{ sessionID: string; text: string }> = []
  const tools: RegisteredTool[] = []
  const queue: ServerEvent[] = []
  let systemHook: ((event: SystemHookEvent) => void | Promise<void>) | undefined

  const context = {
    location: { directory },
    tool: {
      transform: async (register: (editor: { add: (tool: RegisteredTool) => void }) => void) => {
        register({ add: tool => tools.push(tool) })
        return { dispose: async () => {} }
      },
    },
    session: {
      hook: async (_name: string, handler: (event: SystemHookEvent) => void | Promise<void>) => {
        systemHook = handler
        return { dispose: async () => {} }
      },
      prompt: async (input: { sessionID: string; text: string }) => {
        prompts.push({ sessionID: input.sessionID, text: input.text })
        return {}
      },
      // no assistant turn is reported for these sessions: nothing is attributed
      context: async () => [],
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
    tool: (name: string): RegisteredTool => tools.find(tool => tool.name === name)!,
    /** Emit one `session.idle` event and wait for the driver to finish. */
    idle: async (sessionID: string): Promise<void> => {
      queue.push({ type: 'session.idle', data: { sessionID }, location: { directory } })
      await settle()
    },
    /** Emit one `session.created` event and wait for the driver to finish. */
    created: async (sessionID: string): Promise<void> => {
      queue.push({
        type: 'session.created',
        data: { sessionID, info: { id: sessionID, directory } },
        location: { directory },
      })
      await settle()
    },
    /** Emit one `session.created` event reported as a list, as the schema types it. */
    createdList: async (sessionID: string): Promise<void> => {
      queue.push({
        type: 'session.created',
        data: [{ sessionID, info: { id: sessionID, directory } }],
        location: { directory },
      })
      await settle()
    },
    /** Render the system prompt for one session through the registered hook. */
    system: async (sessionID: string): Promise<string> => {
      const event: SystemHookEvent = { sessionID, system: [] }
      await systemHook?.(event)
      return event.system.map(part => part.text).join('\n')
    },
    cleanup: async () => {
      await dispose?.()
    },
  }
}

describe('server plugin definition', () => {
  test('exports the object shape the opencode 2.x loader schema requires', () => {
    expect(typeof OpenCodeGoalPlugin).toBe('object')
    expect(OpenCodeGoalPlugin.id).toBe('opencode-goal')
    expect(typeof OpenCodeGoalPlugin.setup).toBe('function')
  })
})

describe('TUI command plane + server driver', () => {
  test('a goal created in the TUI is continued by the server driver on idle', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-integration-'))
    try {
      // the server half starts first (plugin init materializes its store)
      const server = await serverHalf(directory)

      // goal control lives in the TUI half: the server registers only model tools
      expect(server.tool('get_goal')).toBeDefined()
      expect(server.tool('create_goal')).toBeDefined()
      expect(server.tool('update_goal')).toBeDefined()
      expect(server.tool('goal_wait')).toBeDefined()

      // the user types `/goal integrate the halves` in the TUI
      const tui = tuiHalf(directory)
      await tui.command.run('integrate the halves')

      // the command itself never becomes a model turn: only the working round does
      expect(tui.prompts.length).toBe(1)
      expect(tui.prompts[0].sessionID).toBe('ses-integration')
      expect(tui.prompts[0].text).toContain('integrate the halves')
      expect(tui.prompts[0].text).toContain('round 1/25')
      expect(server.prompts.length).toBe(0)
      expect(tui.toasts.some(toast => toast.message.includes('Goal created'))).toBe(true)

      // the model tools read the same durable goal
      const read = JSON.parse((await server.tool('get_goal').execute({})).content)
      expect(read.goal.objective).toBe('integrate the halves')
      expect(read.goal.roundsStarted).toBe(1)

      // the system prompt carries the active goal
      expect(await server.system('ses-integration')).toContain('integrate the halves')

      // the working round ends: the server driver adopts the TUI-created goal
      await server.idle('ses-integration')
      expect(server.prompts.length).toBe(1)
      expect(server.prompts[0].text).toContain('round 2/25')
      expect(server.prompts[0].text).toContain('integrate the halves')

      // and it keeps going on the next idle without any further user action
      await server.idle('ses-integration')
      expect(server.prompts.length).toBe(2)
      expect(server.prompts[1].text).toContain('round 3/25')

      tui.cleanup()
      await server.cleanup()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a TUI pause is honored by the driver and a TUI resume restarts it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-integration-pause-'))
    try {
      const server = await serverHalf(directory)
      const tui = tuiHalf(directory)

      await tui.command.run('pausable objective')
      expect(server.prompts.length).toBe(0)

      await tui.command.run('pause')
      await server.idle('ses-integration')
      expect(server.prompts.length).toBe(0)

      await tui.command.run('resume')
      expect(tui.prompts.length).toBe(2) // create + resume kick
      await server.idle('ses-integration')
      expect(server.prompts.length).toBe(1)
      expect(server.prompts[0].text).toContain('round 3/25')

      tui.cleanup()
      await server.cleanup()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a goal that only survived a restart auto-starts when a session opens', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-integration-restart-'))
    try {
      // yesterday: a goal was created and left active
      const previous = await serverHalf(directory)
      await previous.tool('create_goal').execute({ objective: 'yesterday objective' })
      await previous.cleanup()

      // today: a fresh server process materializes its store. The goal only
      // survived, so an idle with no session activity stays quiet.
      const server = await serverHalf(directory)
      await server.idle('ses-restart')
      expect(server.prompts.length).toBe(0)

      // the user opens a session: no manual resume, round 1 runs there
      await server.created('ses-restart')
      expect(server.prompts.length).toBe(1)
      expect(server.prompts[0].text).toContain('round 1/25')
      expect(server.prompts[0].text).toContain('yesterday objective')

      // the loop continues on idle in that session, with no further action
      await server.idle('ses-restart')
      expect(server.prompts.length).toBe(2)
      expect(server.prompts[1].text).toContain('round 2/25')

      // a session opened after that round finished adopts the goal and carries on
      await server.created('ses-second')
      expect(server.prompts.length).toBe(3)
      expect(server.prompts[2].sessionID).toBe('ses-second')
      expect(server.prompts[2].text).toContain('round 3/25')

      // a list-shaped creation payload drives the same round
      await server.createdList('ses-third')
      expect(server.prompts.length).toBe(4)
      expect(server.prompts[3].sessionID).toBe('ses-third')
      expect(server.prompts[3].text).toContain('round 4/25')

      await server.cleanup()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a goal left waiting is not woken by a session opening', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-integration-adopt-wait-'))
    try {
      const server = await serverHalf(directory)
      // the model asks to wait for an external event
      await server.tool('create_goal').execute({ objective: 'waiting objective' })
      const goal = JSON.parse((await server.tool('get_goal').execute({})).content).goal
      await server.tool('goal_wait').execute({
        goal_id: goal.id,
        revision: goal.revision,
        reason: 'waiting for review',
        resume_after_ms: 600_000,
      })

      await server.created('ses-wait')
      expect(server.prompts.length).toBe(0)

      await server.cleanup()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
