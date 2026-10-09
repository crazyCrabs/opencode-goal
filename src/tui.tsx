/**
 * TUI command plane for opencode-goal (DSH `command-goal` posture).
 *
 * The human `/goal` slash command is registered directly in the TUI keymap, so
 * invoking it parses the input, executes it against the durable goal log, and
 * renders the result as direct UI output (toast / dialog / sidebar). No prompt
 * parts are injected and no model turn is spent on goal control.
 *
 * State is shared with the server-side plugin (model tools + continuation
 * driver) through `<worktree>/.opencode/goal-log.jsonl`: this plugin folds the
 * log for every command and the driver re-folds it on `session.idle`, so a goal
 * created, edited, paused, resumed, or cleared here is observed there. After a
 * create/edit/resume this plugin also admits and submits the first working
 * round, because a locally executed slash command produces no `session.idle`
 * event that would otherwise wake the driver.
 */

import { randomUUID } from 'node:crypto'
import { createRoot, createSignal, onCleanup, Show, type JSX } from 'solid-js'
import { executeGoalCommand, parseGoalCommand, type GoalCommandOutcome, type ParsedGoalCommand } from './commands.ts'
import { admitRound, stopGoal } from './admission.ts'
import { providerStopReason, renderGoalRoundPrompt } from './round-policy.ts'
import { GoalStore } from './state.ts'
import { GoalError, type GoalView } from './types.ts'

/** One toast rendered by the TUI. */
export interface TuiToastInput {
  variant?: 'info' | 'success' | 'warning' | 'error'
  title?: string
  message: string
  duration?: number
}

/** Modal dialogs offered by the TUI. */
export interface TuiDialogApi {
  confirm(input: { title: string; message: string; label?: { confirm?: string; cancel?: string } }): Promise<boolean>
  prompt(input: { title: string; description?: string; placeholder?: string; value?: string }): Promise<string | undefined>
  alert(input: { title: string; message: string }): Promise<unknown>
  clear(): void
}

/** One command registered on a TUI keymap layer. */
export interface TuiKeymapCommandInput {
  id: string
  title: string
  description?: string
  group?: string
  palette?: boolean
  slash?: { name: string; arguments?: boolean }
  run?(input?: string): void | Promise<void>
}

/** One keymap layer claim. */
export interface TuiKeymapLayerInput {
  mode?: string
  commands: TuiKeymapCommandInput[]
  bindings?: unknown[]
}

export interface TuiKeymapApi {
  /**
   * Registers a layer owned by the calling component; it is disposed with it.
   *
   * This is a hook over the TUI's `Keymap.Provider`: the provider is on the
   * Solid context chain of the render tree, never of plugin setup (the TUI
   * activates plugins from a promise continuation). Call it from inside a TUI
   * render — a `ui.slot` render, exactly like the built-in plugins do — or it
   * throws `Keymap.Provider is missing`.
   */
  layer(input: () => TuiKeymapLayerInput): void
}

/** Current TUI route; `session` routes carry the active session id. */
export interface TuiRouteRef {
  type?: string
  sessionID?: string
}

/**
 * Prompt submission client. The TUI embeds the opencode server, so this is the
 * in-process client: `prompt` submits a turn.
 */
export interface TuiSessionClient {
  prompt(input: { sessionID: string; text: string }): Promise<unknown> | unknown
  /**
   * Create a session. Present on the real client's `SessionDomain` (confirmed in
   * `@opencode/plugin`'s `promise/session.d.ts`), and optional here so a context
   * without it degrades to the old hint rather than throwing.
   */
  create?(input?: { model?: GoalModelRef }): Promise<unknown> | unknown
  /**
   * Every session, newest first. Declared on the generated client, and the
   * route behind it was measured returning `model` and `time.updated` per
   * session — which is how a goal with no session of its own learns what model
   * opencode is using. The response is `{data: SessionInfo[]}`, not an array.
   */
  list?(input?: Record<string, unknown>): Promise<unknown> | unknown
  /**
   * Set a session's model. `session.update` does not accept one — measured — so
   * this is the only way to repair a room that was created without one.
   */
  switchModel?(input: { sessionID: string; model: GoalModelRef }): Promise<unknown> | unknown
  /**
   * Read a session, which is how a remembered session is checked for still
   * existing. Optional because the surface this plugin was written against
   * declared neither it nor `create`.
   */
  get?(input: { sessionID: string }): Promise<unknown> | unknown
}

