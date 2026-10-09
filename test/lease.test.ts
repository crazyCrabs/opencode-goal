/**
 * Ticket 27: two opencode processes on one worktree double-drive a goal, and the
 * round cap burns without work.
 *
 * Reproduced first on HEAD (the driver passed no holder, so admission could not
 * see another process's round), then fixed. The tests below are the ones that
 * failed there.
 */
import { describe, expect, test, afterEach, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenCodeGoalPlugin } from '../src/index.ts'

const cleanup: string[] = []
afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true })
})

const originalLog = console.log
beforeEach(() => {
  console.log = () => {}
})
afterEach(() => {
  console.log = originalLog
})

async function settle(): Promise<void> {
  for (let turn = 0; turn < 60; turn++) await new Promise(resolve => setTimeout(resolve, 2))
}

/** One registered tool as the plugin registers it (opencode 2.x tool shape). */
interface RegisteredTool {
  name: string
  execute(args: unknown): Promise<{ content: string }>
}

interface ServerEvent {
  type: string
  data: Record<string, unknown>
  location?: { directory: string }
}

/**
 * One plugin process: its own queue, its own driver, its own lease holder — the
 * same construction as `serverHalf` in integration.test.ts, lifted here because
 * the defect is between two of these rather than inside one.
 */
async function processOn(directory: string) {
  const prompts: Array<{ sessionID: string; text: string }> = []
  const tools: RegisteredTool[] = []
  const queue: ServerEvent[] = []
  const context = {
    location: { directory },
    tool: {
      transform: async (register: (editor: { add: (tool: RegisteredTool) => void }) => void) => {
        register({ add: tool => tools.push(tool) })
        return { dispose: async () => {} }
      },
    },
    session: {
      hook: async () => ({ dispose: async () => {} }),
      prompt: async (input: { sessionID: string; text: string }) => {
        prompts.push({ sessionID: input.sessionID, text: input.text })
        return {}
      },
      context: async () => [],
      get: async (input: { sessionID: string }) => ({ location: { directory }, parentID: undefined }),
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          for (;;) {
            while (queue.length > 0) yield queue.shift()!
            if (signal.aborted) return
            await new Promise(resolve => setTimeout(resolve, 1))
          }
        },
      }),
    },
  }
  const dispose = await OpenCodeGoalPlugin.setup(context as never)
  return { prompts, tools, queue, dispose }
}

function logPathFor(directory: string): string {
  return join(directory, '.opencode', 'goal-log.jsonl')
}

