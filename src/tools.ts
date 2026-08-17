/**
 * Model-facing goal tools over the persisted per-project goal domain:
 * `get_goal`, `create_goal`, `update_goal`, and `goal_wait`.
 *
 * Mirrors the DSH tool shape (get/create/update with CAS refs) while adding
 * the pi-goal `goal_wait` escape hatch for external-event waits.
 */

import { tool } from '@opencode-ai/plugin'
import type { GoalStore } from './state.ts'
import { GoalError, type GoalRef, type GoalView } from './types.ts'

/** Resolve the exact compare-and-set ref from model arguments. */
function goalRef(goalID: string, revision: number): GoalRef {
  if (goalID.length === 0 || goalID !== goalID.trim() || !Number.isSafeInteger(revision) || revision < 1) {
    throw new GoalError('GOAL_INVALID_EDIT', 'goal_id must be non-empty and revision must be a positive safe integer')
  }
  return { id: goalID, revision }
}

/** Compact model result: the current projection or null. */
function goalValue(goal: GoalView | undefined): unknown {
  if (goal === undefined) return { goal: null }
  return {
    goal: {
      id: goal.id,
      revision: goal.revision,
      objective: goal.objective,
      phase: goal.phase,
      roundsStarted: goal.roundsStarted,
      maxGoalRounds: goal.maxGoalRounds,
      tokenBudget: goal.tokenBudget,
      usage: goal.usage,
      ...goal.blockedReason === undefined ? {} : { blockedReason: goal.blockedReason },
    },
    activation: goal.activation,
    waitUntil: goal.waitUntil,
    waitReason: goal.waitReason,
  }
}

/** Create the goal tool bundle for one store resolver. */
export function goalTools(getStore: (directory: string) => GoalStore): Record<string, ReturnType<typeof tool>> {
  return {
    get_goal: tool({
      description: 'Read the current goal of this project, including its exact id/revision, objective, phase, rounds, round limit, token budget, usage, and whether a continuation is armed. Call this before update_goal.',
      args: {},
      async execute(_args, context) {
        const store = getStore(context.directory)
        return JSON.stringify(goalValue(store.view()))
      },
    }),

    create_goal: tool({
      description: 'Create one persisted completion goal for the current project when the current task is a long-running objective that should continue across autonomous rounds. Replaces a completed goal; a non-complete goal must be cleared first. Starts autonomous continuation (rounds, guarded by the round cap).',
      args: {
        objective: tool.schema.string().describe('The concrete completion objective.'),
        max_goal_rounds: tool.schema.number().optional().describe('Optional positive integer limit on automatic continuation rounds (default 25).'),
        token_budget: tool.schema.number().optional().describe('Optional total token budget; continuation stops when provider-reported usage reaches it (0 = unlimited).'),
      },
      async execute(args, context) {
        const store = getStore(context.directory)
        const view = store.create(
          args.objective,
          args.max_goal_rounds ?? 25,
          args.token_budget ?? 0,
        )
        return JSON.stringify(goalValue(view))
      },
    }),

    update_goal: tool({
      description: 'Update the exact current goal revision. Actions: complete (mark achieved with evidence), blocked (report a true impasse), pause, resume, edit (objective and/or max_goal_rounds). Requires the exact goal_id and revision returned by get_goal; stale refs are rejected.',
      args: {
        goal_id: tool.schema.string().describe('Exact id returned by get_goal.'),
        revision: tool.schema.number().describe('Exact positive revision returned by get_goal.'),
        action: tool.schema.enum(['complete', 'blocked', 'pause', 'resume', 'edit']).describe('The operation to perform.'),
        objective: tool.schema.string().optional().describe('Replacement objective; valid only with action edit.'),
        max_goal_rounds: tool.schema.number().optional().describe('Replacement round cap; valid only with action edit.'),
        summary: tool.schema.string().optional().describe('Completion evidence summary; required with action complete.'),
        blocked_reason: tool.schema.string().optional().describe('Concrete blocking condition; required with action blocked.'),
      },
      async execute(args, context) {
        const store = getStore(context.directory)
        const ref = goalRef(args.goal_id, args.revision)
        switch (args.action) {
          case 'edit': {
            if (args.objective === undefined && args.max_goal_rounds === undefined) {
              throw new GoalError('GOAL_INVALID_EDIT', 'edit requires objective and/or max_goal_rounds')
            }
            return JSON.stringify(goalValue(store.edit(ref, args.objective, args.max_goal_rounds)))
          }
          case 'pause':
            return JSON.stringify(goalValue(store.pause(ref)))
          case 'resume':
            return JSON.stringify(goalValue(store.resume(ref)))
          case 'complete': {
            if (args.summary === undefined || args.summary.trim().length === 0) {
              throw new GoalError('GOAL_INVALID_EDIT', 'complete requires a summary of completion evidence')
            }
            if (args.summary.toLowerCase().includes('not complete') || args.summary.toLowerCase().includes('still fail')) {
              throw new GoalError('GOAL_INVALID_EDIT', 'completion summary contradicts completion')
            }
            return JSON.stringify(goalValue(store.complete(ref)))
          }
          case 'blocked': {
            if (args.blocked_reason === undefined || args.blocked_reason.trim().length === 0) {
              throw new GoalError('GOAL_INVALID_EDIT', 'blocked requires a concrete blocked_reason')
            }
            return JSON.stringify(goalValue(store.block(ref, { code: 'model-reported', message: args.blocked_reason.trim() })))
          }
          default:
            throw new GoalError('GOAL_INVALID_EDIT', `unknown action ${String(args.action)}`)
        }
      },
    }),

    goal_wait: tool({
      description: 'Wait for an external event (e.g. a monitor, review, or CI run). Suppresses automatic continuation until the optional deadline (resume_after_ms) or until other non-goal work arrives. Use only after arranging an external wake source.',
      args: {
        goal_id: tool.schema.string().describe('Exact id returned by get_goal.'),
        revision: tool.schema.number().describe('Exact positive revision returned by get_goal.'),
        reason: tool.schema.string().describe('Why the goal is waiting (1-1000 chars).'),
        resume_after_ms: tool.schema.number().optional().describe('Optional safety wake-up deadline in ms (clamped to at least 10s).'),
      },
      async execute(args, context) {
        const store = getStore(context.directory)
        const ref = goalRef(args.goal_id, args.revision)
        return JSON.stringify(goalValue(store.wait(ref, args.reason, args.resume_after_ms)))
      },
    }),
  }
}