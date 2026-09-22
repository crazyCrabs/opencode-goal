/**
 * Model-facing goal tools over the persisted per-project goal domain:
 * `get_goal`, `create_goal`, `update_goal`, and `goal_wait`.
 *
 * Mirrors the DSH tool shape (get/create/update with CAS refs) while adding
 * the pi-goal `goal_wait` escape hatch for external-event waits.
 *
 * opencode 2.x registers tools through `ctx.tool.transform`. A tool input is
 * declared as a plain JSON Schema (effect Schema and Standard Schema are also
 * accepted by the type, but the server only normalizes those two shapes into a
 * model-visible schema), the server hands the raw model JSON straight to
 * `execute` without decoding it, so every argument is validated here. The
 * executor returns `{ content }` instead of a bare string.
 */

import type { Info as ToolInfo } from '@opencode/plugin/promise/tool'
import type { GoalStore } from './state.ts'
import { GoalError, type GoalRef, type GoalView } from './types.ts'

/** One registered goal tool (opencode 2.x plugin tool shape). */
export type GoalTool = ToolInfo

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

/** Raw model arguments as the server forwards them. */
type RawArgs = Record<string, unknown>

/**
 * Register the goal tools as first-class, directly callable tools.
 *
 * opencode 2.x defaults plugin tools to Code Mode: a tool whose options leave
 * `codemode` unset only lands in the Code Mode catalog and must be invoked
 * through the synthetic `execute` tool. These four tools are the plugin's whole
 * model-facing contract and both the system prompt and the continuation prompt
 * name them directly, so the model must be able to call them by name — the same
 * way it calls `read` or `write`.
 */
const DIRECT_TOOL_OPTIONS = { codemode: false } as const

/** Read one required non-empty string argument. */
function requireString(args: RawArgs, field: string): string {
  const value = args[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GoalError('GOAL_INVALID_EDIT', `${field} must be a non-empty string`)
  }
  return value
}

/** Read one optional string argument. */
function optionalString(args: RawArgs, field: string): string | undefined {
  const value = args[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new GoalError('GOAL_INVALID_EDIT', `${field} must be a string when present`)
  }
  return value
}

/** Read one required positive safe-integer argument. */
function requirePositiveInteger(args: RawArgs, field: string): number {
  const value = args[field]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new GoalError('GOAL_INVALID_EDIT', `${field} must be a positive safe integer`)
  }
  return value
}

/** Read one optional non-negative number argument. */
function optionalNumber(args: RawArgs, field: string): number | undefined {
  const value = args[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new GoalError('GOAL_INVALID_EDIT', `${field} must be a non-negative number when present`)
  }
  return value
}

const UPDATE_ACTIONS = ['complete', 'blocked', 'pause', 'resume', 'edit'] as const

/**
 * Create the goal tool bundle for one project. Every tool resolves its store
 * through the plugin's location directory: the server plugin is loaded once
 * per location, so all of its sessions share this one goal log.
 */
