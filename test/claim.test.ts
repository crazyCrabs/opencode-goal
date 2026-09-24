import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { goalTools, type GoalTool } from '../src/tools.ts'
import { GoalStore } from '../src/state.ts'
import { GoalError } from '../src/types.ts'

/** A tool call, as the server forwards raw model JSON. */
async function call(tool: GoalTool, args: Record<string, unknown>): Promise<Record<string, never>> {
  return JSON.parse((await tool.execute(args, {} as never)).content as string) as Record<string, never>
}

function tools(): GoalTool[] {
  return [...goalTools(mkdtempSync(join(tmpdir(), 'goal-claim-')), dir => new GoalStore(dir))]
}

const CLAIM = {
  summary: 'the parser handles escaped separators',
  criteria: [{ criterion: 'escaped separators do not split a field', evidence: ['bun test passed: 41 tests'] }],
  checks: [{ command: 'bun test', result: 'passed', exitCode: 0 }],
}

describe('the model quotes no ref', () => {
  test('no tool schema asks for a goal_id or a revision', () => {
    // This is the whole failure class, asserted at its source: "call get_goal
    // first, copy two fields, be rejected on a typo". If no schema asks for them,
    // no model can fail to echo them.
    for (const tool of tools()) {
      const schema = tool.input as { properties?: Record<string, unknown>; required?: readonly string[] }
      expect(Object.keys(schema.properties ?? {})).not.toContain('goal_id')
      expect(Object.keys(schema.properties ?? {})).not.toContain('revision')
      expect(schema.required ?? []).not.toContain('goal_id')
      expect(schema.required ?? []).not.toContain('revision')
    }
  })

  test('no tool description tells the model to quote one either', () => {
    for (const tool of tools()) {
      expect(tool.description.toLowerCase()).not.toContain('goal_id')
      expect(tool.description.toLowerCase()).not.toContain('returned by get_goal')
    }
  })

  test('the tool bundle stays at four', () => {
    // Splitting complete and blocked into their own tools was considered and not
    // done: once the ref is gone the action already names the operation once.
    expect(tools().map(tool => tool.name)).toEqual(['get_goal', 'create_goal', 'update_goal', 'goal_wait'])
  })

  test('every mutation resolves the goal itself, so a typo cannot reject it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-claim-resolve-'))
    try {
      const bundle = goalTools(directory, dir => new GoalStore(dir))
      const create = bundle.find(tool => tool.name === 'create_goal')!
      const update = bundle.find(tool => tool.name === 'update_goal')!
      const wait = bundle.find(tool => tool.name === 'goal_wait')!
      const get = bundle.find(tool => tool.name === 'get_goal')!
      await call(create, { objective: 'resolve objective' })

      // no id, no revision, and nothing is rejected
      const paused = await call(update, { action: 'pause' })
      expect(paused.goal.phase).toBe('paused')
      const resumed = await call(update, { action: 'resume' })
      expect(resumed.goal.phase).toBe('active')
      const waiting = await call(wait, { reason: 'waiting for CI', resume_after_ms: 60_000 })
      expect(waiting.waitUntil).toBeGreaterThan(Date.now())

      // and the mutations landed on the goal the project actually has
      const read = await call(get, {})
      expect(read.goal.objective).toBe('resolve objective')
      expect(read.goal.roundsStarted).toBe(0)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a mutation with no goal behind it says so, rather than throwing a ref error', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-claim-nogoal-'))
    try {
      const bundle = goalTools(directory, dir => new GoalStore(dir))
      const update = bundle.find(tool => tool.name === 'update_goal')!
      await expect(call(update, { action: 'pause' })).rejects.toThrow(GoalError)
      const wait = bundle.find(tool => tool.name === 'goal_wait')!
      await expect(call(wait, { reason: 'waiting', resume_after_ms: 60_000 })).rejects.toThrow(GoalError)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('a completion claim is structured', () => {
  test('a claim with no criteria is rejected', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-claim-nocriteria-'))
    try {
      const bundle = goalTools(directory, dir => new GoalStore(dir))
      await call(bundle.find(tool => tool.name === 'create_goal')!, { objective: 'claim objective' })
      const update = bundle.find(tool => tool.name === 'update_goal')!

      // no criteria at all
      await expect(call(update, { action: 'complete', claim: { summary: 'done' } })).rejects.toThrow(/criteria/)
      // an empty list
      await expect(
        call(update, { action: 'complete', claim: { summary: 'done', criteria: [] } }),
      ).rejects.toThrow(/at least one criterion/)
      // a criterion with no evidence
      await expect(
        call(update, {
          action: 'complete',
          claim: { summary: 'done', criteria: [{ criterion: 'the thing', evidence: [] }] },
        }),
      ).rejects.toThrow(/at least one piece of evidence/)
      // a criterion with nothing in it
      await expect(
        call(update, { action: 'complete', claim: { summary: 'done', criteria: [{ criterion: '', evidence: ['x'] }] } }),
      ).rejects.toThrow(/non-empty description/)

      // and the goal is untouched by each refusal
      const read = await call(bundle.find(tool => tool.name === 'get_goal')!, {})
      expect(read.goal.phase).toBe('active')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a claim with an unknown check result is rejected', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-claim-badresult-'))
    try {
      const bundle = goalTools(directory, dir => new GoalStore(dir))
      await call(bundle.find(tool => tool.name === 'create_goal')!, { objective: 'claim objective' })
      const update = bundle.find(tool => tool.name === 'update_goal')!
      await expect(
        call(update, {
          action: 'complete',
          claim: { ...CLAIM, checks: [{ command: 'bun test', result: 'green', exitCode: 0 }] },
        }),
      ).rejects.toThrow(/passed, failed or not-run/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a summary that contradicts completion is still rejected', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-claim-contradiction-'))
    try {
      const bundle = goalTools(directory, dir => new GoalStore(dir))
      await call(bundle.find(tool => tool.name === 'create_goal')!, { objective: 'claim objective' })
      const update = bundle.find(tool => tool.name === 'update_goal')!
      await expect(
        call(update, { action: 'complete', claim: { ...CLAIM, summary: 'the feature is not complete' } }),
      ).rejects.toThrow(/contradicts completion/)
      await expect(
        call(update, { action: 'complete', claim: { ...CLAIM, summary: 'two tests still fail' } }),
      ).rejects.toThrow(/contradicts completion/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a valid claim completes the goal and is recorded on it', async () => {
    // Auditable means the claim can still be read after the round that made it,
    // so it is written to the log rather than only reaching the tool result.
    const directory = mkdtempSync(join(tmpdir(), 'goal-claim-recorded-'))
    try {
      const bundle = goalTools(directory, dir => new GoalStore(dir))
      await call(bundle.find(tool => tool.name === 'create_goal')!, { objective: 'claim objective' })
      const update = bundle.find(tool => tool.name === 'update_goal')!
      const done = await call(update, { action: 'complete', claim: CLAIM })
      expect(done.goal.phase).toBe('complete')
      expect(done.goal.completion).toEqual(CLAIM)

      // and a fresh process reads the same claim
      const restarted = new GoalStore(directory)
      expect(restarted.view()!.phase).toBe('complete')
      expect(restarted.view()!.completion).toEqual(CLAIM)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('the model still owns pause, resume, edit and wait', async () => {
    // Restricting the model to complete-and-impasse was considered and is
    // explicitly not done here: those verbs are the model's own lifecycle.
    const directory = mkdtempSync(join(tmpdir(), 'goal-claim-verbs-'))
    try {
      const bundle = goalTools(directory, dir => new GoalStore(dir))
      await call(bundle.find(tool => tool.name === 'create_goal')!, { objective: 'verbs objective' })
      const update = bundle.find(tool => tool.name === 'update_goal')!
      const wait = bundle.find(tool => tool.name === 'goal_wait')!

      expect((await call(update, { action: 'edit', objective: 'a different objective', max_goal_rounds: 40 })).goal.objective)
        .toBe('a different objective')
      expect((await call(update, { action: 'pause' })).goal.phase).toBe('paused')
      expect((await call(update, { action: 'resume' })).goal.phase).toBe('active')
      expect((await call(wait, { reason: 'waiting for CI', resume_after_ms: 60_000 })).waitUntil)
        .toBeGreaterThan(Date.now())
      // and a report that has not persisted three rounds is recorded, not obeyed
      const reported = await call(update, { action: 'blocked', blocked_reason: 'waiting on a human decision' })
      expect(reported.status).toBe('recorded')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('a claimed exit code is cross-checked, not trusted', () => {
  test('a claim agreeing with the commands that actually ran is reported as agreeing', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-claim-agree-'))
    // what actually ran, as the tool-success events reported it
    const ran: number[] = [0, 0, 0]
    try {
      const bundle = goalTools(directory, dir => new GoalStore(dir), () => ran)
      await call(bundle.find(tool => tool.name === 'create_goal')!, { objective: 'cross objective' })
      const done = await call(bundle.find(tool => tool.name === 'update_goal')!, { action: 'complete', claim: CLAIM })
      expect(done.goal.phase).toBe('complete')
      expect(done.crossCheck[0]).toEqual({
        command: 'bun test',
        result: 'passed',
        exitCode: 0,
        agrees: true,
        ranNothing: false,
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a claimed exit code nothing ran is visible as a disagreement', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-claim-disagree-'))
    try {
      // a goal whose event record shows only a different command ran
      const bundle = goalTools(directory, dir => new GoalStore(dir), () => [1])
      await call(bundle.find(tool => tool.name === 'create_goal')!, { objective: 'cross objective' })
      const done = await call(bundle.find(tool => tool.name === 'update_goal')!, { action: 'complete', claim: CLAIM })
      expect(done.crossCheck[0].agrees).toBe(false)
      expect(done.crossCheck[0].ranNothing).toBe(false)
      expect(done.warning).toBeUndefined()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a claim about a goal where nothing ran says so', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goal-claim-nothingran-'))
    try {
      const bundle = goalTools(directory, dir => new GoalStore(dir), () => [])
      await call(bundle.find(tool => tool.name === 'create_goal')!, { objective: 'cross objective' })
      const done = await call(bundle.find(tool => tool.name === 'update_goal')!, { action: 'complete', claim: CLAIM })
      expect(done.crossCheck[0].ranNothing).toBe(true)
      expect(done.warning).toContain('No command is recorded as having run')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a check with no exit code is neither agreed nor disagreed', async () => {
    // `not-run` and a claim without an exit code are not claims the event stream
    // can contradict, so they are not reported as if they were.
    const directory = mkdtempSync(join(tmpdir(), 'goal-claim-noexit-'))
    try {
      const bundle = goalTools(directory, dir => new GoalStore(dir), () => [])
      await call(bundle.find(tool => tool.name === 'create_goal')!, { objective: 'cross objective' })
      const done = await call(bundle.find(tool => tool.name === 'update_goal')!, {
        action: 'complete',
        claim: { ...CLAIM, checks: [{ command: 'manual review', result: 'not-run', explanation: 'a human must look at it' }] },
      })
      expect(done.crossCheck[0].agrees).toBeNull()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('the marker-in-prose alternative', () => {
  test('is not implemented, and the schema shows why it was rejected', () => {
    // Its own authors call the marker approach fragile and model-dependent: a
    // model that phrases its summary differently breaks the marker, and then the
    // claim is silently unparseable. A structured field cannot be mis-parsed
    // into nothing — it is either absent, which is an error, or present.
    //
    // What this asserts is that `summary` is the only free-text field and that
    // everything comparable is structured beside it.
    const bundle = tools()
    const schema = bundle.find(tool => tool.name === 'update_goal')!.input as {
      properties: Record<string, unknown>
    }
    expect(Object.keys(schema.properties)).toEqual(['action', 'objective', 'max_goal_rounds', 'claim', 'blocked_reason'])
    const claim = schema.properties.claim as { properties: Record<string, unknown> }
    expect(Object.keys(claim.properties)).toEqual(['summary', 'criteria', 'checks'])
  })
})
