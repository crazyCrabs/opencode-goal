import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createComponent, createRoot } from 'solid-js'
import { RendererContext } from '@opentui/solid'
import {
  createGoalTuiPlugin,
  goalSidebarSummary,
  type TuiGoalContext,
  type TuiKeymapCommandInput,
  type TuiKeymapLayerInput,
  type TuiRouteRef,
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
  /** Every session the plugin asked the client to create. */
  created: string[]
  /** Every router navigation the plugin asked for. */
  navigated: Array<{ type: string; sessionID?: string }>
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
 *
 * `route` stands in for the TUI's current route: a `session` route carries the
 * session that can execute a goal round, anything else leaves it without one.
 */
function makeContext(directory: string, initialRoute: TuiRouteRef = { type: 'session', sessionID: 'ses-goal' }) {
  // The route is mutable so a test can model the user navigating from the home
  // route into a session, which is the moment the auto-start has to notice.
  const holder = { route: initialRoute }
  const toasts: Toast[] = []
  const prompts: Array<{ sessionID: string; text: string }> = []
  const created: string[] = []
  const navigated: Array<{ type: string; sessionID?: string }> = []
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
        // The real client's SessionDomain carries `create` (confirmed in
        // @opencode/plugin's promise/session.d.ts). A mock without it would let
        // the plugin silently fall back to the old hint.
        create: async () => {
          const id = `ses-made-${created.length + 1}`
          created.push(id)
          return { id }
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
      router: {
        current: () => holder.route,
        // The real router changes route on navigate; a mock that only records
        // would let the plugin's auto-start see a different session than the one
        // it just made, and the test would pass for the wrong reason.
        navigate: (next: { type: string; sessionID?: string }) => {
          navigated.push(next)
          holder.route = next
        },
      },
      setRoute: (next: TuiRouteRef) => {
        holder.route = next
      },
      slot: claim => slots.push(claim),
    },
  }

  return { context, toasts, prompts, created, navigated, slots, confirms, objectivePrompts, layers, state, unsubscribed: () => unsubscribed }
}

