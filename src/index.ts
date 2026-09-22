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
 * The driver runs on two events: `session.created` adopts an active goal into
 * the newly opened session (the human's go-ahead, replacing a manual resume),
 * and `session.idle` admits the next round after each finished turn.
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

    // Continuation driver: one guarded round per `session.idle` while the goal
    // is active and armed — and one first round when a session is created,
    // because opening a session is the human's go-ahead to run the goal. The
    // event stream ends when the server shuts down.
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === 'session.idle') {
            void driver.onSessionIdle(event.data.sessionID, event.location?.directory ?? root)
          } else if (event.type === 'session.created') {
            // opencode reports one creation per entry; `data` has been seen both
            // as a single payload and as a list, so normalize before driving
            const entries = Array.isArray(event.data) ? event.data : [event.data]
            for (const entry of entries) {
              const sessionID = entry.sessionID ?? entry.info?.id
              const directory = entry.info?.directory ?? event.location?.directory ?? root
              if (sessionID !== undefined) void driver.onSessionCreated(sessionID, directory)
            }
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
