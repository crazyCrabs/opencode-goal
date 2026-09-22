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

import { createRoot, createSignal, onCleanup, Show, type JSX } from 'solid-js'
import { executeGoalCommand, parseGoalCommand, type GoalCommandOutcome, type ParsedGoalCommand } from './commands.ts'
import { goalBlockReason, renderGoalRoundPrompt } from './driver.ts'
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
}

/** Minimal TUI plugin context surface (opencode 2.x TUI plugin API). */
export interface TuiGoalContext {
  location?: { directory: string; workspaceID?: string }
  client?: { session?: TuiSessionClient }
  data?: {
    on?(event: string, handler: (event: unknown) => void): () => void
    session?: { status?(sessionID: string): string | undefined }
  }
  keymap: TuiKeymapApi
  ui: {
    toast: { show(input: TuiToastInput): void }
    dialog: TuiDialogApi
    router: { current(): TuiRouteRef | undefined }
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
export function goalSidebarSummary(goal: GoalView | undefined): { headline: string; detail: string } {
  if (goal === undefined) return { headline: 'No goal — /goal <objective>', detail: '' }
  const progress = goal.tokenBudget > 0
    ? `rounds ${goal.roundsStarted}/${goal.maxGoalRounds} · tokens ${goal.usage.inputTokens + goal.usage.outputTokens}/${goal.tokenBudget}`
    : `rounds ${goal.roundsStarted}/${goal.maxGoalRounds}`
  // only the durable phase is shown: activation is process-local and the sidebar
  // folds the log from its own process, so it cannot observe the driver's state
  const badge = goal.phase === 'blocked' ? `blocked: ${goal.blockedReason?.code ?? 'unknown'}` : goal.phase
  return { headline: `${badge} · ${truncateObjective(goal.objective)}`, detail: progress }
}

/** Sidebar row: durable phase, objective, and budget progress. */
function GoalSidebarView(props: { goal: GoalView | undefined; onCommand(command: string): void }) {
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
         * Start the goal's first working round from the command plane: admit one
         * round and submit its continuation prompt. The server driver then
         * continues from the following `session.idle`.
         */
        const kickRound = async (store: GoalStore): Promise<void> => {
          const id = sessionID()
          if (id.length === 0) return
          if (isRunning(context, id)) return // a turn is active; the driver admits the next round at idle
          const goal = store.view()
          if (goal === undefined || goal.phase !== 'active') return
          if (store.waitUntil > Date.now()) return
          const blockReason = goalBlockReason(store, goal)
          if (blockReason !== undefined) {
            store.block({ id: goal.id, revision: goal.revision }, blockReason)
            toast('warning', `Goal blocked (${blockReason.code}): ${blockReason.message}`, ACTION_TOAST_MS)
            return
          }
          const admitted = store.continue({ id: goal.id, revision: goal.revision })
          try {
            await context.client?.session?.prompt({
              sessionID: id,
              text: renderGoalRoundPrompt(admitted, admitted.roundsStarted),
            })
          } catch (error) {
            toast('error', `Goal round ${admitted.roundsStarted} failed to start: ${errorMessage(error)}`, ACTION_TOAST_MS)
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
        const bump = (): void => {
          setTick(value => value + 1)
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
