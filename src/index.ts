/**
 * opencode-goal: persistent autonomous goals for opencode.
 *
 * Combines the DSH goal architecture (event-sourced log, CAS refs, orthogonal
 * phase/activation, round budget) with the pi-goal guardrails (token budgets,
 * no-progress detection, external waits, stale-turn guards).
 *
 * This is the server half: model-facing goal tools plus the continuation
 * driver. The human `/goal` slash command lives in the TUI half
 * (`tui.tsx`) and executes directly in the UI without a server round trip; both
 * halves converge on `<worktree>/.opencode/goal-log.jsonl`.
 *
 * The driver runs on three events: `session.execution.succeeded|failed|
 * interrupted` continues the goal after each finished turn — opencode 2.x
 * publishes no `session.idle` when a turn ends, so the execution events are
 * the only reliable completion signal — `session.created` adopts an active
 * goal into the newly opened session (the human's go-ahead, replacing a manual
 * resume), and `session.deleted` forgets the session. The legacy
 * `session.idle` is still honored while no round is in flight.
 *
 * Events carry no project directory on the execution family, and a server
 * loads this plugin once per location, so every instance sees every project's
 * events: each event is therefore resolved to its session's directory (from
 * the `session.created` payload, else `session.get`) and driven only when that
 * directory belongs to this instance's root.
 *
 * opencode 2.x loads this as a plugin definition — an object with an `id` and a
 * `setup` function that receives the plugin context. Everything is registered
 * imperatively on that context inside `setup`: the goal tools through
 * `tool.transform`, the system-prompt goal block through `session.hook`, and
 * the continuation driver through `event.subscribe`. The plugin is loaded once
 * per location, so it owns one store keyed by its load directory
 * (`ctx.location.directory`).
 */

import type { Plugin } from '@opencode/plugin'
import { GoalDriver } from './driver.ts'
import { GoalStore } from './state.ts'
import { goalTools } from './tools.ts'

