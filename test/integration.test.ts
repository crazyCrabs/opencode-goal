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
import { GoalStore } from '../src/state.ts'

/** One goal tool as the plugin registers it (opencode 2.x tool shape). */
interface RegisteredTool {
  name: string
  /** As the host invokes it: with the session the tool is running in. */
  execute(args: unknown, context?: { sessionID?: string }): Promise<{ content: string }>
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
 * tools, the system-prompt hook, and the continuation loop — is captured for
 * the assertions below.
 */
async function serverHalf(directory: string) {
  const prompts: Array<{ sessionID: string; text: string }> = []
  /** Every `session.get` the adapter made, so a test can prove it made none. */
  const getCalls: string[] = []
  const tools: RegisteredTool[] = []
  const queue: ServerEvent[] = []
  let systemHook: ((event: SystemHookEvent) => void | Promise<void>) | undefined
  const inbox = {
    push: async (
      sessionID: string,
      text: string,
      itemType: string,
      project: string,
      withLocation = true,
    ): Promise<void> => {
      queue.push({
        type: 'session.inbox.enqueued',
        data: {
          sessionID,
          inboxID: `msg-${sessionID}`,
          item: { type: itemType, payload: { text, files: [] }, delivery: 'steer' },
        },
        ...withLocation === true ? { location: { directory: project } } : {},
      })
      await settle()
    },
  }

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
      // session lookup for location-less turn events. The directory is only ever
      // under `location`: eight live `session.get` results across four recordings
      // all reported `hasTopLevelDirectory: false`, and the flat shape this used
      // to return was the reason a dead branch survived in the adapter.
      get: async (input: { sessionID: string }) => {
        getCalls.push(input.sessionID)
        return { location: { directory }, parentID: undefined }
      },
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
    /**
     * A tool as the host invokes it.
     *
     * The session is the second argument of every real `execute`, and it is what
     * makes a goal belong to the conversation that asked for it. A test that
     * omits it gets `ses-integration`, the TUI's room, which is what most of these
     * tests mean; a test about another session names it.
     */
    tool: (name: string, sessionID = 'ses-integration'): RegisteredTool => {
      const found = tools.find(tool => tool.name === name)!
      return {
        name: found.name,
        execute: (args: unknown, context?: { sessionID?: string }) =>
          found.execute(args, { sessionID: context?.sessionID ?? sessionID }),
      }
    },
    /** Emit one `session.idle` event and wait for the driver to finish. */
    idle: async (sessionID: string): Promise<void> => {
      queue.push({ type: 'session.idle', data: { sessionID }, location: { directory } })
      await settle()
    },
    /** Emit one `session.created` event and wait for the driver to finish. */
    created: async (sessionID: string, sessionDirectory?: string, parentID?: string): Promise<void> => {
      const target = sessionDirectory ?? directory
      queue.push({
        type: 'session.created',
        data: {
          sessionID,
          ...parentID === undefined ? {} : { parentID },
          info: { id: sessionID, directory: target, ...parentID === undefined ? {} : { parentID } },
        },
        location: { directory: target },
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
    /**
     * Emit one `session.inbox.enqueued` — the wake source a waiting goal is told
     * to arrange. Shaped as the recordings shaped it: a `location`, and an item
     * tagged `user`.
     */
    inboxArrived: async (sessionID: string, text: string, itemType = 'user'): Promise<void> => {
      await inbox.push(sessionID, text, itemType, directory)
    },
    /** The same event, reported for a session in another project. */
    inboxArrivedIn: async (sessionID: string, text: string, project: string): Promise<void> => {
      await inbox.push(sessionID, text, 'user', project)
    },
    /**
     * The same wake event with no location envelope at all, which is what the
     * live opencode v2 server sends: four recordings had a location on this
     * event, the live run did not, and ticket 25 is the branch that noticed.
     */
    inboxArrivedBare: async (sessionID: string, text: string, itemType = 'user'): Promise<void> => {
      await inbox.push(sessionID, text, itemType, directory, false)
    },
    /**
     * Emit the turn-completion event opencode 2.x actually publishes —
     * `session.execution.succeeded|failed|interrupted`, with no location —
     * and wait for the driver to finish.
     */
    turnFinished: async (
      sessionID: string,
      outcome: 'succeeded' | 'failed' | 'interrupted' = 'succeeded',
      reason?: string,
      error?: { type: string; message: string; status?: number },
    ): Promise<void> => {
      const data: Record<string, unknown> = { sessionID }
      if (reason !== undefined) data.reason = reason
      if (error !== undefined) data.error = error
      queue.push({ type: `session.execution.${outcome}`, data })
      await settle()
    },
    /** Every session id the adapter looked up through `session.get`. */
    get lookups(): readonly string[] {
      return getCalls
    },
    /**
     * Emit one `session.step.started` — the durable, location-bearing event that
     * teaches the adapter a session's project directory — and wait.
     */
    stepStarted: async (sessionID: string, sessionDirectory?: string): Promise<void> => {
      queue.push({
        type: 'session.step.started',
        data: { sessionID, assistantMessageID: `msg-${sessionID}` },
        location: { directory: sessionDirectory ?? directory },
      })
      await settle()
    },
    /**
     * Emit one `session.tool.called` — a goal turn that acted. A turn with no tool
     * call at all is a goal talking without acting, and the second stall counter
     * stops it, so a test simulating a working loop has to say so.
     */
    toolCalled: async (sessionID: string, id: string): Promise<void> => {
      queue.push({
        type: 'session.tool.called',
        data: { sessionID, assistantMessageID: `msg-${sessionID}`, id, input: { command: 'ls' }, executed: true },
        location: { directory },
      })
      await settle()
    },
    /**
     * Emit one `session.tool.success` for a command that actually ran. Shaped as
     * the live bash example was shaped: `metadata` carries `status` and `exit`.
     */
    commandRan: async (sessionID: string, id: string, exit: number): Promise<void> => {
      queue.push({
        type: 'session.tool.success',
        data: {
          sessionID,
          assistantMessageID: `msg-${sessionID}`,
          id,
          content: [{ type: 'text', text: `Command exited with code ${exit}.` }],
          metadata: { status: 'completed', truncated: false, exit },
          executed: false,
        },
        location: { directory },
      })
      await settle()
    },
    /** Emit one `session.deleted` event and wait for the driver to finish. */
    deleted: async (sessionID: string): Promise<void> => {
      queue.push({ type: 'session.deleted', data: { sessionID }, location: { directory } })
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

describe('the trigger layer attributes a location-less turn without a lookup', () => {
  test('a step-started teaches the directory, so the completion event needs no lookup', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-trigger-step-'))
    try {
      const server = await serverHalf(directory)
      const tui = tuiHalf(directory)
      await tui.command.run('trigger objective')

      // a session this server never saw created: its turn is already running
      expect(server.lookups.length).toBe(0)

      // the step-started event carries the directory
      await server.stepStarted('ses-integration')
      expect(server.lookups.length).toBe(0)

      // so the location-less completion event is attributed from the map
      await server.turnFinished('ses-integration')
      expect(server.prompts.length).toBe(1)
      expect(server.prompts[0].text).toContain('round 2/25')
      // and no session lookup was made at any point
      expect(server.lookups.length).toBe(0)

      tui.cleanup()
      await server.cleanup()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a session with no step-started still resolves through the narrowed lookup', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-trigger-lookup-'))
    try {
      const server = await serverHalf(directory)
      const tui = tuiHalf(directory)
      await tui.command.run('lookup objective')

      // no step-started, no created: the map has nothing for this session
      await server.turnFinished('ses-integration')
      expect(server.lookups).toEqual(['ses-integration'])
      expect(server.prompts.length).toBe(1)
      expect(server.prompts[0].text).toContain('round 2/25')

      tui.cleanup()
      await server.cleanup()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("another project's step-started does not drive this project's goal", async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-trigger-other-'))
    try {
      const server = await serverHalf(directory)
      const tui = tuiHalf(directory)
      await tui.command.run('ownership objective')

      await server.stepStarted('ses-elsewhere', '/some/other/project')
      await server.turnFinished('ses-elsewhere')
      expect(server.prompts.length).toBe(0)

      tui.cleanup()
      await server.cleanup()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('a completion claim is cross-checked against the event stream', () => {
  const CLAIM = {
    summary: 'the parser handles escaped separators',
    criteria: [{ criterion: 'escaped separators do not split a field', evidence: ['bun test passed: 41 tests'] }],
    checks: [{ command: 'bun test', result: 'passed', exitCode: 0 }],
  }

  test('a command that actually ran backs the claim, end to end', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-claim-run-'))
    try {
      const server = await serverHalf(directory)
      await server.tool('create_goal').execute({ objective: 'claim objective' }, {} as never)
      await server.stepStarted('ses-integration')

      // the model runs the command; the event stream records that it ran
      await server.commandRan('ses-integration', 'call-1', 0)

      const result = JSON.parse(
        (
          await server.tool('update_goal').execute({ action: 'complete', claim: CLAIM }, {} as never)
        ).content as string,
      )
      expect(result.goal.phase).toBe('complete')
      // ...and the claim and the events agree
      expect(result.crossCheck[0].agrees).toBe(true)
      expect(result.warning).toBeUndefined()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a claim about a command that never ran is visible as a disagreement', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-claim-norun-'))
    try {
      const server = await serverHalf(directory)
      await server.tool('create_goal').execute({ objective: 'claim objective' }, {} as never)
      await server.stepStarted('ses-integration')

      // nothing ran, but the model claims it did
      const result = JSON.parse(
        (
          await server.tool('update_goal').execute({ action: 'complete', claim: CLAIM }, {} as never)
        ).content as string,
      )
      expect(result.goal.phase).toBe('complete')
      expect(result.crossCheck[0].agrees).toBe(false)
      expect(result.crossCheck[0].ranNothing).toBe(true)
      expect(result.warning).toContain('No command is recorded as having run')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a claim about a different exit code than the one that ran disagrees', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-claim-wrongexit-'))
    try {
      const server = await serverHalf(directory)
      await server.tool('create_goal').execute({ objective: 'claim objective' }, {} as never)
      await server.stepStarted('ses-integration')

      // the command ran and failed, but the claim says it passed
      await server.commandRan('ses-integration', 'call-2', 1)
      const result = JSON.parse(
        (
          await server.tool('update_goal').execute({ action: 'complete', claim: CLAIM }, {} as never)
        ).content as string,
      )
      expect(result.crossCheck[0].agrees).toBe(false)
      expect(result.warning).toBeUndefined()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('the external wait is durable and woken by a human', () => {
  test('a wait survives a restart, so the goal is still waiting after it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-wait-durable-'))
    try {
      const first = await serverHalf(directory)
      const tui = tuiHalf(directory)
      await tui.command.run('waiting objective')
      await first.stepStarted('ses-wait')
      const store = new GoalStore(directory, 'ses-integration')
      const ref = { id: store.view()!.id, revision: store.view()!.revision }
      store.wait(ref, 'waiting for the platform review', 60_000)

      // a restart
      const second = await serverHalf(directory)
      const restarted = new GoalStore(directory)
      expect(restarted.waitUntil).toBeGreaterThan(Date.now())
      expect(restarted.waitReason).toBe('waiting for the platform review')
      // and it is still suppressed: no round was admitted on the fresh process
      const before = second.prompts.length
      await second.idle('ses-wait-again')
      expect(second.prompts.length).toBe(before)

      tui.cleanup()
      await first.cleanup()
      await second.cleanup()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a human arriving ends the wait and arms the goal for its next round', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-wait-wake-'))
    try {
      const server = await serverHalf(directory)
      const tui = tuiHalf(directory)
      await tui.command.run('waiting objective')
      await server.stepStarted('ses-integration')
      const store = new GoalStore(directory, 'ses-integration')
      store.wait({ id: store.view()!.id, revision: store.view()!.revision }, 'waiting for the platform review', 60_000)

      // suppressed while the wait stands: the command plane's own first kick is
      // the only prompt there is, and the driver admits nothing on top of it
      await server.idle('ses-wake')
      expect(tui.prompts.length).toBe(1)
      expect(server.prompts.length).toBe(0)

      // a human sends a message: the wait ends, durably
      await server.inboxArrived('ses-integration', 'the review is done, carry on')
      const after = new GoalStore(directory).view()!
      expect(after.waitUntil).toBe(0)
      expect(after.waitReason).toBeUndefined()

      // and the goal is armed, so when this human's own turn finishes the next
      // round is admitted rather than reported disarmed
      expect(after.phase).toBe('active')
      await server.turnFinished('ses-integration')
      expect(server.prompts.length).toBe(1)
      expect(server.prompts[0].text).toContain('round 2/25')

      tui.cleanup()
      await server.cleanup()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a human arriving on a location-less inbox item still ends the wait', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-wait-bare-'))
    try {
      const server = await serverHalf(directory)
      const tui = tuiHalf(directory)
      await tui.command.run('waiting objective')
      await server.stepStarted('ses-integration')
      const store = new GoalStore(directory, 'ses-integration')
      store.wait({ id: store.view()!.id, revision: store.view()!.revision }, 'waiting for the platform review', 60_000)

      // The live v2 server reports this event with no location. Before ticket 25
      // this branch read the location directly and was the only one that did, so
      // the wake source was silent on the server the plugin has to run on.
      await server.inboxArrivedBare('ses-integration', 'the review is done, carry on')
      const after = new GoalStore(directory).view()!
      expect(after.waitUntil).toBe(0)
      expect(after.waitReason).toBeUndefined()
      expect(after.phase).toBe('active')

      // and the arriving turn drives the next round, armed rather than disarmed
      await server.turnFinished('ses-integration')
      expect(server.prompts.length).toBe(1)
      expect(server.prompts[0].text).toContain('round 2/25')

      tui.cleanup()
      await server.cleanup()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("a subagent session's inbox item does not wake the parent's goal", async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-wait-child-'))
    try {
      const server = await serverHalf(directory)
      const tui = tuiHalf(directory)
      await tui.command.run('waiting objective')
      const store = new GoalStore(directory, 'ses-integration')
      store.wait({ id: store.view()!.id, revision: store.view()!.revision }, 'waiting for the platform review', 60_000)

      // a subagent session, in this project, whose inbox item carries no
      // location — the resolver answers the subagent question the branch used to
      // answer by hand, so the parent's wait stands
      await server.created('ses-child', directory, 'ses-parent')
      await server.inboxArrivedBare('ses-child', 'a subagent arrived')
      expect(new GoalStore(directory).view()!.waitUntil).toBeGreaterThan(0)

      // and the human still wakes it
      await server.stepStarted('ses-integration')
      await server.inboxArrivedBare('ses-integration', 'the human arrived')
      expect(new GoalStore(directory).view()!.waitUntil).toBe(0)

      tui.cleanup()
      await server.cleanup()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("another project's inbox item does not end this project's wait", async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-wait-other-'))
    const other = mkdtempSync(join(tmpdir(), 'goal-wait-other-'))
    try {
      const server = await serverHalf(directory)
      const tui = tuiHalf(directory)
      await tui.command.run('waiting objective')
      // a session that genuinely lives in another project: the step-started
      // event that teaches the adapter its directory names that project, so the
      // map agrees with the inbox event instead of contradicting it. Naming the
      // same session here-and-elsewhere, as this helper call used to, is a state
      // no real session can be in, and the resolver reads the map first.
      await server.stepStarted('ses-other', other)
      const store = new GoalStore(directory, 'ses-integration')
      store.wait({ id: store.view()!.id, revision: store.view()!.revision }, 'waiting', 60_000)

      // a human arriving in a different project
      await server.inboxArrivedIn('ses-other', 'a human in another project', other)
      await settle()
      const after = new GoalStore(directory).view()!
      expect(after.waitUntil).toBeGreaterThan(0)

      tui.cleanup()
      await server.cleanup()
    } finally {
      rmSync(directory, { recursive: true, force: true })
      rmSync(other, { recursive: true, force: true })
    }
  })
})

describe('a provider refusal stops the goal durably', () => {
  /** The recorded live payload: a 403 from a provider demanding a subscription. */
  const REFUSAL = {
    type: 'provider.auth',
    message: 'Upstream request failed: An active OpenCode Go subscription is required to use Go models.',
    status: 403,
  }

  test('a refused turn blocks the goal with the provider as the reason', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-stops-refused-'))
    try {
      const server = await serverHalf(directory)
      const tui = tuiHalf(directory)
      await tui.command.run('refused objective')
      await server.stepStarted('ses-integration')

      // the turn fails with the provider's structured refusal
      await server.turnFinished('ses-integration', 'failed', undefined, REFUSAL)

      // the goal is durably blocked, and the reason says the provider
      const store = new GoalStore(directory)
      const view = store.view()!
      expect(view.phase).toBe('blocked')
      expect(view.blockedReason?.code).toBe('usage-limited')
      expect(view.blockedReason?.message).toContain('HTTP 403')
      // round 1 was the command plane's own kick; the server admitted nothing
      expect(tui.prompts.length).toBe(1)
      expect(server.prompts.length).toBe(0)

      tui.cleanup()
      await server.cleanup()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a transient failure does not stop the goal', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-stops-transient-'))
    try {
      const server = await serverHalf(directory)
      const tui = tuiHalf(directory)
      await tui.command.run('transient objective')
      await server.stepStarted('ses-integration')

      // a 500 is retryable; stopping the goal would lose the next attempt's work
      await server.toolCalled('ses-transient', 'call-transient')
      await server.turnFinished('ses-integration', 'failed', undefined, {
        type: 'server',
        message: 'internal error',
        status: 500,
      })

      const store = new GoalStore(directory)
      expect(store.view()!.phase).toBe('active')
      // and the loop keeps going on the next completion
      await server.toolCalled('ses-transient', 'call-transient-2')
      await server.turnFinished('ses-integration')
      expect(server.prompts.length).toBe(2)
      expect(server.prompts[1].text).toContain('round 3/25')

      tui.cleanup()
      await server.cleanup()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a stop survives a restart instead of being re-armed into the same refusal', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-stops-restart-'))
    try {
      const first = await serverHalf(directory)
      const tui = tuiHalf(directory)
      await tui.command.run('restart objective')
      await first.stepStarted('ses-integration')
      await first.turnFinished('ses-integration', 'failed', undefined, REFUSAL)
      tui.cleanup()
      await first.cleanup()

      // a fresh server process reads the same log: the goal is still stopped,
      // and nothing re-arms it back into the refusal that stopped it
      const second = await serverHalf(directory)
      await second.created('ses-restart-again')
      expect(second.prompts.length).toBe(0)
      expect(new GoalStore(directory).view()!.blockedReason?.code).toBe('usage-limited')

      await second.cleanup()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
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
      const read = JSON.parse((await server.tool('get_goal', 'ses-integration').execute({})).content)
      expect(read.goal.objective).toBe('integrate the halves')
      expect(read.goal.roundsStarted).toBe(1)

      // the system prompt carries the active goal
      expect(await server.system('ses-integration')).toContain('integrate the halves')

      // the working round ends: the server driver adopts the TUI-created goal.
      // The vehicle is the turn-completion event, not `session.idle` — the live
      // server never publishes an idle (ticket 22), and the adoption an idle
      // used to perform came from the store existing before the goal did, a
      // trick a per-session store cannot repeat.
      await server.turnFinished('ses-integration')
      expect(server.prompts.length).toBe(1)
      expect(server.prompts[0].text).toContain('round 2/25')
      expect(server.prompts[0].text).toContain('integrate the halves')

      // and it keeps going when that round's turn reports back, with no
      // further user action; an idle arriving mid-round admits nothing. The
      // round acts first, so the no-tool-call stall guard — which a
      // turn-completion vehicle feeds and an idle one did not — stays quiet
      // and only the self-sustaining property is under test.
      await server.toolCalled('ses-integration', 'call-integrate-2')
      await server.idle('ses-integration')
      expect(server.prompts.length).toBe(1)
      await server.turnFinished('ses-integration')
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

  test('a goal that only survived a restart auto-starts when a session opens', { timeout: 30_000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-integration-restart-'))
    try {
      // yesterday: a goal was created and left active
      const previous = await serverHalf(directory)
      await previous.tool('create_goal', 'ses-restart').execute({ objective: 'yesterday objective' })
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

      // the loop continues when that round's turn reports back through
      // session.execution.succeeded, with no further action — and an idle
      // arriving mid-round cannot admit a second one
      await server.idle('ses-restart')
      expect(server.prompts.length).toBe(1)
      await server.toolCalled('ses-restart', 'call-restart')
      await server.turnFinished('ses-restart')
      expect(server.prompts.length).toBe(2)
      expect(server.prompts[1].text).toContain('round 2/25')

      // a session opened mid-round defers to the running one: no parallel round
      await server.created('ses-second')
      expect(server.prompts.length).toBe(2)

      // the round finishes: round 3 runs, and a list-shaped creation payload
      // for another session defers the same way
      await server.toolCalled('ses-restart', 'call-restart-2')
      await server.turnFinished('ses-restart')
      expect(server.prompts.length).toBe(3)
      expect(server.prompts[2].text).toContain('round 3/25')
      await server.createdList('ses-third')
      expect(server.prompts.length).toBe(3)

      // the human interrupts round 3: no next round is admitted, and the goal
      // waits for a human turn in its own session. A session opened instead of
      // that one correctly inherits nothing — the goal belongs to ses-restart.
      await server.turnFinished('ses-restart', 'interrupted', 'user')
      expect(server.prompts.length).toBe(3)
      await server.created('ses-fourth')
      expect(server.prompts.length).toBe(3)
      // the human's own turn is the go-ahead: round 4 runs where the goal works.
      // The round acts first, so the stall guard — which counts the
      // interrupted turn and this one, both tool-less — stays quiet.
      await server.toolCalled('ses-restart', 'call-restart-3')
      await server.turnFinished('ses-restart')
      expect(server.prompts.length).toBe(4)
      expect(server.prompts[3].sessionID).toBe('ses-restart')
      expect(server.prompts[3].text).toContain('round 4/25')

      await server.cleanup()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  // Slow, not hung: the plugin's event stream polls at 1ms in a tight loop, which
  // starves the harness's millisecond-scale settle timers. The behaviour is not
  // the reason for the time.
  test('the autonomous loop advances round after round on turn completion', { timeout: 30_000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-integration-loop-'))
    try {
      const server = await serverHalf(directory)
      await server.tool('create_goal', 'ses-loop').execute({ objective: 'loop objective' })
      await server.created('ses-loop')

      // each finished turn admits exactly one more round, with no human input
      expect(server.prompts.length).toBe(1)
      for (const round of [1, 2, 3]) {
        await server.toolCalled('ses-loop', `call-${round}`)
        await server.turnFinished('ses-loop')
        expect(server.prompts.length).toBe(round + 1)
        expect(server.prompts[round].text).toContain(`round ${round + 1}/25`)
      }

      // a failed turn keeps the loop going; an interrupted-by-user turn does not
      await server.toolCalled('ses-loop', 'call-4')
      await server.turnFinished('ses-loop', 'failed')
      expect(server.prompts.length).toBe(5)
      await server.turnFinished('ses-loop', 'interrupted', 'user')
      expect(server.prompts.length).toBe(5)
      await server.toolCalled('ses-loop', 'call-5')
      await server.turnFinished('ses-loop')
      expect(server.prompts.length).toBe(6)

      // a deleted session stops being driven
      await server.deleted('ses-loop')
      await server.turnFinished('ses-loop')
      expect(server.prompts.length).toBe(6)

      await server.cleanup()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }), 30_000

  test('another project\'s session events do not drive this project\'s goal', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-integration-own-'))
    const other = mkdtempSync(join(tmpdir(), 'goal-integration-other-'))
    try {
      const server = await serverHalf(directory)
      await server.tool('create_goal').execute({ objective: 'owned objective' })

      // a session created in another project: another plugin instance owns it,
      // so its turns never admit rounds against this project's goal
      await server.created('ses-foreign', other)
      expect(server.prompts.length).toBe(0)
      await server.turnFinished('ses-foreign')
      expect(server.prompts.length).toBe(0)

      // a subagent session (it carries a parentID) is never driven either
      await server.created('ses-child', directory, 'ses-parent')
      expect(server.prompts.length).toBe(0)
      await server.turnFinished('ses-child')
      expect(server.prompts.length).toBe(0)

      await server.cleanup()
    } finally {
      rmSync(directory, { recursive: true, force: true })
      rmSync(other, { recursive: true, force: true })
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

describe('a goal that predates the process is re-armed by a human turn', () => {
  test('the opencode run case: goal and session both predate the process', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-adopt-both-predate-'))
    try {
      // yesterday: the goal was created, and a session was opened for it
      const yesterdays = await serverHalf(directory)
      await yesterdays.tool('create_goal', 'ses-old').execute({ objective: 'yesterday objective' })
      await yesterdays.stepStarted('ses-old')
      await yesterdays.cleanup()

      // today: a fresh process, and the session is still there. No
      // `session.created` will ever name it, so nothing re-arms the goal.
      const server = await serverHalf(directory)
      expect(server.prompts.length).toBe(0)

      // the human sends a message; the goal says nothing because it is disarmed
      await server.stepStarted('ses-old')
      await server.turnFinished('ses-old')

      // the finished human turn is the go-ahead: the goal is re-armed and its
      // first round is admitted, in the session the human is already in
      expect(server.prompts.length).toBe(1)
      expect(server.prompts[0].sessionID).toBe('ses-old')
      expect(server.prompts[0].text).toContain('round 1/25')
      expect(server.prompts[0].text).toContain('yesterday objective')

      // and the loop keeps going from there, with no further human input
      await server.toolCalled('ses-old', 'call-adopt')
      await server.turnFinished('ses-old')
      expect(server.prompts.length).toBe(2)
      expect(server.prompts[1].text).toContain('round 2/25')

      await server.cleanup()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('an interrupted round stops, and the next human turn restarts it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-adopt-interrupt-'))
    try {
      const yesterday = await serverHalf(directory)
      await yesterday.tool('create_goal', 'ses-int').execute({ objective: 'interrupted objective' })
      await yesterday.stepStarted('ses-int')
      await yesterday.cleanup()

      const server = await serverHalf(directory)
      expect(server.prompts.length).toBe(0)

      // the first human turn re-arms the goal and admits round 1
      await server.stepStarted('ses-int')
      await server.turnFinished('ses-int')
      expect(server.prompts.length).toBe(1)

      // the human takes the wheel mid-round: no next round is admitted
      await server.toolCalled('ses-int', 'call-int-1')
      await server.turnFinished('ses-int', 'interrupted', 'user')
      expect(server.prompts.length).toBe(1)

      // and the next human turn picks the goal back up
      await server.toolCalled('ses-int', 'call-int-2')
      await server.turnFinished('ses-int')
      expect(server.prompts.length).toBe(2)
      expect(server.prompts[1].text).toContain('round 2/25')

      await server.cleanup()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a goal that is not running is not re-armed into running', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-adopt-not-running-'))
    try {
      // the goal completed yesterday, so a human turn today means nothing
      const yesterday = await serverHalf(directory)
      await yesterday.tool('create_goal').execute({ objective: 'finished objective' })
      await yesterday.tool('update_goal').execute({
        action: 'complete',
        claim: {
          summary: 'the objective was met',
          criteria: [{ criterion: 'the objective was met', evidence: ['the tool reports it'] }],
          checks: [],
        },
      })
      await yesterday.stepStarted('ses-done')
      await yesterday.cleanup()

      const server = await serverHalf(directory)
      await server.stepStarted('ses-done')
      await server.turnFinished('ses-done')
      expect(server.prompts.length).toBe(0)

      await server.cleanup()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a paused goal is not re-armed either', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-adopt-paused-'))
    try {
      const yesterday = await serverHalf(directory)
      await yesterday.tool('create_goal').execute({ objective: 'paused objective' })
      await yesterday.tool('update_goal').execute({ action: 'pause' })
      await yesterday.stepStarted('ses-paused')
      await yesterday.cleanup()

      const server = await serverHalf(directory)
      await server.stepStarted('ses-paused')
      await server.turnFinished('ses-paused')
      expect(server.prompts.length).toBe(0)

      await server.cleanup()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