/** Minimal TUI plugin context surface (opencode 2.x TUI plugin API). */
export interface TuiGoalContext {
  location?: { directory: string; workspaceID?: string }
  client?: { session?: TuiSessionClient }
  data?: {
    on?(event: string, handler: (event: unknown) => void): () => void
    session?: {
      status?(sessionID: string): string | undefined
      /** Read a session, which is how the plugin learns the model a room resolves to. */
      get?(sessionID: string): unknown
      /** Every session, newest first. Declared by the shipped TUI context. */
      list?(): unknown
    }
  }
  keymap: TuiKeymapApi
  ui: {
    toast: { show(input: TuiToastInput): void }
    dialog: TuiDialogApi
    router: {
      current(): TuiRouteRef | undefined
      /**
       * Put the human on a route. Optional because the surface the plugin was
       * written against only declared `current`; the opencode binary carries
       * `navigate` and calls it with exactly this shape.
       */
      navigate?(route: { type: string; sessionID?: string }): void
    }
    slot?(claim: { append: string; render: (input: { sessionID?: string }) => unknown }): void
  }
}

/** Options accepted by the TUI plugin factory (tests override the poll cadence). */
export interface GoalTuiPluginOptions {
  /** Sidebar refresh poll interval in milliseconds; 0 disables polling. */
  refreshIntervalMs?: number
}

const DEFAULT_REFRESH_INTERVAL_MS = 1000

/** Toast lifetime for the multi-line status block. */
const STATUS_TOAST_MS = 8000
/** Toast lifetime for short mutation confirmations. */
const ACTION_TOAST_MS = 5000
/**
 * Why an armed goal stays quiet with no session open: the first-round kick
 * needs a session to run in, and a goal created from the home route has
 * nowhere to execute yet. Opening a session adopts it — the server driver
 * admits the next round on `session.created` — so no manual resume is needed.
 */
const NO_SESSION_HINT =
  'No session is open in this project, so the goal has nothing to run in yet. Open a session here and it starts on its own — no /goal resume needed.'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Open a fresh store: every command folds the durable log from disk. */
function openStore(directory: string): GoalStore {
  return new GoalStore(directory)
}

/** Whether the TUI's session data reports a running turn for one session. */
function isRunning(context: TuiGoalContext, sessionID: string): boolean {
  try {
    return context.data?.session?.status?.(sessionID) === 'running'
  } catch {
    return false
  }
}

/** Whether one executed command should start the goal's next working round. */
function shouldKickRound(
  command: ParsedGoalCommand,
  before: GoalView | undefined,
  after: GoalView | undefined,
): boolean {
  if (after === undefined || after.phase !== 'active') return false
  switch (command.kind) {
    case 'create':
      // a committed create always carries a fresh goal identity
      return before === undefined || before.id !== after.id
    case 'edit':
    case 'resume':
      // only a committed mutation bumps the revision
      return before !== undefined && before.id === after.id && after.revision > before.revision
    default:
      return false
  }
}

/** Truncate one objective for the sidebar row. */
function truncateObjective(objective: string, max = 60): string {
  const singleLine = objective.replace(/\s+/g, ' ').trim()
  return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine
}

