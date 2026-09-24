/**
 * Model-facing goal tools over the persisted per-project goal domain:
 * `get_goal`, `create_goal`, `update_goal`, and `goal_wait`.
 *
 * Mirrors the DSH tool shape (get/create/update with CAS refs) while adding
 * the pi-goal `goal_wait` escape hatch for external-event waits.
 *
 * The model no longer quotes a ref. It used to have to read `get_goal`, copy the
 * id and revision into every mutation, and be rejected on a typo — a whole
 * failure class that bought nothing, because the compare-and-set those fields
 * feed is exactly as strong when the server reads the current goal itself. Each
 * mutation resolves the goal at the moment it runs, which is fresher than the
 * model reading it at the start of its turn. `get_goal` still reports the id and
 * revision, because a human reading the log wants them; it no longer tells the
 * model to echo them.
 *
 * opencode 2.x registers tools through `ctx.tool.transform`. A tool input is
 * declared as a plain JSON Schema (effect Schema and Standard Schema are also
 * accepted by the type, but the server only normalizes those two shapes into a
 * model-visible schema), the server hands the raw model JSON straight to
 * `execute` without decoding it, so every argument is validated here. The
 * executor returns `{ content }` instead of a bare string.
 */

import type { Info as ToolInfo } from '@opencode/plugin/promise/tool'
import { GoalStore } from './state.ts'
import { gateBlock, JUDGMENT_ROUNDS } from './round-policy.ts'
import {
  GoalError,
  type CompletionCheck,
  type GoalRef,
  type GoalView,
  validateCompletionClaim,
} from './types.ts'

/** One registered goal tool (opencode 2.x plugin tool shape). */
export type GoalTool = ToolInfo

