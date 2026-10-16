import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
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
  /** Every model a `create` was given. */
  madeWith: Array<{ providerID: string; id: string } | undefined>
  /** Every session id a `get` was asked about. */
  lookedUp: string[]
  /** The sessions that still exist, and the model each resolves to. */
  liveSessions: Map<string, { providerID: string; id: string; variant?: string } | undefined>
  /** Every `switchModel` the plugin asked for. */
  switched: Array<{ sessionID: string; model: unknown }>
  /** The two session collections. Refill these; replacing them is not possible. */
  collections: {
    sessions?: Array<{ id: string; model?: { providerID: string; id: string; variant?: string }; time?: { updated?: number }; location?: { directory?: string } }> | undefined
    clientSessions?: Array<{ id: string; model?: { providerID: string; id: string; variant?: string }; time?: { updated?: number }; location?: { directory?: string } }> | undefined
  }
  /** @deprecated set `collections.sessions`; kept so old tests fail loudly. */
  sessions?: never
  /** @deprecated set `collections.clientSessions`; kept so old tests fail loudly. */
  clientSessions?: never
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
  /** Every model a `create` was given, so a test can prove the remembered one rode along. */
  const madeWith: Array<{ providerID: string; id: string } | undefined> = []
  /** Every session id a `get` was asked about. */
  const lookedUp: string[] = []
  /** The sessions that still exist, and the model each resolves to. */
  const liveSessions = new Map<string, { providerID: string; id: string } | undefined>()
  const slots: SlotClaim[] = []
  const confirms: Mock['confirms'] = []
  const objectivePrompts: Mock['objectivePrompts'] = []
  const layers: TuiKeymapLayerInput[] = []
  const state = { confirmResult: true, promptResult: 'objective from the dialog' as string | undefined, status: 'idle' }
  /**
   * The two session collections, in a box a test can refill after the context is
   * built. A plain `const` destructured at build time would go stale the moment a
   * test replaced the reference, which is exactly the bug this replaces: the mock
   * read an undeclared free variable, the plugin's own try/catch swallowed the
   * ReferenceError, and a test bug looked like a plugin gap.
   */
  const collections: {
    sessions?: Array<{ id: string; model?: { providerID: string; id: string; variant?: string }; time?: { updated?: number }; location?: { directory?: string } }> | undefined
    clientSessions?: Array<{ id: string; model?: { providerID: string; id: string; variant?: string }; time?: { updated?: number }; location?: { directory?: string } }> | undefined
  } = {}
  /** Every `switchModel` the plugin asked for, so a repair can be proven. */
  const switched: Array<{ sessionID: string; model: unknown }> = []
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
        create: async (input?: { model?: { providerID: string; id: string } }) => {
          const id = `ses-made-${created.length + 1}`
          created.push(id)
          madeWith.push(input?.model)
          return { id }
        },
        // A remembered session is looked up here. Throwing is how a session that
        // no longer exists reports itself, which is the case the recovery path
        // exists for.
        get: async (input: { sessionID: string }) => {
          lookedUp.push(input.sessionID)
          if (!liveSessions.has(input.sessionID)) throw new Error('session not found')
          return { id: input.sessionID, model: liveSessions.get(input.sessionID) }
        },
        // The HTTP route behind `client.session.list()`. Measured on a live server:
        // 200, ordered by `time.updated` descending, carrying `model` per session.
        // The response is `SessionsResponse` — `{data, cursor}` — not an array, and
        // the first version of this read pushed the envelope as one row and so
        // found no model at all.
        list: async () => ({ data: collections.clientSessions ?? [], cursor: {} }),
        // `session.update` does not accept a model; this does.
        switchModel: async (input: { sessionID: string; model: unknown }) => {
          switched.push(input)
          const row = collections.sessions?.find(r => r.id === input.sessionID)
          if (row !== undefined) row.model = input.model as never
          const live = liveSessions.get(input.sessionID)
          if (live !== undefined) liveSessions.set(input.sessionID, input.model as never)
        },
      },
    },
    data: {
      on: () => () => {
        unsubscribed = true
      },
      session: {
        status: () => state.status,
        get: (id: string) => ({ id, model: liveSessions.get(id) }),
        // The TUI's own collection. Undefined when a test wants to prove the
        // client route is the fallback.
        list: () => collections.sessions ?? [],
      },
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

  return { context, toasts, prompts, created, navigated, madeWith, lookedUp, liveSessions, collections, switched, slots, confirms, objectivePrompts, layers, state, unsubscribed: () => unsubscribed }
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
    madeWith: harness.madeWith,
    lookedUp: harness.lookedUp,
    liveSessions: harness.liveSessions,
    collections: harness.collections,
    switched: harness.switched,
    sessions: undefined,
    clientSessions: undefined,
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
    madeWith: harness.madeWith,
    lookedUp: harness.lookedUp,
    liveSessions: harness.liveSessions,
    collections: harness.collections,
    switched: harness.switched,
    sessions: undefined,
    clientSessions: undefined,
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

describe('the goal remembers its room, and the model that room ran on', () => {
  /**
   * Put the router back on the home route.
   *
   * After a round runs, `ensureSession` has navigated to the session it made, so
   * the next `/goal` finds a session open and reuses it — which is the happy path
   * and not what these tests are about. A recovery is only reachable from home:
   * the human navigated away, or the process restarted.
   */
  function backHome(harness: Mock): void {
    ;(harness.context.ui as unknown as { setRoute: (r: TuiRouteRef) => void }).setRoute({ type: 'home' })
  }

  test('a round records the session it ran in and the model it resolved to', async () => {
    const mock = setup()
    mock.liveSessions.set('ses-goal', { providerID: 'stepfun', id: 'step-5-preview' })
    await mock.command('goal.command').run!('remember my room')

    const store = new GoalStore(mock.directory)
    expect(store.session?.sessionID).toBe('ses-goal')
    expect(store.session?.model).toEqual({ providerID: 'stepfun', id: 'step-5-preview' })
  })

  test('a session coordinate is not a state verb: it does not move the revision', async () => {
    const mock = setup()
    await mock.command('goal.command').run!('coordinate only')
    const before = new GoalStore(mock.directory).view()!
    expect(before.revision).toBe(2) // create + continue

    // remembering a session again, for the same room, must not bump anything
    const writer = new GoalStore(mock.directory)
    writer.rememberSession({ id: before.id, revision: before.revision }, 'ses-goal', { providerID: 'opencode', id: 'mimo' })
    const after = new GoalStore(mock.directory).view()!
    expect(after.revision).toBe(before.revision)
    expect(after.roundsStarted).toBe(before.roundsStarted)
  })

  test('a remembered session that still exists is reused, and no new one is made', async () => {
    const harness = polling({ type: 'home' })
    try {
      await harness.command('goal.command').run!('first run')
      await ticks()
      const firstRoom = harness.created[0]
      expect(harness.madeWith).toEqual([undefined]) // a first goal has nothing to remember

      // the human navigates away, the room is still alive, and they resume
      backHome(harness)
      harness.liveSessions.set(firstRoom, { providerID: 'stepfun', id: 'step-5-preview' })
      await harness.command('goal.command').run!('resume')
      await ticks()

      expect(harness.lookedUp).toContain(firstRoom)
      expect(harness.created.length).toBe(1) // the same room, not a new one
      expect(harness.prompts[harness.prompts.length - 1].sessionID).toBe(firstRoom)
    } finally {
      // handled by cleanups
    }
  })

  test('a remembered session that is gone is replaced, carrying its model', async () => {
    // The first round runs in a session that is already open, so the model is read
    // from a room the human actually chose it in. An earlier version of this test
    // started from the home route and set the model on a session the goal never
    // used, so the goal correctly remembered no model and the test proved nothing.
    const harness = polling({ type: 'session', sessionID: 'ses-goal' })
    try {
      harness.liveSessions.set('ses-goal', { providerID: 'stepfun', id: 'step-5-preview' })
      await harness.command('goal.command').run!('will lose its room')
      await ticks()
      expect(harness.created.length).toBe(0) // it used the open session
      expect(new GoalStore(harness.directory).session?.model).toEqual({
        providerID: 'stepfun',
        id: 'step-5-preview',
      })

      // the human navigates away and closes that session, then resumes: the goal
      // must not fall back to whatever the server defaults to, which for at least
      // one account is a model it cannot use at all
      backHome(harness)
      harness.liveSessions.delete('ses-goal')
      await harness.command('goal.command').run!('resume')
      await ticks()

      expect(harness.created.length).toBe(1)
      // the replacement was created WITH the remembered model
      expect(harness.madeWith[0]).toEqual({ providerID: 'stepfun', id: 'step-5-preview' })
      expect(harness.prompts[harness.prompts.length - 1].sessionID).toBe(harness.created[0])
    } finally {
      // handled by cleanups
    }
  })

  test('a goal with no remembered model still runs, on whatever the server picks', async () => {
    const harness = polling({ type: 'home' })
    try {
      // no model anywhere: the honest case, which fails with usage-limited and is
      // announced rather than silently guessed at
      await harness.command('goal.command').run!('no model anywhere')
      await ticks()
      backHome(harness)
      await harness.command('goal.command').run!('resume')
      await ticks()

      expect(harness.created.length).toBe(2)
      expect(harness.madeWith[1]).toBeUndefined()
    } finally {
      // handled by cleanups
    }
  })

  test('the goal log carries the room as its own line kind', async () => {
    const mock = setup()
    mock.liveSessions.set('ses-goal', { providerID: 'stepfun', id: 'step-5-preview' })
    await mock.command('goal.command').run!('line kind')

    const lines = readFileSync(join(mock.directory, '.opencode', 'goal-log.jsonl'), 'utf8')
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line))
    const sessions = lines.filter(line => line['kind'] === 'goal/session')
    expect(sessions.length).toBe(1)
    expect(sessions[0].sessionID).toBe('ses-goal')
    // and it is not a state verb: no `operation`, and it did not become a round
    expect(sessions[0].operation).toBeUndefined()
    expect(lines.filter(line => line['operation'] === 'continue').length).toBe(1)
  })
})