/** Build the plugin against a mock of the real TUI context (opencode 2.x API). */
function setup(route?: TuiRouteRef): Mock {
  const directory = mkdtempSync(join(tmpdir(), 'goal-tui-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))

  const harness = makeContext(directory, route)
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
    created: harness.created,
    navigated: harness.navigated,
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

/**
 * opentui constructs elements through the renderer context: a stub is enough,
 * because nothing is laid out or painted here — only the JSX is evaluated.
 */
const stubRenderer = {
  requestRender: () => {},
  registerLifecyclePass: () => {},
  on: () => {},
  off: () => {},
  width: 80,
  height: 24,
} as never

/** Mount one slot claim the way the TUI renders it, and return its dispose. */
function mountSlot(claim: SlotClaim): () => void {
  return createRoot(dispose => {
    createComponent(RendererContext.Provider as never, {
      value: stubRenderer,
      get children() {
        return claim.render({ sessionID: 'ses-goal' })
      },
    } as never)
    return dispose
  })
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

  test('a goal created with no session open makes a session and starts in it', async () => {
    // This test changed rather than the code being bent to keep it. What it used
    // to assert — armed, idle, rounds 0, and a hint — is the defect the human
    // reported: `/goal` from the home route admitted nothing until a message was
    // sent. The router does not become a session route until a prompt is
    // submitted (measured in the opencode binary), so waiting for it was waiting
    // for the very act the goal exists to remove.
    const mock = setup({ type: 'home' })
    await mock.command('goal.command').run!('work without a session')

    const store = new GoalStore(mock.directory)
    expect(store.current?.phase).toBe('active')
    expect(store.current?.roundsStarted).toBe(1)
    expect(mock.created.length).toBe(1)
    expect(mock.prompts.length).toBe(1)
    expect(mock.prompts[0].sessionID).toBe(mock.created[0])
    expect(mock.prompts[0].text).toContain('round 1/25')
    // the human is put in the room the goal is working in, not left on home
    expect(mock.navigated).toEqual([{ type: 'session', sessionID: mock.created[0] }])
    expect(mock.toasts.some(toast => toast.message.includes('No session is open in this project'))).toBe(false)
  })

  test('a goal created from the home route is continued by another instance', async () => {
    // the TUI half that created the goal without a session. It now makes one and
    // runs round 1 there, so the second half's resume is round 2 rather than
    // round 1 — the same cross-instance continuation, one round further on.
    const created = setup({ type: 'home' })
    await created.command('goal.command').run!('work started later')
    expect(created.prompts.length).toBe(1)

    // a second TUI half, with a session open: `/goal resume` admits the next round
    const resumed = setup()
    resumed.context.location!.directory = created.directory
    await resumed.command('goal.command').run!('resume')

    expect(resumed.prompts.length).toBe(1)
    expect(resumed.prompts[0].sessionID).toBe('ses-goal')
    expect(resumed.prompts[0].text).toContain('round 2/25')
    expect(new GoalStore(created.directory).current?.roundsStarted).toBe(2)
  })

  test('a paused goal is resumed and started by /goal resume', async () => {
    const mock = setup()
    await mock.command('goal.command').run!('pausable work')
    await mock.command('goal.command').run!('pause')
    mock.prompts.length = 0

    await mock.command('goal.command').run!('resume')
    expect(mock.prompts.length).toBe(1)
    expect(mock.prompts[0].text).toContain('round 2/25')
  })

  test('the sidebar renders with no goal set and after a create', async () => {
    const mock = setup()
    // Solid evaluates JSX props eagerly, so the empty goal must be guarded by
    // `Show`'s children — never by a bare `props.goal.phase` in JSX
    const empty = mock.slot('sidebar.content')
    expect(empty).toBeDefined()
    expect(() => mountSlot(empty!)).not.toThrow()

    await mock.command('goal.command').run!('sidebar objective')
    expect(() => mountSlot(mock.slot('sidebar.content')!)).not.toThrow()

    // the paused goal takes the other branch of the phase ternary
    await mock.command('goal.command').run!('pause')
    expect(() => mountSlot(mock.slot('sidebar.content')!)).not.toThrow()
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

/** A harness whose sidebar poll actually runs, at a 1ms cadence. */
function polling(route: TuiRouteRef, options: { canCreate?: boolean } = {}): Mock {
  const directory = mkdtempSync(join(tmpdir(), 'goal-tui-auto-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const harness = makeContext(directory, route)
  if (options.canCreate === false) {
    // a client that cannot create a session: the plugin must say so rather
    // than fall silent after a successful create
    ;(harness.context.client as { session: Record<string, unknown> }).session.create = undefined
  }
  const cleanup = createGoalTuiPlugin({ refreshIntervalMs: 1 }).setup(harness.context)
  cleanups.push(cleanup)
  harness.slots.find(claim => claim.append === 'app')?.render({})
  return {
    directory,
    context: harness.context,
    toasts: harness.toasts,
    prompts: harness.prompts,
    created: harness.created,
    navigated: harness.navigated,
    slots: harness.slots,
    confirms: harness.confirms,
    objectivePrompts: harness.objectivePrompts,
    layers: harness.layers,
    state: harness.state,
    mountKeymapLayer: () => {},
    slot: (append: string) => harness.slots.find(claim => claim.append === append),
    command: (id: string) => (harness.layers[0]?.commands ?? []).find(command => command.id === id)!,
    unsubscribed: () => harness.unsubscribed(),
  }
}

/** Let the sidebar poll run a few times. */
async function ticks(count = 5): Promise<void> {
  for (let i = 0; i < count; i++) await new Promise(resolve => setTimeout(resolve, 4))
}

describe('the home route: a goal starts without the human sending a message', () => {
  test('a goal that predates the session starts when one is opened', async () => {
    // What this used to assert was the reported defect: `/goal create` from the
    // home route admitted nothing until a session opened. That case now makes its
    // own session (see the test above), so what is left to prove here is the other
    // half — a goal that already existed, written by some other writer, started by
    // opening a session. That is ticket 26's case and it is still real.
    const home = { type: 'home' } as TuiRouteRef
    const harness = polling(home)
    try {
      // a goal written by another writer, so this plugin's store is born beside
      // it and reads as disarmed — which is correct, and is why the auto-start
      // has to arm before it kicks
      const writer = new GoalStore(harness.directory)
      writer.create('auto objective', 25, 0)

      await ticks()
      expect(harness.prompts.length).toBe(0) // no session yet: nothing to run in

      // the user opens a session
      ;(harness.context.ui as unknown as { setRoute: (r: TuiRouteRef) => void }).setRoute({
        type: 'session',
        sessionID: 'ses-auto',
      })

      await ticks()
      expect(harness.prompts.length).toBe(1) // it started on its own
      expect(harness.prompts[0].sessionID).toBe('ses-auto')
      expect(harness.prompts[0].text).toContain('round 1/25')
    } finally {
      // handled by cleanups
    }
  })

  /**
   * The opencode binary navigates to `{type:"session"}` inside the prompt-submit
   * handler — `if (!i.sessionID) { ...; V.navigate({type:"session", sessionID: Br}) }`
   * — so a session created by `<leader>n` does not put the router on a session
   * route. Waiting for the route is therefore waiting for the very thing the goal
   * exists to remove, which is why the human had to type a message to start it.
   */
  test('/goal with no session open makes one instead of asking the human to', async () => {
    const harness = polling({ type: 'home' })
    try {
      await harness.command('goal.command').run!('make a session for me')
      await ticks()

      // a session was created, and the round ran in it
      expect(harness.created.length).toBe(1)
      expect(harness.prompts.length).toBe(1)
      expect(harness.prompts[0].sessionID).toBe(harness.created[0])
      expect(harness.prompts[0].text).toContain('round 1/25')
      // and the human was put in the room the goal is working in
      expect(harness.navigated).toEqual([{ type: 'session', sessionID: harness.created[0] }])
      // the hint is gone: the human is not asked to do the thing the goal does
      expect(harness.toasts.some(t => t.message.includes('No session is open'))).toBe(false)
    } finally {
      // handled by cleanups
    }
  })

  test('a session that is already open is used, not replaced', async () => {
    const harness = polling({ type: 'session', sessionID: 'ses-existing' })
    try {
      await harness.command('goal.command').run!('use the open session')
      await ticks()
      expect(harness.created.length).toBe(0)
      expect(harness.prompts.length).toBe(1)
      expect(harness.prompts[0].sessionID).toBe('ses-existing')
    } finally {
      // handled by cleanups
    }
  })

  test('a client that cannot create a session still says so, rather than going silent', async () => {
    const harness = polling({ type: 'home' }, { canCreate: false })
    try {
      await harness.command('goal.command').run!('no client here')
      await ticks()
      expect(harness.created.length).toBe(0)
      expect(harness.prompts.length).toBe(0)
      expect(harness.toasts.some(t => t.message.includes('No session is open'))).toBe(true)
    } finally {
      // handled by cleanups
    }
  })

  test('it starts once, not once per poll', async () => {
    // This assertion used to be `toBe(1)` after clearing the prompts, which
    // measured the auto-start firing a *second* round for one `/goal` — a double
    // kick the poll and the command plane both performed. The command plane now
    // claims the goal-and-session pair in the set the poll reads, so one create is
    // one round.
    const harness = polling({ type: 'session', sessionID: 'ses-once' })
    try {
      await harness.command('goal.command').run!('once objective')
      await ticks(20)
      expect(harness.prompts.length).toBe(1)
      expect(new GoalStore(harness.directory).current?.roundsStarted).toBe(1)
    } finally {
      // handled by cleanups
    }
  })
})

describe('a blocked goal says why, without the human opening the log', () => {
  /** A goal stopped by the server driver, not by this plane. */
  function blockFromOutside(directory: string, code: string, message: string): void {
    const writer = new GoalStore(directory)
    const goal = writer.view()!
    writer.block({ id: goal.id, revision: goal.revision }, { code: code as never, message })
  }

  test('the sidebar carries the block reason, not only its code', async () => {
    const mock = setup()
    await mock.command('goal.command').run!('blocked objective')
    mock.prompts.length = 0

    // the server driver stops the goal: this plane never ran admission
    blockFromOutside(mock.directory, 'usage-limited', 'Goal stopped: the provider refused the request (HTTP 403): Upstream request failed.')

    const summary = goalSidebarSummary(new GoalStore(mock.directory).view())
    expect(summary.headline).toContain('blocked: usage-limited')
    // the reason a human can act on, not just the machine code
    expect(summary.reason).toBe('Goal stopped: the provider refused the request (HTTP 403): Upstream request failed.')
  })

  test('the sidebar renders a blocked goal with its reason', async () => {
    const mock = setup()
    await mock.command('goal.command').run!('render blocked')
    blockFromOutside(mock.directory, 'no-tool-call', 'Goal blocked: 2 consecutive goal turns ended with no tool call (limit 2).')

    const claim = mock.slot('sidebar.content')
    expect(() => mountSlot(claim!)).not.toThrow()
    const summary = goalSidebarSummary(new GoalStore(mock.directory).view())
    expect(summary.reason).toContain('no tool call')
  })

  test('the poll tells the human once, when the goal stops', async () => {
    const harness = polling({ type: 'session', sessionID: 'ses-block' })
    try {
      await harness.command('goal.command').run!('will be blocked')
      await ticks(3)
      harness.toasts.length = 0

      // the server driver stops the goal while this plane is idle
      blockFromOutside(harness.directory, 'usage-limited', 'Goal stopped: the provider refused the request (HTTP 403).')

      await ticks(10)
      const told = harness.toasts.filter(toast => toast.message.includes('usage-limited'))
      expect(told.length).toBe(1)
      // and the reason is in the toast, so the human does not have to open the log
      expect(told[0].message).toContain('the provider refused')

      // it does not repeat on every poll
      await ticks(20)
      expect(harness.toasts.filter(toast => toast.message.includes('usage-limited')).length).toBe(1)
    } finally {
      // handled by cleanups
    }
  })

  test('a goal that stops and is resumed is told about again', async () => {
    const harness = polling({ type: 'session', sessionID: 'ses-block-again' })
    try {
      await harness.command('goal.command').run!('blocked twice')
      await ticks(3)
      blockFromOutside(harness.directory, 'usage-limited', 'Goal stopped: the provider refused the request (HTTP 403).')
      await ticks(10)
      expect(harness.toasts.filter(toast => toast.message.includes('usage-limited')).length).toBe(1)

      // the human resumes, the goal runs, and it stops again
      await harness.command('goal.command').run!('resume')
      await ticks(3)
      blockFromOutside(harness.directory, 'usage-limited', 'Goal stopped: the provider refused the request (HTTP 403).')
      await ticks(10)
      expect(harness.toasts.filter(toast => toast.message.includes('usage-limited')).length).toBe(2)
    } finally {
      // handled by cleanups
    }
  })

  test('a goal that never blocks is never told about a block', async () => {
    const harness = polling({ type: 'session', sessionID: 'ses-fine' })
    try {
      await harness.command('goal.command').run!('a goal that is never blocked')
      await ticks(20)
      // the exact phrase the announcement uses: a loose 'blocked' would match the
      // word inside an objective and the test would pass or fail on phrasing
      expect(harness.toasts.some(toast => toast.message.includes('Goal blocked ('))).toBe(false)
    } finally {
      // handled by cleanups
    }
  })
})
