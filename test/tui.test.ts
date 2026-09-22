import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createGoalTuiPlugin,
  goalSidebarSummary,
  type TuiGoalContext,
  type TuiKeymapCommandInput,
  type TuiKeymapLayerInput,
} from '../src/tui.tsx'
import { GoalStore } from '../src/state.ts'

interface Toast {
  variant?: string
  message: string
  duration?: number
}

interface SlotClaim {
  append: string
  render: (input: { sessionID?: string }) => unknown
}

interface Mock {
  directory: string
  context: TuiGoalContext
  toasts: Toast[]
  prompts: Array<{ sessionID: string; text: string }>
  slots: SlotClaim[]
  confirms: Array<{ title: string; message: string }>
  objectivePrompts: Array<{ title: string }>
  state: { confirmResult: boolean; promptResult: string | undefined; status: string }
  layers: TuiKeymapLayerInput[]
  /** Mount the `app` slot claim the way the TUI renders it, inside its render tree. */
  mountKeymapLayer(): void
  slot(append: string): SlotClaim | undefined
  command(id: string): TuiKeymapCommandInput
  unsubscribed(): boolean
}

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop()
    cleanup?.()
  }
})

/**
 * The mock harness: a mock of the real TUI context plus everything the plugin
 * registers during setup, captured for the assertions below.
 */
function makeContext(directory: string) {
  const toasts: Toast[] = []
  const prompts: Array<{ sessionID: string; text: string }> = []
  const slots: SlotClaim[] = []
  const confirms: Mock['confirms'] = []
  const objectivePrompts: Mock['objectivePrompts'] = []
  const layers: TuiKeymapLayerInput[] = []
  const state = { confirmResult: true, promptResult: 'objective from the dialog' as string | undefined, status: 'idle' }
  let unsubscribed = false

  const context: TuiGoalContext = {
    location: { directory },
    client: {
      session: {
        prompt: async input => {
          prompts.push({ sessionID: input.sessionID, text: input.text })
          return {}
        },
      },
    },
    data: {
      on: () => () => {
        unsubscribed = true
      },
      session: { status: () => state.status },
    },
    keymap: {
      // the real TUI owns the layer for the calling component's lifetime
      layer: input => {
        layers.push(input())
      },
    },
    ui: {
      toast: { show: toast => toasts.push(toast) },
      dialog: {
        confirm: async input => {
          confirms.push({ title: input.title, message: input.message })
          return state.confirmResult
        },
        prompt: async input => {
          objectivePrompts.push({ title: input.title })
          return state.promptResult
        },
        alert: async () => {},
        clear: () => {},
      },
      router: { current: () => ({ type: 'session', sessionID: 'ses-goal' }) },
      slot: claim => slots.push(claim),
    },
  }

  return { context, toasts, prompts, slots, confirms, objectivePrompts, layers, state, unsubscribed: () => unsubscribed }
}