describe('the goal follows the model opencode is already using', () => {
  test('with no session open, the newest session carrying a model supplies it', async () => {
    const harness = polling({ type: 'home' })
    try {
      // The human's choice lives in a session they worked in earlier. There is no
      // session open, which is exactly the home-route case that used to create a
      // model-less session and get a Go model back.
      harness.liveSessions.set('ses-old', { providerID: 'stepfun', id: 'step-5-preview' })
      harness.collections.sessions = [
        { id: 'ses-old', model: { providerID: 'stepfun', id: 'step-5-preview' }, time: { updated: 100 }, location: { directory: harness.directory } },
        { id: 'ses-nomodel', model: undefined, time: { updated: 200 }, location: { directory: harness.directory } },
        // an older session with a different model, which must lose
        { id: 'ses-older', model: { providerID: 'opencode', id: 'big-pickle' }, time: { updated: 50 }, location: { directory: harness.directory } },
        // another project's choice, which must be ignored
        { id: 'ses-elsewhere', model: { providerID: 'nope', id: 'nope' }, time: { updated: 999 }, location: { directory: 'C:/elsewhere' } },
      ]

      await harness.command('goal.command').run!('use the model I chose')
      await ticks()

      expect(harness.madeWith[0]).toEqual({ providerID: 'stepfun', id: 'step-5-preview' })
    } finally {
      // handled by cleanups
    }
  })

  test('the session open on the router wins over the newest one', async () => {
    const harness = polling({ type: 'session', sessionID: 'ses-open' })
    try {
      harness.liveSessions.set('ses-open', { providerID: 'opencode', id: 'big-pickle', variant: 'max' })
      harness.collections.sessions = [
        { id: 'ses-newer', model: { providerID: 'stepfun', id: 'step-5-preview' }, time: { updated: 5000 }, location: { directory: harness.directory } },
      ]

      await harness.command('goal.command').run!('I am looking at this one')
      await ticks()

      // the human is standing in ses-open, so that is what opencode is using
      expect(harness.prompts[0].sessionID).toBe('ses-open')
      expect(new GoalStore(harness.directory).session?.model).toEqual({
        providerID: 'opencode',
        id: 'big-pickle',
        variant: 'max',
      })
    } finally {
      // handled by cleanups
    }
  })

  test('a variant survives the round trip, because it changes which model runs', async () => {
    const mock = setup()
    mock.liveSessions.set('ses-goal', { providerID: 'opencode', id: 'deepseek-v4-flash', variant: 'max' })
    await mock.command('goal.command').run!('variant matters')

    const remembered = new GoalStore(mock.directory).session?.model
    expect(remembered).toEqual({ providerID: 'opencode', id: 'deepseek-v4-flash', variant: 'max' })
  })

  test('the client list is the fallback when the TUI collection is absent', async () => {
    const harness = polling({ type: 'home' })
    try {
      // no `data.session.list` at all, and no open session: only the HTTP route
      // can answer, which is the layer measured returning models per session
      harness.collections.sessions = undefined
      harness.collections.clientSessions = [
        { id: 'ses-via-client', model: { providerID: 'baishan', id: 'DeepSeek-V4-Pro' }, time: { updated: 10 }, location: { directory: harness.directory } },
      ]

      await harness.command('goal.command').run!('client only')
      await ticks()

      expect(harness.madeWith[0]).toEqual({ providerID: 'baishan', id: 'DeepSeek-V4-Pro' })
    } finally {
      // handled by cleanups
    }
  })

  test('no model anywhere still runs, and fails honestly', async () => {
    const harness = polling({ type: 'home' })
    try {
      harness.collections.sessions = undefined
      await harness.command('goal.command').run!('nothing to read')
      await ticks()
      expect(harness.madeWith[0]).toBeUndefined()
    } finally {
      // handled by cleanups
    }
  })
})