/** Sidebar text for one goal: a headline and an optional progress line. */
export function goalSidebarSummary(
  goal: GoalView | undefined,
): { headline: string; detail: string; reason?: string } {
  if (goal === undefined) return { headline: 'No goal — /goal <objective>', detail: '' }
  const progress = goal.tokenBudget > 0
    ? `rounds ${goal.roundsStarted}/${goal.maxGoalRounds} · tokens ${goal.usage.inputTokens + goal.usage.outputTokens}/${goal.tokenBudget}`
    : `rounds ${goal.roundsStarted}/${goal.maxGoalRounds}`
  // only the durable phase is shown: activation is process-local and the sidebar
  // folds the log from its own process, so it cannot observe the driver's state
  const badge = goal.phase === 'blocked' ? `blocked: ${goal.blockedReason?.code ?? 'unknown'}` : goal.phase
  return {
    headline: `${badge} · ${truncateObjective(goal.objective)}`,
    detail: progress,
    // The code alone is machine-routable and says nothing a human can act on.
    // `usage-limited` and `provider refused the request (HTTP 403): ...` are the
    // same fact at two altitudes, and the sidebar is the only surface the human
    // is guaranteed to be looking at.
    reason: goal.phase === 'blocked' ? goal.blockedReason?.message : undefined,
  }
}

/**
 * The model a session resolves to, read through the plugin's own client.
 *
 * `Session.Info` carries an optional `model` (`{providerID, id}`), which is the
 * only place the plugin can learn it: the continuation prompt carries no model at
 * all, so a goal that does not read it here runs on whatever the server defaults
 * to. A client without a session read, or a session with no model set, yields
 * undefined and the goal remembers only the room — which is still better than
 * nothing, because a room can be reused even when its model is unknown.
 */
function readSessionModel(context: TuiGoalContext, sessionID: string): GoalModelRef | undefined {
  const get = context.data?.session?.get
  if (typeof get !== 'function') return undefined
  let session: unknown
  try {
    session = get(sessionID)
  } catch {
    return undefined
  }
  return normaliseModel((session as { model?: unknown } | undefined)?.model)
}

/** A model reference, in the shape `session.create` and `switchModel` accept. */
type GoalModelRef = { providerID: string; id: string; variant?: string }

/**
 * Unwrap a session list response.
 *
 * `client.session.list()` returns `SessionsResponse` — `{data: SessionInfo[],
 * cursor}` — and the TUI's own `data.session.list()` returns `SessionInfo[]`.
 * Pushing the envelope as one row is how the first version of this read nothing
 * at all: the wrapper has no `model`, so every session looked model-less and the
 * goal remembered none, which is exactly what the human saw.
 */
function toSessionRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  const data = (value as { data?: unknown } | null | undefined)?.data
  if (Array.isArray(data)) return data
  return value === undefined || value === null ? [] : [value]
}

/**
 * Whether two directories name the same place.
 *
 * They do not arrive in the same shape: the session rows carry a location with
 * backslashes while the plugin's own `context.location.directory` and the stored
 * session directory use forward slashes. Comparing them raw silently drops every
 * row, which is the other way this read can answer nothing.
 */