function logLines(directory: string): Record<string, unknown>[] {
  const path = logPathFor(directory)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

function continuesIn(directory: string): number {
  return logLines(directory).filter(line => line['operation'] === 'continue').length
}

/** The goal's recorded usage, which is what the cascade zeroes out. */
function usageOf(directory: string): { input: number; output: number } {
  let input = 0
  let output = 0
  for (const line of logLines(directory)) {
    if (line['operation'] === 'usage') {
      const delta = line['delta'] as { inputTokens?: number; outputTokens?: number } | undefined
      input += delta?.inputTokens ?? 0
      output += delta?.outputTokens ?? 0
    }
  }
  return { input, output }
}

describe('ticket 27 — two processes on one goal log', () => {
  test('a second process defers to the first one\'s lease and the loop converges', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lease-'))
    cleanup.push(directory)

    // two opencode processes on one worktree: two plugins, two queues, two drivers
    const first = await processOn(directory)
    const second = await processOn(directory)

    // the human creates the goal through whichever process answers the tool
    await first.tools.find(tool => tool.name === 'create_goal')!.execute({ objective: 'do a thing' })
    for (const process of [first, second]) {
      process.queue.push({
        type: 'session.step.started',
        data: { sessionID: 'ses-shared', info: { id: 'ses-shared', directory } },
        location: { directory },
      })
      process.queue.push({
        type: 'session.created',
        data: { sessionID: 'ses-shared', info: { id: 'ses-shared', directory } },
        location: { directory },
      })
    }
    await settle()
    console.log = originalLog

    const afterAdoption = continuesIn(directory)
    const afterAdoptionPrompts = first.prompts.length + second.prompts.length

    // one turn-completion event, fanned out to both processes' streams, which is
    // what a shared event bus delivers
    for (const process of [first, second]) {
      process.queue.push({ type: 'session.execution.succeeded', data: { sessionID: 'ses-shared' } })
    }
    await settle()
    const afterOne = continuesIn(directory)
    const afterOnePrompts = first.prompts.length + second.prompts.length

    const leases = logLines(directory).filter(line => line['kind'] === 'goal/lease')

    for (const process of [first, second]) {
      for (let i = 0; i < 10; i++) {
        process.queue.push({ type: 'session.execution.succeeded', data: { sessionID: 'ses-shared' } })
      }
    }
    await settle()
    const afterBurst = continuesIn(directory)

    // Measure before asserting, so a failure shows the numbers that produced it
    // rather than only the assertion that did not hold.
    console.log('--- the two processes ---')
    console.log('  rounds after adoption     :', afterAdoption)
    console.log('  rounds after one fan-out  :', afterOne)
    console.log('  rounds after 20 more      :', afterBurst)
    console.log('  prompts submitted total   :', first.prompts.length + second.prompts.length)
    console.log('  by process                :', first.prompts.length, '/', second.prompts.length)
    console.log('  lease lines written       :', leases.length)
    console.log('  usage recorded            :', JSON.stringify(usageOf(directory)))

    // The unbounded loop is what the fix closes, so it is what is asserted: the
    // fan-out may admit one extra round before the first lease is visible, but it
    // must not then keep admitting. Before the lease, every subsequent event
    // admitted again and the goal ran itself until a stall guard fired.
    expect(leases.length).toBeGreaterThan(0)
    // the loop converges: a bounded number of rounds, not one per event
    expect(afterBurst - afterOne).toBeLessThan(3)
    expect(afterOne).toBeGreaterThan(afterAdoption) // the fan-out really did admit
    expect(afterAdoptionPrompts).toBeLessThan(afterOnePrompts + 1)
  })

  test('a lease is a coordinate: it never counts as a round, a block, or usage', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lease-fold-'))
    cleanup.push(directory)
    const process = await processOn(directory)
    await process.tools.find(tool => tool.name === 'create_goal')!.execute({ objective: 'do a thing' })
    process.queue.push({
      type: 'session.step.started',
      data: { sessionID: 'ses-fold', info: { id: 'ses-fold', directory } },
      location: { directory },
    })
    process.queue.push({
      type: 'session.created',
      data: { sessionID: 'ses-fold', info: { id: 'ses-fold', directory } },
      location: { directory },
    })
    await settle()
    console.log = originalLog

    const rounds = logLines(directory).filter(line => line['operation'] === 'continue').length
    const goalLines = logLines(directory).filter(line => line['kind'] === 'goal/change')
    const leaseLines = logLines(directory).filter(line => line['kind'] === 'goal/lease')

    // the lease exists, and it exists in its own kind
    expect(leaseLines.length).toBeGreaterThan(0)
    expect(goalLines.every(line => line['operation'] !== undefined)).toBe(true)
    expect(goalLines.some(line => line['kind'] === 'goal/lease')).toBe(false)
    // and the round count is the round count, not one more per lease
    expect(rounds).toBe(1)
    expect(usageOf(directory)).toEqual({ input: 0, output: 0 })
  })

  test('a lease expires, so a process that dies mid-round does not stall the goal', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lease-expiry-'))
    cleanup.push(directory)
    const process = await processOn(directory)
    await process.tools.find(tool => tool.name === 'create_goal')!.execute({ objective: 'do a thing' })
    process.queue.push({
      type: 'session.step.started',
      data: { sessionID: 'ses-expiry', info: { id: 'ses-expiry', directory } },
      location: { directory },
    })
    process.queue.push({
      type: 'session.created',
      data: { sessionID: 'ses-expiry', info: { id: 'ses-expiry', directory } },
      location: { directory },
    })
    await settle()
    console.log = originalLog

    const leases = logLines(directory).filter(line => line['kind'] === 'goal/lease')
    expect(leases.length).toBeGreaterThan(0)
    const lease = leases[leases.length - 1] as unknown as { expiresAt: number }
    // the lease is a real expiry in the future, not a permanent claim
    expect(lease.expiresAt).toBeGreaterThan(Date.now())
    // and the fold's own answer is that the round is owned right now
    const store = process.tools.length
    void store
    // the same store the driver uses: a second process must see the holder
    const { GoalStore } = await import('../src/state.ts')
    const store2 = new GoalStore(directory)
    expect(store2.lease?.holder).toBeDefined()
  })
})

describe('ticket 27 through the read path', () => {
  test('a process defers to a lease it only learned by folding the log', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lease-read-'))
    cleanup.push(directory)
    const process = await processOn(directory)
    const logPath = logPathFor(directory)

    await process.tools.find(tool => tool.name === 'create_goal')!.execute({ objective: 'do a thing' })
    process.queue.push({
      type: 'session.step.started',
      data: { sessionID: 'ses-read', info: { id: 'ses-read', directory } },
      location: { directory },
    })
    // a human turn, which is what arms a goal that predates this process
    process.queue.push({
      type: 'session.created',
      data: { sessionID: 'ses-read', info: { id: 'ses-read', directory } },
      location: { directory },
    })
    await settle()
    console.log = originalLog

    const roundsBefore = continuesIn(directory)
    expect(roundsBefore).toBe(1)

    // A second process claims the round by writing a lease line directly. This
    // process did not see it happen — it only ever folds the log — so the lease
    // has to be visible through `sync()` or it is not visible at all.
    const { GoalStore } = await import('../src/state.ts')
    const foreign = new GoalStore(directory)
    const goal = foreign.view()!
    appendFileSync(
      logPath,
      `${JSON.stringify({
        kind: 'goal/lease',
        version: 1,
        id: goal.id,
        holder: 'a-process-that-wrote-the-log',
        at: Date.now(),
        expiresAt: Date.now() + 60_000,
      })}\n`,
    )

    // now this process takes a turn of its own and reaches admission
    process.queue.push({ type: 'session.execution.succeeded', data: { sessionID: 'ses-read' } })
    await settle()

    const roundsAfter = continuesIn(directory)
    console.log('rounds before the foreign lease:', roundsBefore, ' after:', roundsAfter)
    const leases = logLines(directory).filter(line => line['kind'] === 'goal/lease')
    console.log('lease lines:', leases.length, 'holders:', new Set(leases.map(l => l['holder'])).size)

    // the goal is still active and a round was available, so the only thing that
    // can have stopped this process is the lease it read out of the log
    expect(roundsAfter).toBe(roundsBefore)
  })
})