/** Build the server-half plugin definition. */
export const OpenCodeGoalPlugin: Plugin.Plugin = {
  id: 'opencode-goal',

  async setup(ctx) {
    const root = ctx.location.directory

    /** One event-sourced store per project root. */
    const stores = new Map<string, GoalStore>()
    const getStore = (dir: string): GoalStore => {
      const key = dir.length > 0 ? dir : root
      let store = stores.get(key)
      if (store === undefined) {
        store = new GoalStore(key)
        stores.set(key, store)
      }
      return store
    }

    const log = (message: string, extra?: Record<string, unknown>): void => {
      console.log(`[opencode-goal] ${message}`, extra ?? '')
    }

    /**
     * Session directory per session ID, learned from `session.created`: the
     * execution events carry no location, and the session's directory decides
     * which project's goal (and plugin instance) owns its turns.
     */
    const sessionDirectories = new Map<string, string>()
    /** Subagent/child sessions (they carry a parentID) never run goal rounds. */
    const childSessions = new Set<string>()

    /** Normalize a path for comparison: Windows accepts both separators. */
    const normalizePath = (value: string): string => value.replace(/\//g, '\\').toLowerCase()

    /** Whether one directory belongs to this plugin instance's project root. */
    const ownsDirectory = (directory: string): boolean => {
      const rootPath = normalizePath(root)
      const dir = normalizePath(directory)
      return dir === rootPath || dir.startsWith(`${rootPath}\\`)
    }

    /**
     * Remember one session's project directory and whether it is a subagent
     * session, so later location-less events can be attributed correctly.
     */
    const rememberSession = (sessionID: string, directory: string | undefined, parentID: unknown): void => {
      if (directory !== undefined && directory.length > 0) sessionDirectories.set(sessionID, directory)
      if (typeof parentID === 'string' && parentID.length > 0) childSessions.add(sessionID)
    }

    /**
     * Resolve the directory a session's turn belongs to, or undefined when it
     * belongs to another project (another plugin instance drives it there) or
     * is a subagent session. Falls back to a session lookup for sessions this
     * process never saw created — a session reopened after a restart.
     */
    const resolveTurnSession = async (
      sessionID: string,
      envelopeDirectory: string | undefined,
    ): Promise<string | undefined> => {
      if (childSessions.has(sessionID)) return undefined
      let directory = sessionDirectories.get(sessionID)
      if (directory === undefined) {
        try {
          // the plugin's session.get returns the session info; the directory
          // has been seen both at the top level and under `location`
          const info = (await ctx.session.get({ sessionID })) as
            | { directory?: string; parentID?: string; location?: { directory?: string } }
            | undefined
          if (info === undefined) return undefined
          const infoDirectory = info.directory ?? info.location?.directory
          rememberSession(sessionID, infoDirectory, info.parentID)
          if (childSessions.has(sessionID)) return undefined
          directory = infoDirectory
        } catch {
          return undefined // a failed lookup is retried on the next event
        }
      }
      if (directory === undefined || directory.length === 0) directory = envelopeDirectory
      if (directory === undefined || !ownsDirectory(directory)) return undefined
      return directory
    }

    const driver = new GoalDriver({
      getStore,
      session: ctx.session,
      log,
    })
    driver.setDirectory(root)

    // Materialize the root store now: a store that already exists observes later
    // external mutations (e.g. a `/goal` create from the TUI command plane) as
    // changes and arms the driver. A store created lazily after such a mutation
    // would treat the goal as pre-existing and stay disarmed.
    getStore(root)

    log('plugin initialized', { root })

    // Goal tools (`get_goal`, `create_goal`, `update_goal`, `goal_wait`).
    const tools = goalTools(root, getStore)
    const toolRegistration = await ctx.tool.transform((editor) => {
      for (const tool of tools) editor.add(tool)
    })

    // System-prompt injection: surface the active goal to every model turn. The
    // plugin is loaded once per location, so its sessions share this directory
    // and therefore this one goal log.
    const systemHook = await ctx.session.hook('context', (event) => {
      const goal = getStore(root).view()
      if (goal === undefined || goal.phase !== 'active') return
      const budget = goal.tokenBudget > 0
        ? ` | budget ${goal.usage.inputTokens + goal.usage.outputTokens}/${goal.tokenBudget}`
        : ''
      event.system.push({
        type: 'text',
        text: [
          `[opencode-goal] Active goal (round ${goal.roundsStarted + 1}/${goal.maxGoalRounds}${budget}): ${goal.objective}`,
          'Keep working toward this objective across turns. Call get_goal to inspect it, update_goal(action="complete") with evidence when achieved, update_goal(action="blocked") for a true impasse, or goal_wait while waiting on external events.',
        ].join('\n'),
      })
    })

    // Continuation driver: one guarded round per finished turn while the goal
    // is active and armed — and one first round when a session is created,
    // because opening a session is the human's go-ahead to run the goal. The
    // event stream ends when the server shuts down.
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === 'session.idle') {
            // legacy completion signal: honored only while no round is in
            // flight, because 2.x can emit it without any turn finishing
            const sessionID = event.data.sessionID
            if (sessionID === undefined) continue
            void (async () => {
              const directory = await resolveTurnSession(sessionID, event.location?.directory)
              if (directory !== undefined) await driver.onSessionIdle(sessionID, directory)
            })()
          } else if (event.type === 'session.created') {
            // opencode reports one creation per entry; `data` has been seen both
            // as a single payload and as a list, so normalize before driving
            const entries = Array.isArray(event.data) ? event.data : [event.data]
            for (const entry of entries) {
              const sessionID = entry.sessionID ?? entry.info?.id
              if (sessionID === undefined) continue
              const parentID = entry.parentID ?? entry.info?.parentID
              const directory = entry.location?.directory ?? entry.info?.directory ?? event.location?.directory ?? root
              rememberSession(sessionID, directory, parentID)
              if (childSessions.has(sessionID)) continue // a subagent session never runs goal rounds
              if (!ownsDirectory(directory)) continue // another instance owns that project
              void driver.onSessionCreated(sessionID, directory)
            }
          } else if (
            event.type === 'session.execution.succeeded' ||
            event.type === 'session.execution.failed' ||
            event.type === 'session.execution.interrupted'
          ) {
            // the only reliable turn-completion signal in opencode 2.x: this is
            // what keeps the autonomous loop advancing round after round
            const sessionID = event.data.sessionID
            if (sessionID === undefined) continue
            const reason = event.type === 'session.execution.interrupted' ? event.data.reason : undefined
            void (async () => {
              const directory = await resolveTurnSession(sessionID, event.location?.directory)
              if (directory !== undefined) await driver.onTurnFinished(sessionID, directory, reason)
            })()
          } else if (event.type === 'session.deleted') {
            const sessionID = event.data.sessionID
            if (sessionID === undefined) continue
            sessionDirectories.delete(sessionID)
            childSessions.delete(sessionID)
            driver.forget(sessionID)
          }
        }
      } catch {
        // the server closed the stream
      }
    })()

    return async () => {
      controller.abort()
      await systemHook.dispose()
      await toolRegistration.dispose()
    }
  },
}

export default OpenCodeGoalPlugin