function sameDirectory(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return true
  const norm = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/**
 * The model opencode is actually using, read through the plugin's own surfaces.
 *
 * This is the whole answer to "why does the goal run a different model from the
 * one I chose". The model is resolved **per session** and the continuation prompt
 * carries no model at all — measured, `PromptInput.Prompt` is
 * `text/files/agents/skills` only — so a goal in a session it did not create runs
 * on whatever the server defaults to, and that default is a model at least one
 * account cannot use.
 *
 * Four layers, because the plugin surface declares more than one way to ask and
 * none of them is guaranteed:
 *
 * 1. the session open on the router — the most immediate expression of the human's
 *    choice, since they are looking at it;
 * 2. every session carrying a model **in this project**, newest first;
 * 3. every session carrying a model anywhere, newest first — which is the literal
 *    reading of "the model opencode is using", and is preferred over remembering
 *    nothing;
 * 4. the model this goal last ran on, durably remembered.
 *
 * Anything that answers, answers. A surface that is missing or throws is skipped
 * rather than guessed at, because a wrong model is a 403 and no model at all is a
 * 403 the human can read.
 */
/** Read a model off anything that might carry one, in the shape `create` takes. */
function normaliseModel(value: unknown): GoalModelRef | undefined {
  const model = value as { providerID?: unknown; id?: unknown; variant?: unknown } | undefined | null
  if (model === undefined || model === null) return undefined
  if (typeof model.providerID !== 'string' || typeof model.id !== 'string') return undefined
  if (model.providerID.length === 0 || model.id.length === 0) return undefined
  return typeof model.variant === 'string' && model.variant.length > 0
    ? { providerID: model.providerID, id: model.id, variant: model.variant }
    : { providerID: model.providerID, id: model.id }
}

async function readCurrentModel(
  context: TuiGoalContext,
  openSessionID: string,
): Promise<GoalModelRef | undefined> {
  const normalise = normaliseModel

  // 1. the room the human is standing in
  if (openSessionID.length > 0) {
    try {
      const open = context.data?.session?.get?.(openSessionID)
      const model = normalise((open as { model?: unknown } | undefined)?.model)
      if (model !== undefined) return model
    } catch {
      // fall through to the collection
    }
  }

  // 2 and 3: every session, newest first. Both collections are read, because a
  // host may declare either, neither, or both — and the first one that answers
  // is the one that is used.
  const rows: unknown[] = []
  try {
    rows.push(...toSessionRows(context.data?.session?.list?.()))
  } catch {
    // the TUI collection is absent in some hosts
  }
  try {
    rows.push(...toSessionRows(await context.client?.session?.list?.()))
  } catch {
    // no enumeration available
  }

  const directory = context.location?.directory
  const newest = (only: (row: unknown) => boolean): GoalModelRef | undefined => {
    let best: { at: number; model: GoalModelRef } | undefined
    for (const row of rows) {
      if (!only(row)) continue
      const model = normalise((row as { model?: unknown } | undefined)?.model)
      if (model === undefined) continue
      const at = (row as { time?: { updated?: unknown } } | undefined)?.time?.updated
      const stamp = typeof at === 'number' ? at : 0
      if (best === undefined || stamp > best.at) best = { at: stamp, model }
    }
    return best?.model
  }
  const rowDirectory = (row: unknown): string | undefined => {
    const value = (row as { location?: { directory?: unknown } } | undefined)?.location?.directory
    return typeof value === 'string' ? value : undefined
  }

  return (
    newest(row => sameDirectory(rowDirectory(row), directory)) ??
    newest(() => true)
  )
}

/** Sidebar row: durable phase, objective, and budget progress. */function GoalSidebarView(props: { goal: GoalView | undefined; onCommand(command: string): void }) {
  const summary = goalSidebarSummary(props.goal)
  return (
    <box flexDirection="column" style={{ padding: 1 }}>
      {/*
        The `goal` value reaches the rows through `Show`'s children callback:
        JSX props are evaluated when the tree is constructed, so a bare
        `props.goal.phase` here would throw on the empty goal before `Show` ever
        decides which branch to render.
      */}
      <Show when={props.goal} fallback={<text style={{ fg: 'gray' }}>{summary.headline}</text>}>
        {(goal): JSX.Element => {
          const view = goal()
          return (
            <>
              <text>{summary.headline}</text>
              <text style={{ fg: 'gray' }}>{summary.detail}</text>
              {summary.reason === undefined ? null : (
                <text style={{ fg: 'yellow' }}>{summary.reason}</text>
              )}
              {/*
                A ternary, not a nested `<Show>`: a falsy `Show` inside a `<box>`
                makes the opentui renderer's `insertExpression` clear the parent's
                children and insert an empty text node into it, which throws an
                orphan-text error.
              */}
              <box flexDirection="row" style={{ gap: 1 }}>
                {view.phase === 'active' ? (
                  <text style={{ fg: 'gray' }} onMouseUp={() => props.onCommand('pause')}>
                    pause
                  </text>
                ) : (
                  <text style={{ fg: 'gray' }} onMouseUp={() => props.onCommand('resume')}>
                    resume
                  </text>
                )}
                <text style={{ fg: 'gray' }} onMouseUp={() => props.onCommand('clear')}>
                  clear
                </text>
              </box>
            </>
          )
        }}
      </Show>
    </box>
  )
}

/**
 * Build the TUI plugin: registers the `/goal` slash command, palette entries,
 * and a sidebar status view. The returned object is the module the TUI loads.
 */
export function createGoalTuiPlugin(options: GoalTuiPluginOptions = {}) {
  const refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS
  /**
   * This TUI process's lease holder id.
   *
   * The command plane is a separate process from the server driver, and it writes
   * the same goal log, so it takes part in the same round ownership. Presenting
   * a holder here means a human's `/goal resume` defers to a server process that
   * is mid-round rather than starting a second one; a human who wants the round
   * can wait for the lease to expire, which a dead process's lease does within a
   * minute. The alternative — the command plane overriding the lease — is exactly
   * the double-driving ticket 27 exists to close, arriving through the one door
   * that is meant to be the human's.
   */
  const holder = randomUUID()
  return {
    id: 'opencode-goal.tui',
    setup(context: TuiGoalContext): () => void {
      return createRoot(dispose => {
        const directory = (): string => context.location?.directory ?? ''
        const sessionID = (): string => {
          const route = context.ui.router.current()
          return route?.type === 'session' ? (route.sessionID ?? '') : ''
        }
        const toast = (variant: TuiToastInput['variant'], message: string, duration: number): void => {
          try {
            context.ui.toast.show({ variant, message, duration })
          } catch {
            // a missing toast surface must never break goal control
          }
        }

        /**
         * The session a goal round runs in, making one when none is open.
         *
         * This exists because the router does not become a session route when a
         * session is created. Measured in the opencode binary: the navigation to
         * `{type:"session", sessionID}` sits inside the prompt-submit handler
         * (`if (!i.sessionID) { ...; V.navigate({type:"session", sessionID}) }`),
         * so a session opened with `<leader>n` leaves the router on `home` until
         * the human sends something. Waiting for the route was therefore waiting
         * for the very act the goal is meant to remove, which is exactly what the
         * reported defect was: `/goal` from the home route printed a hint and
         * nothing ran until the human typed a message.
         *
         * Reusing the remembered session is what makes the model work. The model is
         * resolved per session and the continuation prompt carries no model at all,
         * so a goal in a session it did not remember runs on whatever the server
         * defaults to — measured, that default can be a model the account cannot use,
         * which is a 403 the goal then records as `usage-limited`. In a session the
         * human has been watching, the model is the one they chose.
         *
         * A session that is gone is replaced rather than mourned: closing a tab is
         * the human tidying up, not withdrawing consent, and they have `/goal pause`
         * and `/goal clear` for the explicit stops. The replacement carries the
         * remembered model because `session.create` accepts one and `session.update`
         * does not, so patching the old session was never an option.
         */
        const ensureSession = async (store: GoalStore): Promise<string | undefined> => {
          const open = sessionID()
          if (open.length > 0) return open
          const client = context.client?.session
          const create = client?.create
          if (typeof create !== 'function') return undefined

          // the room the goal last worked in, and the model it ran on
          const remembered = store.session
          if (remembered !== undefined && remembered.sessionID.length > 0 && typeof client?.get === 'function') {
            try {
              const existing = await client.get({ sessionID: remembered.sessionID })
              const id =
                typeof existing === 'string'
                  ? existing
                  : ((existing as { id?: unknown } | undefined)?.id ?? remembered.sessionID)
              if (typeof id === 'string' && id.length > 0) {
                // The room survives, but it may carry no model: every session the
                // plugin created before this read existed has none, and a session
                // with no model resolves to the server default, which is the 403.
                // `session.update` does not accept a model — measured — but
                // `session.switchModel` does, so a remembered room can be repaired
                // rather than only replaced.
                const wanted = (await readCurrentModel(context, open)) ?? remembered.model
                const carried = normaliseModel((existing as { model?: unknown } | undefined)?.model)
                if (wanted !== undefined && carried?.id !== wanted.id && typeof client.switchModel === 'function') {
                  try {
                    await client.switchModel({ sessionID: id, model: wanted })
                  } catch {
                    // a refusal leaves the room as it was; the round will fail with
                    // a readable code rather than silently running the wrong model
                  }
                }
                return id
              }
            } catch {
              // the session is gone: fall through and open a new one
            }
          }

          // The model to run on, in order of how directly it expresses the human's
          // choice: what opencode is using right now, then what this goal last ran
          // on. The second is the recovery case — the room is gone and the new one
          // must inherit its model rather than fall back to the server default.
          const model = (await readCurrentModel(context, open)) ?? remembered?.model

          let made: unknown
          try {
            made = await create.call(client!, model === undefined ? {} : { model })
          } catch {
            return undefined // a client that refused is a client that cannot help
          }
          const id =
            typeof made === 'string'
              ? made
              : ((made as { id?: unknown; sessionID?: unknown } | undefined)?.id ??
                  (made as { sessionID?: unknown } | undefined)?.sessionID)
          if (typeof id !== 'string' || id.length === 0) return undefined
          // put the human in the room the goal is working in, so the round is
          // visible rather than happening in a session nobody is looking at
          try {
            context.ui.router.navigate?.({ type: 'session', sessionID: id })
          } catch {
            // a router without navigate still leaves the goal running
          }
          return id
        }

        /**
         * Start the goal's next working round from the command plane: admit one
         * round and submit its continuation prompt. The server driver then
         * continues from the following turn's completion event.
         *
         * This crosses the same admission seam the driver crosses. It used to
         * carry its own copy of the policy, and the copies had drifted in two
         * ways that mattered: a lost compare-and-set race escaped as an
         * unhandled rejection, and an expired external wait was never cleared,
         * so a goal whose deadline had passed sat quiet forever with nothing
         * recording why. Both halves live in the seam now, so what a wait means
         * when it ends is decided once.
         */
        const kickRound = async (store: GoalStore): Promise<void> => {
          const id = await ensureSession(store)
          if (id === undefined) {
            // nothing can run the round here: say so instead of going silent
            // after a successful create/edit/resume
            toast('info', NO_SESSION_HINT, ACTION_TOAST_MS)
            return
          }
          // A turn is active; the driver admits the next round at its
          // completion. Deliberately NOT unified with the driver's in-flight
          // check: this plane asks the UI because it holds the UI, the driver
          // knows from its event stream because it submitted the prompt that
          // started the turn. Neither can answer the other's question.
          if (isRunning(context, id)) return

          const verdict = admitRound(store, { holder })
          if (verdict.kind === 'rejected') {
            // not-active, disarmed, waiting and stale-ref all mean "nothing to
            // do". `stale-ref` is the one worth naming: another writer admitted
            // this round, so this command must not start a second one.
            if (verdict.code === 'stale-ref') {
              toast('info', 'Another writer already admitted this round.', ACTION_TOAST_MS)
            }
            return
          }
          if (verdict.kind === 'blocked') {
            toast('warning', `Goal blocked (${verdict.reason.code}): ${verdict.reason.message}`, ACTION_TOAST_MS)
            return
          }

          const goal = store.view()
          if (goal === undefined) return
          // Claim the goal-and-session pair before submitting, in the same set the
          // sidebar poll's auto-start reads. Without this the two would disagree:
          // `ensureSession` navigates the router, so the next poll tick sees a
          // session and starts the goal again — round 2 for one `/goal`.
          started.add(`${goal.id}:${id}`)
          // Remember the room before submitting, so a goal that stops here — a
          // provider refusal is exactly this case — still knows where it worked and
          // what model that room resolved to. Remembering after a successful submit
          // would lose the room precisely when the human most needs it back.
          const model = readSessionModel(context, id)
          try {
            store.rememberSession({ id: goal.id, revision: goal.revision }, id, model)
          } catch {
            // a lost race with another writer: the room is a coordinate, not a
            // state verb, so failing to record it must not fail the round
          }
          try {
            await context.client?.session?.prompt({
              sessionID: id,
              text: renderGoalRoundPrompt(goal, verdict.round),
            })
          } catch (error) {
            // A provider refusal is the same stop the server driver records when
            // a turn fails, so it is classified here by the same policy rather
            // than reported as a toast and forgotten.
            const stop = providerStopReason(error)
            if (stop !== undefined) {
              if (stopGoal(store, stop)) {
                toast('warning', `Goal blocked (${stop.code}): ${stop.message}`, ACTION_TOAST_MS)
              } else {
                toast('warning', 'Goal already stopped by another writer.', ACTION_TOAST_MS)
              }
              return
            }
            toast('error', `Goal round ${verdict.round} failed to start: ${errorMessage(error)}`, ACTION_TOAST_MS)
          }
        }

        /** Ask for an objective when `/goal` is invoked with none and no goal exists. */
        const promptObjective = async (): Promise<string | undefined> => {
          try {
            const value = await context.ui.dialog.prompt({
              title: 'Set goal',
              description: 'What should the agent pursue autonomously?',
              placeholder: 'objective',
            })
            const objective = value?.trim() ?? ''
            return objective.length > 0 ? objective : undefined
          } catch {
            return undefined
          }
        }

        /** Confirm replacing a non-complete goal with a new objective. */
        const confirmReplace = async (current: GoalView, objective: string): Promise<boolean> => {
          try {
            return await context.ui.dialog.confirm({
              title: 'Replace goal?',
              message: `A goal is already ${current.phase}: "${truncateObjective(current.objective, 40)}". Clear it and start "${truncateObjective(objective, 40)}"?`,
              label: { confirm: 'Replace' },
            })
          } catch {
            return false
          }
        }

        /** Execute one raw `/goal` argument string with direct UI output. */
        const runGoalCommand = async (rawInput: string): Promise<void> => {
          const dir = directory()
          if (dir.length === 0) {
            toast('error', 'opencode-goal: no project directory is active.', ACTION_TOAST_MS)
            return
          }
          const command = parseGoalCommand(rawInput)
          const store = openStore(dir)
          const before = store.view()

          // a bare `/goal` with no goal yet: ask for the objective instead of printing usage
          if (rawInput.trim().length === 0 && command.kind === 'show' && before === undefined) {
            const objective = await promptObjective()
            if (objective === undefined) return
            await runGoalCommand(objective)
            return
          }

          // replacing a live goal is destructive: confirm before clearing it
          if (command.kind === 'create' && before !== undefined && before.phase !== 'complete') {
            const objective = command.objective ?? ''
            if (!(await confirmReplace(before, objective))) {
              toast('info', 'Kept the current goal. /goal status shows it.', ACTION_TOAST_MS)
              return
            }
            executeGoalCommand(store, parseGoalCommand('clear'))
          }

          let outcome: GoalCommandOutcome
          try {
            outcome = executeGoalCommand(store, command)
          } catch (error) {
            toast('error', errorMessage(error), ACTION_TOAST_MS)
            return
          }
          const show = command.kind === 'show'
          const variant = outcome.ok ? (show ? 'info' : 'success') : command.kind === 'invalid' ? 'error' : 'warning'
          toast(variant, outcome.text, show ? STATUS_TOAST_MS : ACTION_TOAST_MS)

          const after = store.view()
          if (shouldKickRound(command, before, after)) await kickRound(store)
        }

        /** The `/goal` command plane: one global keymap layer. */
        const layer = (): TuiKeymapLayerInput => ({
          mode: 'global',
          commands: [
            {
              id: 'goal.command',
              title: 'Goal: set or manage',
              description: '/goal [<objective>|status|edit <objective>|pause|resume|clear]',
              group: 'Goal',
              palette: true,
              slash: { name: 'goal', arguments: true },
              run: (input?: string) => runGoalCommand(input ?? ''),
            },
            {
              id: 'goal.status',
              title: 'Goal: status',
              description: 'Show the current goal, rounds, and budget',
              group: 'Goal',
              palette: true,
              run: () => runGoalCommand('status'),
            },
            {
              id: 'goal.pause',
              title: 'Goal: pause',
              description: 'Stop autonomous continuation',
              group: 'Goal',
              palette: true,
              run: () => runGoalCommand('pause'),
            },
            {
              id: 'goal.resume',
              title: 'Goal: resume',
              description: 'Resume and re-arm the current goal',
              group: 'Goal',
              palette: true,
              run: () => runGoalCommand('resume'),
            },
            {
              id: 'goal.clear',
              title: 'Goal: clear',
              description: 'Clear the current goal',
              group: 'Goal',
              palette: true,
              run: () => runGoalCommand('clear'),
            },
          ],
          bindings: [],
        })

        // `keymap.layer` resolves `Keymap.Provider` from the render tree that
        // calls it, and plugin setup never runs inside that tree — claiming the
        // layer from setup throws `Keymap.Provider is missing`. The layer is
        // therefore registered from a slot render (the built-in plugins use the
        // same `ui.slot({ append: 'app' })` posture), which mounts it inside the
        // TUI tree and disposes it when that slot unmounts.
        context.ui.slot?.({
          append: 'app',
          render: () => {
            context.keymap.layer(layer)
          },
        })

        // sidebar status view, refreshed on a poll plus TUI data events
        const [tick, setTick] = createSignal(0)
        //
        // An armed goal with nowhere to run yet starts itself when the user opens
        // a session. `kickRound` could not do it at create time because there was
        // no session to run in, and nothing else in this plugin reacts to a route
        // change — the server driver's session-created handler is one-shot per
        // session, so a session that already existed when the goal was created is
        // never adopted by it. The poll that already refreshes the sidebar is this
        // check's trigger, which also covers opening a session that already
        // existed rather than creating a new one.
        //
        // Keyed by goal and session so one session starts one goal once: a goal
        // re-created after a clear has a new id, so it starts again, and a second
        // session is not started from while the first is running the goal.
        //
        // The same key records the last block the human was told about, so a stop
        // the server driver performs is announced once rather than on every poll.
        // The driver blocks from its own process — a provider refusal reported on
        // a failed turn — and until now the only trace was in the goal log, so a
        // human watching the TUI had no way to learn the goal had stopped.
        const started = new Set<string>()
        const announcedBlock = new Set<string>()
        const autoStart = (): void => {
          const id = sessionID()
          const dir = directory()
          if (id.length === 0 || dir.length === 0) return
          const store = openStore(dir)
          const goal = store.view()
          if (goal === undefined || goal.phase !== 'active') return
          if (started.has(`${goal.id}:${id}`)) return
          // Arm before kicking, for the same reason the server driver arms on
          // session adoption: this store is a fresh fold of the durable log, so a
          // goal it did not create itself reads as disarmed, and admission would
          // reject it as a goal nobody has touched. Opening a session *is* the
          // human touching it, which is what makes arming right here.
          store.activation = 'armed'
          started.add(`${goal.id}:${id}`)
          void kickRound(store)
        }
        /**
         * Announce a stop this plane did not perform, once per goal revision.
         *
         * The server driver stops a goal on a provider refusal, and it does so in
         * its own process. The sidebar shows the code on its next refresh, but a
         * code with no message is machine-routable and silent to a human, and a
         * refresh nobody is watching announces nothing. Keyed by goal and
         * revision so a resume that stops again is announced again.
         */
        const announceBlock = (goal: GoalView): void => {
          const key = `${goal.id}:${goal.revision}`
          if (announcedBlock.has(key)) return
          announcedBlock.add(key)
          const reason = goal.blockedReason
          toast(
            'warning',
            `Goal blocked (${reason?.code ?? 'unknown'}): ${reason?.message ?? 'no reason recorded'}`,
            STATUS_TOAST_MS,
          )
        }
        const bump = (): void => {
          setTick(value => value + 1)
          autoStart()
          const dir = directory()
          if (dir.length === 0) return
          const goal = openStore(dir).view()
          if (goal !== undefined && goal.phase === 'blocked') announceBlock(goal)
        }
        const unsubscribe = context.data?.on?.('session.execution.succeeded', bump)
        const interval = refreshIntervalMs > 0 ? setInterval(bump, refreshIntervalMs) : undefined
        onCleanup(() => {
          if (interval !== undefined) clearInterval(interval)
          unsubscribe?.()
        })
        context.ui.slot?.({
          append: 'sidebar.content',
          render: () => {
            tick() // re-render on every refresh tick
            const goal = directory().length > 0 ? openStore(directory()).view() : undefined
            return <GoalSidebarView goal={goal} onCommand={command => void runGoalCommand(command)} />
          },
        })

        return () => {
          dispose()
        }
      })
    },
  }
}

/** TUI plugin module loaded by opencode's TUI plugin loader. */
export const goalTuiPlugin = createGoalTuiPlugin()

export default goalTuiPlugin
