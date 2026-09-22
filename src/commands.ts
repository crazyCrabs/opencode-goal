/**
 * Human-facing `/goal` command over the persisted per-project goal domain.
 *
 * The command plane lives in the TUI plugin (see `tui.ts`): the user's input is
 * parsed and executed here against the durable log, and the returned text is
 * rendered directly in the UI. No prompt parts are injected, so no model turn
 * is spent on goal control.
 */

import type { GoalStore } from './state.ts'
import { GoalError, type GoalRef, type GoalView } from './types.ts'

const USAGE = 'Usage: /goal [<objective>|status|edit <objective>|pause|resume|clear] | /goal --tokens <n> <objective> | /goal --rounds <n> <objective>'

/** One parsed `/goal` invocation; every non-control input is a create objective. */
export interface ParsedGoalCommand {
  kind: 'show' | 'create' | 'edit' | 'pause' | 'resume' | 'clear' | 'invalid'
  objective?: string
  maxGoalRounds?: number
  tokenBudget?: number
}

/** Outcome of one executed `/goal` command. */
export interface GoalCommandOutcome {
  /** False when the command was rejected (usage error, state conflict, domain error). */
  readonly ok: boolean
  /** Direct UI output; it never enters a model request. */
  readonly text: string
}

/** Parse only the grammar owned by `/goal`; arbitrary other input is an objective. */
export function parseGoalCommand(rawInput: string): ParsedGoalCommand {
  const input = rawInput.trim()
  if (input.length === 0) return { kind: 'show' }
  const control = input.toLowerCase()
  if (control === 'status' || control === 'show') return { kind: 'show' }
  if (control === 'pause') return { kind: 'pause' }
  if (control === 'resume') return { kind: 'resume' }
  if (control === 'clear') return { kind: 'clear' }
  if (control === 'edit') return { kind: 'invalid' }
  if (/^edit(?=\s)/iu.test(input)) {
    const objective = input.slice(4).trim()
    if (objective.length === 0) return { kind: 'invalid' }
    return { kind: 'edit', objective }
  }

  // flags: --tokens <n> and --rounds <n> before the objective
  let rest = input
  let tokenBudget: number | undefined
  let maxGoalRounds: number | undefined
  const tokenMatch = /^--tokens\s+([0-9]+(?:\.[0-9]+)?[km]?)\s+/i.exec(rest)
  if (tokenMatch !== null) {
    tokenBudget = parseBudget(tokenMatch[1])
    if (tokenBudget === undefined) return { kind: 'invalid' }
    rest = rest.slice(tokenMatch[0].length)
  } else if (/^--tokens(?=\s)/i.test(rest)) {
    return { kind: 'invalid' }
  }
  const roundMatch = /^--rounds\s+([0-9]+)\s+/i.exec(rest)
  if (roundMatch !== null) {
    maxGoalRounds = Number(roundMatch[1])
    if (!Number.isSafeInteger(maxGoalRounds) || maxGoalRounds < 1) return { kind: 'invalid' }
    rest = rest.slice(roundMatch[0].length)
  } else if (/^--rounds(?=\s)/i.test(rest)) {
    return { kind: 'invalid' }
  }
  const objective = rest.trim()
  if (objective.length === 0) return { kind: 'invalid' }
  return { kind: 'create', objective, maxGoalRounds, tokenBudget }
}

/** Parse 300000 / 300k / 1.5m style budgets. */
function parseBudget(raw: string): number | undefined {
  const match = /^([0-9]+(?:\.[0-9]+)?)([km]?)$/i.exec(raw)
  if (match === null) return undefined
  const value = Number(match[1])
  const suffix = match[2].toLowerCase()
  const scaled = suffix === 'k' ? value * 1000 : suffix === 'm' ? value * 1_000_000 : value
  if (!Number.isSafeInteger(scaled) || scaled < 1) return undefined
  return scaled
}

/** Human label for one durable goal phase. */
function phaseLabel(phase: GoalView['phase']): string {
  return phase
}

/** Render direct UI output without exposing compare-and-set internals. */
function renderGoal(title: string, goal: GoalView): string {
  const blocker = goal.phase === 'blocked' && goal.blockedReason !== undefined
    ? [`Blocker: ${goal.blockedReason.code}: ${goal.blockedReason.message}`]
    : []
  const budget = goal.tokenBudget > 0
    ? `Budget: ${goal.usage.inputTokens + goal.usage.outputTokens}/${goal.tokenBudget} tokens`
    : 'Budget: unlimited'
  const wait = goal.waitUntil > 0 ? [`Waiting: ${goal.waitReason ?? 'external event'} until ${new Date(goal.waitUntil).toISOString()}`] : []
  return [
    title,
    `Status: ${phaseLabel(goal.phase)} (activation: ${goal.activation})`,
    ...blocker,
    ...wait,
    `Objective: ${goal.objective}`,
    `Rounds: ${goal.roundsStarted}/${goal.maxGoalRounds}`,
    budget,
    `Usage: ${goal.usage.inputTokens} in / ${goal.usage.outputTokens} out, cost $${goal.usage.cost.toFixed(4)}`,
    '',
    'Commands: /goal status | /goal edit <objective> | /goal pause | /goal resume | /goal clear',
  ].join('\n')
}

/** Exact current compare-and-set ref. */
function goalRef(goal: GoalView): GoalRef {
  return { id: goal.id, revision: goal.revision }
}

/**
 * Execute one parsed human command through the domain that owns persistence.
 * Domain rejections become direct `ok: false` outcomes instead of throwing, so
 * the UI can render them as plain text.
 */
export function executeGoalCommand(store: GoalStore, command: ParsedGoalCommand): GoalCommandOutcome {
  const current = store.view()
  const fail = (text: string): GoalCommandOutcome => ({ ok: false, text })
  const ok = (text: string): GoalCommandOutcome => ({ ok: true, text })
  try {
    switch (command.kind) {
      case 'show':
        return current === undefined
          ? ok(`No goal is currently set.\n${USAGE}`)
          : ok(renderGoal('Goal', current))
      case 'invalid':
        return fail(`Invalid /goal command.\n${USAGE}`)
      case 'create': {
        const objective = command.objective!
        if (current !== undefined && current.phase !== 'complete') {
          return fail(`A goal is already ${phaseLabel(current.phase)}. Use /goal edit <objective> to change it or /goal clear before replacing it.`)
        }
        const view = store.create(objective, command.maxGoalRounds ?? 25, command.tokenBudget ?? 0)
        return ok(renderGoal('Goal created (armed, autonomous continuation enabled)', view))
      }
      case 'edit': {
        if (current === undefined) return fail(`No goal is currently set; /goal edit requires one.\n${USAGE}`)
        const view = store.edit(goalRef(current), command.objective, undefined)
        return ok(renderGoal('Goal updated', view))
      }
      case 'pause': {
        if (current === undefined) return fail(`No goal is currently set; /goal pause requires one.\n${USAGE}`)
        return ok(renderGoal('Goal paused', store.pause(goalRef(current))))
      }
      case 'resume': {
        if (current === undefined) return fail(`No goal is currently set; /goal resume requires one.\n${USAGE}`)
        return ok(renderGoal('Goal resumed (armed)', store.resume(goalRef(current))))
      }
      case 'clear': {
        if (current === undefined) return ok('No goal to clear.')
        store.clear(goalRef(current))
        return ok('Goal cleared.')
      }
    }
  } catch (error) {
    if (error instanceof GoalError) return fail(error.message)
    throw error
  }
}