export function goalTools(
  root: string,
  getStore: (directory: string) => GoalStore,
): readonly GoalTool[] {
  const store = (): GoalStore => getStore(root)
  return [
    {
      name: 'get_goal',
      description:
        'Read the current goal of this project, including its exact id/revision, objective, phase, rounds, round limit, token budget, usage, and whether a continuation is armed. Call this before update_goal.',
      options: DIRECT_TOOL_OPTIONS,
      input: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      async execute() {
        return { content: JSON.stringify(goalValue(store().view())) }
      },
    },

    {
      name: 'create_goal',
      description:
        'Create one persisted completion goal for the current project when the current task is a long-running objective that should continue across autonomous rounds. Replaces a completed goal; a non-complete goal must be cleared first. Starts autonomous continuation (rounds, guarded by the round cap).',
      options: DIRECT_TOOL_OPTIONS,
      input: {
        type: 'object',
        properties: {
          objective: { type: 'string', description: 'The concrete completion objective.' },
          max_goal_rounds: {
            type: 'integer',
            description: 'Optional positive integer limit on automatic continuation rounds (default 25).',
          },
          token_budget: {
            type: 'number',
            description: 'Optional total token budget; continuation stops when provider-reported usage reaches it (0 = unlimited).',
          },
        },
        required: ['objective'],
        additionalProperties: false,
      },
      async execute(rawArgs: unknown) {
        const args = (rawArgs ?? {}) as RawArgs
        const view = store().create(
          requireString(args, 'objective'),
          optionalNumber(args, 'max_goal_rounds') ?? 25,
          optionalNumber(args, 'token_budget') ?? 0,
        )
        return { content: JSON.stringify(goalValue(view)) }
      },
    },

    {
      name: 'update_goal',
      description:
        'Update the exact current goal revision. Actions: complete (mark achieved with evidence), blocked (report a true impasse), pause, resume, edit (objective and/or max_goal_rounds). Requires the exact goal_id and revision returned by get_goal; stale refs are rejected.',
      options: DIRECT_TOOL_OPTIONS,
      input: {
        type: 'object',
        properties: {
          goal_id: { type: 'string', description: 'Exact id returned by get_goal.' },
          revision: { type: 'integer', description: 'Exact positive revision returned by get_goal.' },
          action: {
            type: 'string',
            enum: [...UPDATE_ACTIONS],
            description: 'The operation to perform.',
          },
          objective: { type: 'string', description: 'Replacement objective; valid only with action edit.' },
          max_goal_rounds: { type: 'integer', description: 'Replacement round cap; valid only with action edit.' },
          summary: {
            type: 'string',
            description: 'Completion evidence summary; required with action complete.',
          },
          blocked_reason: {
            type: 'string',
            description: 'Concrete blocking condition; required with action blocked.',
          },
        },
        required: ['goal_id', 'revision', 'action'],
        additionalProperties: false,
      },
      async execute(rawArgs: unknown) {
        const args = (rawArgs ?? {}) as RawArgs
        const ref = goalRef(requireString(args, 'goal_id'), requirePositiveInteger(args, 'revision'))
        const action = requireString(args, 'action')
        if (!(UPDATE_ACTIONS as readonly string[]).includes(action)) {
          throw new GoalError('GOAL_INVALID_EDIT', `unknown action ${action}`)
        }
        switch (action) {
          case 'edit': {
            const objective = optionalString(args, 'objective')
            const maxGoalRounds = optionalNumber(args, 'max_goal_rounds')
            if (objective === undefined && maxGoalRounds === undefined) {
              throw new GoalError('GOAL_INVALID_EDIT', 'edit requires objective and/or max_goal_rounds')
            }
            return {
              content: JSON.stringify(goalValue(store().edit(ref, objective, maxGoalRounds))),
            }
          }
          case 'pause':
            return { content: JSON.stringify(goalValue(store().pause(ref))) }
          case 'resume':
            return { content: JSON.stringify(goalValue(store().resume(ref))) }
          case 'complete': {
            const summary = optionalString(args, 'summary')
            if (summary === undefined || summary.trim().length === 0) {
              throw new GoalError('GOAL_INVALID_EDIT', 'complete requires a summary of completion evidence')
            }
            if (summary.toLowerCase().includes('not complete') || summary.toLowerCase().includes('still fail')) {
              throw new GoalError('GOAL_INVALID_EDIT', 'completion summary contradicts completion')
            }
            return { content: JSON.stringify(goalValue(store().complete(ref))) }
          }
          case 'blocked': {
            const blockedReason = optionalString(args, 'blocked_reason')
            if (blockedReason === undefined || blockedReason.trim().length === 0) {
              throw new GoalError('GOAL_INVALID_EDIT', 'blocked requires a concrete blocked_reason')
            }
            return {
              content: JSON.stringify(
                goalValue(store().block(ref, { code: 'model-reported', message: blockedReason.trim() })),
              ),
            }
          }
          default:
            throw new GoalError('GOAL_INVALID_EDIT', `unknown action ${action}`)
        }
      },
    },

    {
      name: 'goal_wait',
      description:
        'Wait for an external event (e.g. a monitor, review, or CI run). Suppresses automatic continuation until the optional deadline (resume_after_ms) or until other non-goal work arrives. Use only after arranging an external wake source.',
      options: DIRECT_TOOL_OPTIONS,
      input: {
        type: 'object',
        properties: {
          goal_id: { type: 'string', description: 'Exact id returned by get_goal.' },
          revision: { type: 'integer', description: 'Exact positive revision returned by get_goal.' },
          reason: { type: 'string', description: 'Why the goal is waiting (1-1000 chars).' },
          resume_after_ms: {
            type: 'number',
            description: 'Optional safety wake-up deadline in ms (clamped to at least 10s).',
          },
        },
        required: ['goal_id', 'revision', 'reason'],
        additionalProperties: false,
      },
      async execute(rawArgs: unknown) {
        const args = (rawArgs ?? {}) as RawArgs
        const ref = goalRef(requireString(args, 'goal_id'), requirePositiveInteger(args, 'revision'))
        return {
          content: JSON.stringify(
            goalValue(store().wait(ref, requireString(args, 'reason'), optionalNumber(args, 'resume_after_ms'))),
          ),
        }
      },
    },
  ]
}