/** Build the plugin against a mock of the real TUI context (opencode 2.x API). */
function setup(): Mock {
  const directory = mkdtempSync(join(tmpdir(), 'goal-tui-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))

  const harness = makeContext(directory)
  const cleanup = createGoalTuiPlugin({ refreshIntervalMs: 0 }).setup(harness.context)
  cleanups.push(cleanup)

  const mountKeymapLayer = (): void => {
    harness.slots.find(claim => claim.append === 'app')?.render({})
  }
  mountKeymapLayer()
  const commands = harness.layers[0]?.commands ?? []

  return {
    directory,
    context: harness.context,
    toasts: harness.toasts,
    prompts: harness.prompts,
    slots: harness.slots,
    confirms: harness.confirms,
    objectivePrompts: harness.objectivePrompts,
    state: harness.state,
    layers: harness.layers,
    mountKeymapLayer,
    slot: append => harness.slots.find(claim => claim.append === append),
    command: id => commands.find(command => command.id === id)!,
    unsubscribed: harness.unsubscribed,
  }
}

describe('tui goal command plane', () => {
  test('registers the keymap layer from the TUI render tree, never from setup', () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-tui-'))
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }))

    const harness = makeContext(directory)
    // setup runs where the TUI activates plugins: outside Keymap.Provider, so
    // calling the keymap hook here throws `Keymap.Provider is missing`
    createGoalTuiPlugin({ refreshIntervalMs: 0 }).setup(harness.context)
    expect(harness.layers.length).toBe(0)

    // the layer is claimed from a slot render, which the TUI mounts inside its
    // render tree (the same pattern the built-in plugins use)
    harness.slots.find(claim => claim.append === 'app')?.render({})
    expect(harness.layers.length).toBe(1)
    expect(harness.layers[0].commands.map(command => command.id)).toContain('goal.command')
  })

  test('registers the /goal slash command, palette entries, and the sidebar slot', () => {
    const mock = setup()
    const command = mock.command('goal.command')
    expect(command.slash).toEqual({ name: 'goal', arguments: true })
    expect(command.palette).toBe(true)
    expect(mock.command('goal.status')).toBeDefined()
    expect(mock.command('goal.pause')).toBeDefined()
    expect(mock.command('goal.resume')).toBeDefined()
    expect(mock.command('goal.clear')).toBeDefined()
    expect(mock.slot('sidebar.content')?.append).toBe('sidebar.content')
  })

  test('status renders a direct toast and spends no model turn', async () => {
    const mock = setup()
    await mock.command('goal.command').run!('status')
    expect(mock.toasts.length).toBe(1)
    expect(mock.toasts[0].variant).toBe('info')
    expect(mock.toasts[0].message).toContain('No goal is currently set')
    expect(mock.prompts.length).toBe(0)
  })

  test('create executes locally, persists durably, and kicks the first round', async () => {
    const mock = setup()
    await mock.command('goal.command').run!('ship the fix')

    // one working round is submitted: the command itself never becomes a model turn
    expect(mock.prompts.length).toBe(1)
    expect(mock.prompts[0].sessionID).toBe('ses-goal')
    expect(mock.prompts[0].text).toContain('ship the fix')
    expect(mock.prompts[0].text).toContain('round 1/25')
    expect(mock.toasts.some(toast => toast.message.includes('Goal created'))).toBe(true)

    const store = new GoalStore(mock.directory)
    expect(store.current?.objective).toBe('ship the fix')
    expect(store.current?.phase).toBe('active')
    expect(store.current?.roundsStarted).toBe(1)
  })

  test('flags reach the durable goal (--rounds and --tokens)', async () => {
    const mock = setup()
    await mock.command('goal.command').run!('--tokens 100k --rounds 3 budgeted work')
    const store = new GoalStore(mock.directory)
    expect(store.current?.objective).toBe('budgeted work')
    expect(store.current?.maxGoalRounds).toBe(3)
    expect(store.current?.tokenBudget).toBe(100_000)
    expect(mock.prompts[0].text).toContain('round 1/3')
    expect(mock.prompts[0].text).toContain('budget 0/100000')
  })

  test('replacing a live goal asks first and keeps it when declined', async () => {
    const mock = setup()
    await mock.command('goal.command').run!('first objective')
    mock.toasts.length = 0
    mock.prompts.length = 0

    mock.state.confirmResult = false
    await mock.command('goal.command').run!('second objective')

    expect(mock.confirms.length).toBe(1)
    expect(mock.toasts[0].message).toContain('Kept the current goal')
    expect(new GoalStore(mock.directory).current?.objective).toBe('first objective')
    expect(mock.prompts.length).toBe(0)

    mock.state.confirmResult = true
    await mock.command('goal.command').run!('second objective')

    expect(mock.confirms.length).toBe(2)
    expect(new GoalStore(mock.directory).current?.objective).toBe('second objective')
    expect(mock.prompts.length).toBe(1)
    expect(mock.prompts[0].text).toContain('second objective')
  })

  test('a bare /goal with no goal asks for the objective', async () => {
    const mock = setup()
    await mock.command('goal.command').run!('')
    expect(mock.objectivePrompts[0].title).toBe('Set goal')
    expect(new GoalStore(mock.directory).current?.objective).toBe('objective from the dialog')
    expect(mock.prompts.length).toBe(1)
  })

  test('a cancelled objective prompt changes nothing', async () => {
    const mock = setup()
    mock.state.promptResult = undefined
    await mock.command('goal.command').run!('')
    expect(new GoalStore(mock.directory).current).toBeUndefined()
    expect(mock.prompts.length).toBe(0)
    expect(mock.toasts.length).toBe(0)
  })

  test('pause stops continuation without another model turn; resume restarts it', async () => {
    const mock = setup()
    await mock.command('goal.command').run!('pauseable work')
    expect(mock.prompts.length).toBe(1)

    await mock.command('goal.command').run!('pause')
    expect(new GoalStore(mock.directory).current?.phase).toBe('paused')
    expect(mock.prompts.length).toBe(1)

    await mock.command('goal.command').run!('resume')
    expect(new GoalStore(mock.directory).current?.phase).toBe('active')
    expect(mock.prompts.length).toBe(2)
    expect(mock.prompts[1].text).toContain('round 2/25')
  })

  test('a running session defers the kick to the server driver', async () => {
    const mock = setup()
    mock.state.status = 'running'
    await mock.command('goal.command').run!('work while busy')
    expect(new GoalStore(mock.directory).current?.objective).toBe('work while busy')
    expect(new GoalStore(mock.directory).current?.roundsStarted).toBe(0)
    expect(mock.prompts.length).toBe(0)
  })

  test('invalid usage and rejected domain commands render direct feedback', async () => {
    const mock = setup()
    await mock.command('goal.command').run!('edit')
    expect(mock.toasts[0].variant).toBe('error')
    expect(mock.toasts[0].message).toContain('Invalid /goal command')

    mock.toasts.length = 0
    await mock.command('goal.command').run!('edit nothing here')
    expect(mock.toasts[0].variant).toBe('warning')
    expect(mock.toasts[0].message).toContain('No goal is currently set')
    expect(mock.prompts.length).toBe(0)
  })

  test('clear removes the goal and submits no turn', async () => {
    const mock = setup()
    await mock.command('goal.command').run!('temporary work')
    mock.prompts.length = 0

    await mock.command('goal.command').run!('clear')
    expect(new GoalStore(mock.directory).current).toBeUndefined()
    expect(mock.prompts.length).toBe(0)
  })

  test('the sidebar summary reads the durable log and palette commands drive it', async () => {
    const mock = setup()
    await mock.command('goal.command').run!('sidebar objective')
    mock.prompts.length = 0

    const claim = mock.slot('sidebar.content')
    expect(claim?.append).toBe('sidebar.content')
    expect(typeof claim?.render).toBe('function')

    const goal = new GoalStore(mock.directory).view()
    expect(goalSidebarSummary(goal).headline).toBe('active · sidebar objective')
    expect(goalSidebarSummary(goal).detail).toBe('rounds 1/25')
    expect(goalSidebarSummary(undefined).headline).toBe('No goal — /goal <objective>')

    await mock.command('goal.pause').run!()
    expect(goalSidebarSummary(new GoalStore(mock.directory).view()).headline).toBe('paused · sidebar objective')
    expect(mock.prompts.length).toBe(0)
  })

  test('cleanup releases the sidebar data subscription', () => {
    const mock = setup()
    expect(mock.unsubscribed()).toBe(false)
    cleanups.pop()?.()
    expect(mock.unsubscribed()).toBe(true)
  })
})