describe('the {data} envelope, and repairing a room that has no model', () => {
  test('the client list envelope is unwrapped, not treated as one row', async () => {
    // The first version of this read pushed `{data, cursor}` as a single row, so
    // every session looked model-less and the goal remembered nothing — which is
    // exactly what the human saw: `SESSION ... model=None` in their own goal log.
    const harness = polling({ type: 'home' })
    try {
      harness.collections.sessions = undefined
      harness.collections.clientSessions = [
        { id: 'ses-a', model: undefined, time: { updated: 1 }, location: { directory: harness.directory } },
        { id: 'ses-b', model: { providerID: 'stepfun', id: 'step-5-preview' }, time: { updated: 2 }, location: { directory: harness.directory } },
      ]
      await harness.command('goal.command').run!('envelope')
      await ticks()
      expect(harness.madeWith[0]).toEqual({ providerID: 'stepfun', id: 'step-5-preview' })
    } finally {
      // handled by cleanups
    }
  })

  test('a remembered room with no model is repaired, not replaced', async () => {
    const harness = polling({ type: 'home' })
    try {
      // A goal created before this fix remembers a room that carries no model, so
      // reusing it would reproduce the 403 exactly. `session.update` does not
      // accept a model; `switchModel` does.
      harness.collections.sessions = [
        { id: 'ses-remembered', model: undefined, time: { updated: 5 }, location: { directory: harness.directory } },
      ]
      harness.liveSessions.set('ses-remembered', undefined)
      harness.collections.clientSessions = [
        { id: 'ses-chosen', model: { providerID: 'stepfun', id: 'step-5-preview' }, time: { updated: 9 }, location: { directory: harness.directory } },
      ]

      // first run: creates a room and remembers it with the model it read
      await harness.command('goal.command').run!('will be remembered')
      await ticks()
      const room = harness.created[0]
      expect(room).toBeDefined()

      // The human navigates away; the room survives but carries no model, because
      // every session the plugin created before this read existed has none. Not
      // being in `liveSessions` at all would mean the room is gone, which is the
      // other test's case and correctly makes a new room.
      harness.liveSessions.set(room, undefined)
      harness.collections.sessions = [{ id: room, model: undefined, time: { updated: 10 }, location: { directory: harness.directory } }]
      ;(harness.context.ui as unknown as { setRoute: (r: TuiRouteRef) => void }).setRoute({ type: 'home' })
      await harness.command('goal.command').run!('resume')
      await ticks()

      expect(harness.lookedUp).toContain(room)
      expect(harness.created.length).toBe(1) // the same room
      const repair = harness.switched.find(s => s.sessionID === room)
      expect(repair?.model).toEqual({ providerID: 'stepfun', id: 'step-5-preview' })
    } finally {
      // handled by cleanups
    }
  })

  test('a directory spelled with backslashes still matches the project', async () => {
    // The session rows carry a location with backslashes while the plugin's own
    // `context.location.directory` uses forward slashes. Comparing them raw drops
    // every row, which is the other way this read can answer nothing.
    const harness = polling({ type: 'home' })
    try {
      const backslashed = harness.directory.split('/').join(String.fromCharCode(92))
      harness.collections.sessions = [
        { id: 'ses-bs', model: { providerID: 'stepfun', id: 'step-5-preview' }, time: { updated: 1 }, location: { directory: backslashed } },
        { id: 'ses-other', model: { providerID: 'nope', id: 'nope' }, time: { updated: 99 }, location: { directory: 'C:/somewhere/else' } },
      ]
      await harness.command('goal.command').run!('separator shapes')
      await ticks()
      expect(harness.madeWith[0]).toEqual({ providerID: 'stepfun', id: 'step-5-preview' })
    } finally {
      // handled by cleanups
    }
  })

  test('a model from another project is used only when this project has none', async () => {
    const harness = polling({ type: 'home' })
    try {
      // Nothing in this project carries a model. The literal reading of "the model
      // opencode is using" is still better than falling back to the server default,
      // which is a 403.
      harness.collections.sessions = [
        { id: 'ses-far', model: { providerID: 'stepfun', id: 'step-5-preview' }, time: { updated: 1 }, location: { directory: 'C:/elsewhere' } },
      ]
      await harness.command('goal.command').run!('only other projects')
      await ticks()
      expect(harness.madeWith[0]).toEqual({ providerID: 'stepfun', id: 'step-5-preview' })
    } finally {
      // handled by cleanups
    }
  })

  test('a remembered room that already has the model is left alone', async () => {
    const harness = polling({ type: 'session', sessionID: 'ses-remembered' })
    try {
      harness.liveSessions.set('ses-remembered', { providerID: 'stepfun', id: 'step-5-preview' })
      harness.collections.sessions = [
        { id: 'ses-remembered', model: { providerID: 'stepfun', id: 'step-5-preview' }, time: { updated: 5 }, location: { directory: harness.directory } },
      ]
      await harness.command('goal.command').run!('already right')
      await ticks()
      expect(harness.switched.length).toBe(0)
    } finally {
      // handled by cleanups
    }
  })
})

