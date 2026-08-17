/**
 * opencode-goal: persistent autonomous goals for opencode.
 *
 * Combines the DSH goal architecture (event-sourced log, CAS refs, orthogonal
 * phase/activation, round budget) with the pi-goal guardrails (token budgets,
 * no-progress detection, external waits, stale-turn guards).
 *
 * Load as a plugin: `opencode plugin opencode-goal`, or drop into
 * `.opencode/plugins/` / `~/.config/opencode/plugins/`.
 */

import type { Plugin } from '@opencode-ai/plugin'
import { GoalDriver } from './driver.ts'
import { GoalStore } from './state.ts'
import { executeGoalCommand, parseGoalCommand } from './commands.ts'
import { goalTools } from './tools.ts'

export const OpenCodeGoalPlugin: Plugin = async ({ client, directory, worktree }) => {
  const root = worktree && worktree.length > 0 ? worktree : directory

  /** One event-sourced store per project root. */
  const stores = new Map<string, GoalStore>()
  const getStore = (dir: string): GoalStore => {
    const key = dir || root
    let store = stores.get(key)
    if (store === undefined) {
      store = new GoalStore(key)
      stores.set(key, store)
    }
    return store
  }

  const driver = new GoalDriver({
    getStore,
    client,
    log: (message, extra) => {
      void client.app.log({
        body: {
          service: 'opencode-goal',
          level: 'info',
          message,
          extra: extra ?? {},
        },
      }).catch(() => {
        console.log(`[opencode-goal] ${message}`, extra ?? '')
      })
    },
  })
  driver.setDirectory(root)

  await client.app.log({
    body: {
      service: 'opencode-goal',
      level: 'info',
      message: 'opencode-goal plugin initialized',
      extra: { root, worktree },
    },
  }).catch(() => {
    console.log('[opencode-goal] plugin initialized', { root })
  })

  return {
    tool: goalTools(getStore),

    'command.execute.before': async (input, output) => {
      if (input.command !== 'goal') return
      // resolve the session's project directory so tools, commands, and the
      // driver all share one store key
      let dir = root
      try {
        const session = await client.session.get({ path: { id: input.sessionID } })
        if (session.data?.directory && session.data.directory.length > 0) dir = session.data.directory
      } catch {
        // fall back to the plugin root
      }
      const store = getStore(dir)
      let result: string
      try {
        result = executeGoalCommand(store, parseGoalCommand(input.arguments))
      } catch (error: unknown) {
        result = error instanceof Error ? `goal command failed: ${error.message}` : 'goal command failed'
      }
      // inject the command result as reply parts
      output.parts = [{ type: 'text', text: result, synthetic: true }] as typeof output.parts
    },

    event: async ({ event }) => {
      switch (event.type) {
        case 'session.idle': {
          // derive the project directory for this session if possible
          let dir = root
          try {
            const session = await client.session.get({ path: { id: event.properties.sessionID } })
            if (session.data?.directory && session.data.directory.length > 0) dir = session.data.directory
          } catch {
            // fall back to the plugin root
          }
          await driver.onSessionIdle(event.properties.sessionID, dir)
          return
        }
        case 'message.updated': {
          const info = event.properties.info
          if (info.role === 'assistant') {
            // attribute provider-reported usage to the active goal
            let dir = root
            try {
              const session = await client.session.get({ path: { id: info.sessionID } })
              if (session.data?.directory && session.data.directory.length > 0) dir = session.data.directory
            } catch {
              // fall back to the plugin root
            }
            driver.onAssistantMessage(dir, {
              tokens: info.tokens,
              cost: info.cost,
            })
          }
          return
        }
        default:
          return
      }
    },

    'experimental.chat.system.transform': async (input, output) => {
      let dir = root
      if (input.sessionID !== undefined) {
        try {
          const session = await client.session.get({ path: { id: input.sessionID } })
          if (session.data?.directory && session.data.directory.length > 0) dir = session.data.directory
        } catch {
          // fall back to the plugin root
        }
      }
      const store = getStore(dir)
      const goal = store.view()
      if (goal === undefined || goal.phase !== 'active') return
      const budget = goal.tokenBudget > 0
        ? ` | budget ${goal.usage.inputTokens + goal.usage.outputTokens}/${goal.tokenBudget}`
        : ''
      output.system.push(
        [
          `[opencode-goal] Active goal (round ${goal.roundsStarted + 1}/${goal.maxGoalRounds}${budget}): ${goal.objective}`,
          'Keep working toward this objective across turns. Call get_goal to inspect it, update_goal(action="complete") with evidence when achieved, update_goal(action="blocked") for a true impasse, or goal_wait while waiting on external events.',
        ].join('\n'),
      )
    },
  }
}

export default OpenCodeGoalPlugin