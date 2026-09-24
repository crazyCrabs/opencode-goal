/**
 * mk-goal — create a durable goal in a project directory using the real code.
 *
 * Why this exists: the `/goal` slash command lives in the TUI half, so a
 * headless run cannot create a goal. This drives the same `GoalStore` the
 * server plugin drives, so the goal on disk is indistinguishable from one the
 * TUI created.
 *
 *   bun scripts/mk-goal.ts <projectDir> <objective> [maxRounds] [tokenBudget]
 */
import { GoalStore } from '../src/state.ts'

const [projectDir, objective, roundsArg, budgetArg] = process.argv.slice(2)
if (!projectDir || !objective) {
  console.error('usage: bun scripts/mk-goal.ts <projectDir> <objective> [maxRounds] [tokenBudget]')
  process.exit(1)
}
const maxTurns = roundsArg === undefined ? GoalStore.DEFAULT_MAX_GOAL_ROUNDS : Number(roundsArg)
const tokenBudget = budgetArg === undefined ? 0 : Number(budgetArg)
const store = new GoalStore(projectDir)
const created = store.create(objective, maxTurns, tokenBudget)
console.log(
  JSON.stringify(
    { id: created.id, revision: created.revision, phase: created.phase, maxTurns, tokenBudget, objective: created.objective, activation: created.activation },
    null,
    2,
  ),
)
console.log('goal id:', created.id)