describe('the auto-start does not follow the human into another session', () => {
  /**
   * The human's report, and why the server-side fix did not close it:
   *
   *   当其他 session 里面的任务完成时，goal 的任务触发了。
   *
   * `autoStart` read the session open on the router and kicked a round there, with
   * no question about whether that session was the goal's room. It is driven by
   * the sidebar poll and by `session.execution.succeeded`, so any turn completing
   * anywhere re-ran it — which is the reported symptom arriving through the TUI
   * plane rather than the server driver.
   */
  test('navigating to another session does not start a round there', async () => {
    const harness = polling({ type: 'session', sessionID: 'ses-room' })
    try {
      // the goal runs in the session the human is in
      await harness.command('goal.command').run!('objective in my room')
      await ticks()
      expect(harness.prompts.length).toBe(1)
      expect(harness.prompts[0].sessionID).toBe('ses-room')
      expect(new GoalStore(harness.directory).session?.sessionID).toBe('ses-room')

      // the human navigates to a different session of the same project
      ;(harness.context.ui as unknown as { setRoute: (r: TuiRouteRef) => void }).setRoute({
        type: 'session',
        sessionID: 'ses-elsewhere',
      })
      await ticks()

      // the goal stays in its own room
      expect(harness.prompts.length).toBe(1)
      expect(harness.prompts.some(prompt => prompt.sessionID === 'ses-elsewhere')).toBe(false)
      expect(new GoalStore(harness.directory).view()!.roundsStarted).toBe(1)
    } finally {
      // handled by cleanups
    }
  })

  test('the goal still starts in its own room with no human input', async () => {
    const harness = polling({ type: 'session', sessionID: 'ses-room' })
    try {
      await harness.command('goal.command').run!('self-sustaining')
      await ticks()
      expect(harness.prompts.length).toBe(1)

      // the poll keeps ticking in the same session: nothing new is admitted,
      // because the round is already running there
      await ticks()
      expect(harness.prompts.length).toBe(1)
      expect(new GoalStore(harness.directory).view()!.roundsStarted).toBe(1)
    } finally {
      // handled by cleanups
    }
  })

  test('a goal with no room of its own still starts in the session that is open', async () => {
    // The case the fix must not break: a goal written by another writer, which
    // this plugin's store is born beside and which has no remembered room. That is
    // ticket 26's case, and opening a session is the human's go-ahead.
    const harness = polling({ type: 'home' })
    try {
      new GoalStore(harness.directory).create('auto objective', 25, 0)
      await ticks()
      expect(harness.prompts.length).toBe(0)

      ;(harness.context.ui as unknown as { setRoute: (r: TuiRouteRef) => void }).setRoute({
        type: 'session',
        sessionID: 'ses-auto',
      })
      await ticks()

      expect(harness.prompts.length).toBe(1)
      expect(harness.prompts[0].sessionID).toBe('ses-auto')
      expect(harness.prompts[0].text).toContain('round 1/25')
    } finally {
      // handled by cleanups
    }
  })

  test('coming back to the goal room resumes driving it', async () => {
    const harness = polling({ type: 'session', sessionID: 'ses-room' })
    try {
      await harness.command('goal.command').run!('will be left and returned to')
      await ticks()
      expect(harness.prompts.length).toBe(1)

      // the human wanders off and comes back
      ;(harness.context.ui as unknown as { setRoute: (r: TuiRouteRef) => void }).setRoute({
        type: 'session',
        sessionID: 'ses-elsewhere',
      })
      await ticks()
      ;(harness.context.ui as unknown as { setRoute: (r: TuiRouteRef) => void }).setRoute({
        type: 'session',
        sessionID: 'ses-room',
      })
      await ticks()

      // still exactly one round, in the goal's own room: the wander cost nothing
      expect(harness.prompts.length).toBe(1)
      expect(harness.prompts[0].sessionID).toBe('ses-room')
    } finally {
      // handled by cleanups
    }
  })
})