/** Compact model result: the current projection or null. */
function goalField(goal: GoalView | undefined): unknown {
  if (goal === undefined) return null
  return {
    id: goal.id,
    revision: goal.revision,
    objective: goal.objective,
    phase: goal.phase,
    roundsStarted: goal.roundsStarted,
    maxGoalRounds: goal.maxGoalRounds,
    tokenBudget: goal.tokenBudget,
    usage: goal.usage,
    ...goal.blockedReason === undefined ? {} : { blockedReason: goal.blockedReason },
    ...goal.completion === undefined ? {} : { completion: goal.completion },
  }
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
/** Read one optional non-negative number argument. */
function optionalNumber(args: RawArgs, field: string): number | undefined {
  const value = args[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new GoalError('GOAL_INVALID_EDIT', `${field} must be a non-negative number when present`)
  }
  return value
}

/** A required numeric argument, rejected when absent or not a finite number. */
function requireNumber(args: RawArgs, field: string): number {
  const value = args[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new GoalError('GOAL_INVALID_EDIT', `${field} is required and must be a number`)
  }
  return value
}

const UPDATE_ACTIONS = ['complete', 'blocked', 'pause', 'resume', 'edit'] as const

/**
 * Create the goal tool bundle for one project. Every tool resolves its store
 * through the plugin's location directory: the server plugin is loaded once
 * per location, so all of its sessions share this one goal log.
 */
/**
 * Build the four goal tools over one project's goal.
 *
 * The store is memoized here, and that is load-bearing rather than an
 * optimisation: `GoalStore` carries process-local state — activation, the
 * external-wait deadline, the no-progress fingerprint, and the judgment streak —
 * that only means anything across calls if every call sees the same instance. A
 * factory that built a fresh store per call would reset all of it between two
 * tool calls in the same round, which is exactly how a streak could never reach
 * three.
 *
 * `goalTools` is called once per plugin location, so this map lives as long as
 * the tools do. A memoizing `getStore` (as the plugin passes) is harmless here;
 * a plain one becomes correct.
 */
export function goalTools(
  root: string,
  getStore: (directory: string) => GoalStore,
  commandsFor?: (directory: string) => readonly number[],
): readonly GoalTool[] {
  /** Exit codes of commands that actually ran, or none when nobody is counting. */
  const ranCommands = (directory: string): readonly number[] =>
    commandsFor === undefined ? [] : commandsFor(directory)
  const stores = new Map<string, GoalStore>()
  const store = (): GoalStore => {
    let cached = stores.get(root)
    if (cached === undefined) {
      cached = getStore(root)
      stores.set(root, cached)
    }
    return cached
  }
  return [
    {
      name: 'get_goal',
      description:
        'Read the current goal of this project: its objective, phase, rounds, round limit, token budget, usage, and whether a continuation is armed. It also reports the id and revision, which are for a human reading the log — mutations resolve the goal themselves, so you never quote them.',
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
          max_turns_without_tool_call: {
            type: 'integer',
            description:
              'Optional consecutive turns that may end with no tool call before the goal is stalled as talking without acting (default 2; 0 disables).',
          },
        },
        required: ['objective'],
        additionalProperties: false,
      },
      async execute(rawArgs: unknown) {
        const args = (rawArgs ?? {}) as RawArgs
        const view = store().create(
          requireString(args, 'objective'),
          optionalNumber(args, 'max_goal_rounds') ?? GoalStore.DEFAULT_MAX_GOAL_ROUNDS,
          optionalNumber(args, 'token_budget') ?? 0,
          optionalNumber(args, 'max_turns_without_tool_call'),
        )
        return { content: JSON.stringify(goalValue(view)) }
      },
    },

    {
      name: 'update_goal',
      description:
        'Update the current goal. Actions: complete (mark achieved, with a structured claim of what was done), blocked (report a true impasse), pause, resume, edit (objective and/or max_goal_rounds). Resolves which goal you are working on itself, so you never quote an id or a revision; a stale mutation is refused rather than silently overwriting a newer one.',
      options: DIRECT_TOOL_OPTIONS,
      input: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [...UPDATE_ACTIONS],
            description: 'The operation to perform.',
          },
          objective: { type: 'string', description: 'Replacement objective; valid only with action edit.' },
          max_goal_rounds: { type: 'integer', description: 'Replacement round cap; valid only with action edit.' },
          claim: {
            type: 'object',
            description:
              'Structured completion claim; required with action complete. What you actually did, so it can be checked against the event stream rather than taken on trust.',
            properties: {
              summary: { type: 'string', description: 'What was achieved, in one or two sentences.' },
              criteria: {
                type: 'array',
                description: 'At least one requirement of the objective and the evidence it was met.',
                items: {
                  type: 'object',
                  properties: {
                    criterion: { type: 'string', description: 'One requirement derived from the objective.' },
                    evidence: {
                      type: 'array',
                      description: 'What shows this requirement was met: a command and its output, a file and what it contains, an observed behaviour.',
                      items: { type: 'string' },
                    },
                  },
                  required: ['criterion', 'evidence'],
                },
              },
              checks: {
                type: 'array',
                description: 'Commands you actually ran, with the exit code each returned. Compared against the event stream.',
                items: {
                  type: 'object',
                  properties: {
                    command: { type: 'string', description: 'The command as you ran it.' },
                    result: { type: 'string', enum: ['passed', 'failed', 'not-run'] },
                    exitCode: { type: 'integer', description: 'Exit code the command returned, if you have it.' },
                    explanation: { type: 'string', description: 'Why a not-run or failed check is not a blocker.' },
                  },
                  required: ['result'],
                },
              },
            },
            required: ['summary', 'criteria'],
          },
          blocked_reason: {
            type: 'string',
            description: 'Concrete blocking condition; required with action blocked.',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      async execute(rawArgs: unknown) {
        const args = (rawArgs ?? {}) as RawArgs
        const action = requireString(args, 'action')
        if (!(UPDATE_ACTIONS as readonly string[]).includes(action)) {
          throw new GoalError('GOAL_INVALID_EDIT', `unknown action ${action}`)
        }
        // Resolve the goal here, at the moment of the mutation. The model used to
        // have to read get_goal, copy two fields into this call, and be rejected
        // on a typo — a whole failure class that bought nothing, because the
        // compare-and-set the ref feeds is exactly as strong when the server
        // reads the current one. Reading it later is also fresher than the model
        // reading it at the start of its turn.
        const goalStore = store()
        const goal = goalStore.current
        if (goal === undefined) {
          throw new GoalError('GOAL_NOT_FOUND', 'no goal in this project; call create_goal first')
        }
        const ref: GoalRef = { id: goal.id, revision: goal.revision }
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
            // A claim with no criteria is refused rather than recorded: an
            // objective nobody checked against is not an achieved objective.
            const claim = validateCompletionClaim(args.claim)
            // The contradiction check the free-text summary used to get, kept in
            // the one place it can still be made — on the summary the model wrote
            // in its own words.
            if (/not complete|still fail/i.test(claim.summary)) {
              throw new GoalError('GOAL_INVALID_CLAIM', 'completion summary contradicts completion')
            }
            // Cross-check the claim against what actually ran, rather than
            // trusting it. The tool-success events carry the exit code of a
            // command that ran; a claim that says it ran a command with a
            // different exit code, or that ran nothing at all, disagrees with the
            // event stream, and the disagreement is returned where it can be seen.
            const ran = ranCommands(root)
            const crossCheck: Array<CompletionCheck & { agrees: boolean | null; ranNothing: boolean }> = claim.checks.map(
              (check) => {
              const claimed = check.exitCode
              const observed = claimed !== undefined && ran.includes(claimed)
              const ranNothing = ran.length === 0
                return {
                  ...check,
                  agrees: claimed === undefined ? null : observed,
                  ranNothing,
                }
              },
            )
            const completed = goalStore.complete(ref, claim)
            return {
              content: JSON.stringify({
                goal: goalField(completed),
                crossCheck,
                ...ran.length === 0
                  ? {
                      warning:
                        'No command is recorded as having run in this goal, so every claimed exit code is unchecked. Record the commands you ran, or mark their result not-run with an explanation.',
                    }
                  : {},
              }),
            }
          }
          case 'blocked': {
            const blockedReason = optionalString(args, 'blocked_reason')
            if (blockedReason === undefined || blockedReason.trim().length === 0) {
              throw new GoalError('GOAL_INVALID_EDIT', 'blocked requires a concrete blocked_reason')
            }
            // A reported impasse is the model's own claim about a situation it
            // may be wrong about, so it is challenged rather than obeyed: the
            // same impasse must persist three consecutive rounds before the goal
            // stops. The prompt already asks for that; this is what enforces it.
            const reason = { code: 'model-reported' as const, message: blockedReason.trim() }
            const goalStore = store()
            goalStore.noteJudgment(reason.message)
            const gated = gateBlock(goalStore, reason)
            if (gated === undefined) {
              // recorded, not accepted. The model keeps working this round; the
              // next report of the same impasse is what decides.
              return {
                content: JSON.stringify({
                  status: 'recorded',
                  consecutiveRounds: goalStore.judgmentRounds(),
                  requiredRounds: JUDGMENT_ROUNDS,
                  note:
                    'Impasse recorded. It has not persisted long enough to stop the goal — keep working on the objective and report the same impasse again only if it is still true.',
                }),
              }
            }
            return { content: JSON.stringify(goalValue(goalStore.block(ref, gated))) }
          }
          default:
            throw new GoalError('GOAL_INVALID_EDIT', `unknown action ${action}`)
        }
      },
    },

    {
      name: 'goal_wait',
      description:
        'Wait for an external event (e.g. a monitor, review, or CI run). Suppresses automatic continuation until a human sends a message in this project, or until resume_after_ms elapses. The deadline is required: when it passes with nothing having arrived, the goal is stopped rather than resumed. Use only after arranging an external wake source.',
      options: DIRECT_TOOL_OPTIONS,
      input: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why the goal is waiting (1-1000 chars).' },
          resume_after_ms: {
            type: 'integer',
            description: 'Required deadline in ms (clamped to at least 10s). When it passes with nothing arriving, the goal is stopped.',
          },
        },
        required: ['reason', 'resume_after_ms'],
        additionalProperties: false,
      },
      async execute(rawArgs: unknown) {
        const args = (rawArgs ?? {}) as RawArgs
        // The deadline is required, not optional-with-a-default: an unbounded wait
        // is a goal nobody hears from again, and the tool cannot express one.
        const deadline = requireNumber(args, 'resume_after_ms')
        if (!Number.isFinite(deadline) || deadline <= 0) {
          throw new GoalError('GOAL_INVALID_EDIT', 'resume_after_ms is required and must be a positive number of milliseconds')
        }
        // Resolved here, like every other mutation: the model quotes no ref.
        const goal = store().current
        if (goal === undefined) {
          throw new GoalError('GOAL_NOT_FOUND', 'no goal in this project; call create_goal first')
        }
        return {
          content: JSON.stringify(
            goalValue(store().wait({ id: goal.id, revision: goal.revision }, requireString(args, 'reason'), deadline)),
          ),
        }
      },
    },
  ]
}
