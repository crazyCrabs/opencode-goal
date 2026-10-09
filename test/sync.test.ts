/**
 * The follow-up ticket 26 recorded and ticket 27 made urgent: `sync()` compared
 * only the goal's identity, so a foreign usage delta and a foreign lease were
 * both invisible to a process until a snapshot mutation happened to land.
 *
 * The usage half is a stale number. The lease half is worse — a process admitting
 * a round another process's lease already covered, which is the defect ADR 0005
 * exists to close, arriving back through the read path.
 */
import { describe, expect, test, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, appendFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GoalStore } from '../src/state.ts'

const cleanup: string[] = []
afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true })
})

/** A worktree with a goal log, and a store folded from it. */
function worktree(): { directory: string; store: GoalStore; logPath: string } {
  const directory = mkdtempSync(join(tmpdir(), 'sync-'))
  cleanup.push(directory)
  const logPath = join(directory, '.opencode', 'goal-log.jsonl')
  const store = new GoalStore(directory)
  return { directory, store, logPath }
}

function create(store: GoalStore): { id: string; revision: number } {
  const goal = store.create('do a thing', 25, 0)
  return { id: goal.id, revision: goal.revision }
}

/** Append a line the way another process would. */
function appendRaw(logPath: string, line: Record<string, unknown>): void {
  appendFileSync(logPath, `${JSON.stringify(line)}\n`)
}

describe('a process notices another process\'s coordinates', () => {
  test('a foreign usage delta is visible without a snapshot mutation', () => {
    const { store, logPath } = worktree()
    const ref = create(store)
    expect(store.view()?.usage.inputTokens).toBe(0)

    // another process folds a step and appends the delta (ADR 0002's shape)
    appendRaw(logPath, {
      kind: 'goal/change',
      version: 1,
      operation: 'usage',
      ref,
      delta: { inputTokens: 4096, outputTokens: 128 },
      at: Date.now(),
    })

    // the read re-folds; it must see the delta
    store.sync()
    expect(store.view()?.usage.inputTokens).toBe(4096)
    expect(store.view()?.usage.outputTokens).toBe(128)
  })

  test('a foreign usage delta does not disarm an armed store', () => {
    const { store, logPath } = worktree()
    const ref = create(store)
    // the store that created the goal is armed
    expect(store.activation).toBe('armed')

    appendRaw(logPath, {
      kind: 'goal/change',
      version: 1,
      operation: 'usage',
      ref,
      delta: { inputTokens: 1024 },
      at: Date.now(),
    })
    store.sync()

    // a usage delta is a coordinate, not a state verb: it must not read as
    // "not mutated while alive" and switch the store off
    expect(store.activation).toBe('armed')
  })

  test('a foreign lease is visible without a snapshot mutation', () => {
    const { store, logPath } = worktree()
    const ref = create(store)

    // another process claims the round
    appendRaw(logPath, {
      kind: 'goal/lease',
      version: 1,
      id: ref.id,
      holder: 'some-other-process',
      at: Date.now(),
      expiresAt: Date.now() + 60_000,
    })

    store.sync()
    const lease = store.lease
    expect(lease?.holder).toBe('some-other-process')
  })

  test('an expired foreign lease stops being visible', () => {
    const { store, logPath } = worktree()
    const ref = create(store)

    appendRaw(logPath, {
      kind: 'goal/lease',
      version: 1,
      id: ref.id,
      holder: 'a-process-that-died',
      at: Date.now() - 120_000,
      expiresAt: Date.now() - 60_000,
    })
    store.sync()

    // the crash story of ADR 0005: a dead holder releases its round by doing
    // nothing, and that has to survive a read
    expect(store.lease).toBeUndefined()
  })

  test('a lease naming another goal is not this goal\'s lease', () => {
    const { store, logPath } = worktree()
    const ref = create(store)

    appendRaw(logPath, {
      kind: 'goal/lease',
      version: 1,
      id: 'some-other-goal',
      holder: 'some-other-process',
      at: Date.now(),
      expiresAt: Date.now() + 60_000,
    })
    store.sync()

    expect(store.lease).toBeUndefined()
  })

  test('an unchanged log still short-circuits, so a read stays cheap', () => {
    const { store } = worktree()
    create(store)
    // nothing appended: a second fold must not re-run the state-verb path. This is
    // the property the early return exists for, and the fix must not have spent it.
    const before = store.view()
    store.sync()
    expect(store.view()).toEqual(before)
    expect(store.activation).toBe('armed')
  })

  test('a real state verb still resets the no-progress history and re-arms', () => {
    const { store } = worktree()
    create(store)
    // pause through this store, which is a state verb
    store.pause({ id: store.view()!.id, revision: store.view()!.revision }, 'later')
    expect(store.activation).toBe('disarmed')
    expect(store.view()?.phase).toBe('paused')
  })

  test('the log on disk is exactly what a fold of it reads back', () => {
    const { store, logPath } = worktree()
    const ref = create(store)
    appendRaw(logPath, {
      kind: 'goal/change',
      version: 1,
      operation: 'usage',
      ref,
      delta: { inputTokens: 7 },
      at: Date.now(),
    })
    store.sync()
    // the appended line is still a plain line, not rewritten
    const lines = readFileSync(logPath, 'utf8').split('\n').filter(l => l.trim().length > 0)
    expect(lines.length).toBe(2)
    expect(JSON.parse(lines[1]).operation).toBe('usage')
  })
})
