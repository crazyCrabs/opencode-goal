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
 * The driver runs on three events: `session.execution.succeeded|failed|
 * interrupted` continues the goal after each finished turn — opencode 2.x
 * publishes no `session.idle` when a turn ends, so the execution events are
 * the only reliable completion signal — and, on the same event, a finished turn
 * the goal did not submit itself re-arms a goal that predates this process. That
 * second job exists because `session.created` is the only other adoption
 * trigger and fires once per session at creation, so it structurally cannot see
 * a session that already existed: every session in `opencode run --standalone`
 * (four live runs, zero events) and every session left open across a restart.
 * `session.created` adopts an active goal into a newly opened session (the
 * human's go-ahead, replacing a manual resume), and `session.deleted` forgets
 * the session. The legacy `session.idle` is still honored while no round is in
 * flight. One more event carries no round but ends a wait:
 * `session.inbox.enqueued` is the wake source an external wait is told to
 * arrange, and it resolves its directory through the same resolver as everything
 * else because the live server sends it with no location at all.
 *
 * Usage accounting runs on four more: `session.step.ended` folds the step's
 * token and cost delta, `session.text.ended` buffers the assistant text the
 * no-progress guard reads, and `session.tool.called`/`session.tool.success`
 * reset that guard because the goal acted. All four are durable and all four
 * carry a location; `session.usage.updated` is deliberately not among them
 * because it is ephemeral and carries no location, and folding it into a
 * durable counter under-counts after a restart.
 *
 * Events carry no project directory on the execution family, and a server
 * loads this plugin once per location, so every instance sees every project's
 * events: each event is therefore resolved to its session's directory (from
 * the `session.created` payload, else `session.get`) and driven only when that
 * directory belongs to this instance's root.
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
import { GoalAccounting } from './accounting.ts'
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

    /**
     * Session directory per session ID, learned from `session.created`: the
     * execution events carry no location, and the session's directory decides
     * which project's goal (and plugin instance) owns its turns.
     */
    const sessionDirectories = new Map<string, string>()
    /** Subagent/child sessions (they carry a parentID) never run goal rounds. */
    const childSessions = new Set<string>()

    /** Normalize a path for comparison: Windows accepts both separators. */
    const normalizePath = (value: string): string => value.replace(/\//g, '\\').toLowerCase()

    /** Whether one directory belongs to this plugin instance's project root. */
    const ownsDirectory = (directory: string): boolean => {
      const rootPath = normalizePath(root)
      const dir = normalizePath(directory)
      return dir === rootPath || dir.startsWith(`${rootPath}\\`)
    }

    /**
     * The session events that carry NO location, enumerated in one place because
     * the answer is not obvious and has to be right. Verified against four live
     * recordings: every other event in the `session.*` family carries one.
     *
     * `session.execution.interrupted` is in this set by family rather than by
     * observation — it never appeared in a recording, but its three siblings all
     * carry no location, and treating it as the exception would be the guess.
     */
    const LOCATION_LESS_EVENTS: ReadonlySet<string> = new Set([
      'session.execution.started',
      'session.execution.succeeded',
      'session.execution.failed',
      'session.execution.interrupted',
      'session.usage.updated',
    ])

    /**
     * Remember one session's project directory and whether it is a subagent
     * session, so later location-less events can be attributed correctly.
     */
    const rememberSession = (sessionID: string, directory: string | undefined, parentID: unknown): void => {
      if (directory !== undefined && directory.length > 0) sessionDirectories.set(sessionID, directory)
      if (typeof parentID === 'string' && parentID.length > 0) childSessions.add(sessionID)
    }

    /**
     * Resolve the directory a session's turn belongs to, or undefined when it
     * belongs to another project (another plugin instance drives it there) or
     * is a subagent session.
     *
     * The directory comes from the map, which `session.created` and
     * `session.step.started` fill from their locations — step-started fires at the
     * start of every step and always precedes the completion event of the same
     * session, so a location-less completion event never needs a lookup to be
     * attributed. No per-turn API call is made.
     *
     * The lookup remains for exactly one job no event can do: telling a subagent
     * session from a root one, for a session this process never saw created
     * (one whose turn was already running when this process came alive). It also
     * happens to return the directory, which is remembered.
     */
    const resolveTurnSession = async (
      sessionID: string,
      envelopeDirectory: string | undefined,
    ): Promise<string | undefined> => {
      if (childSessions.has(sessionID)) return undefined
      let directory = sessionDirectories.get(sessionID)
      if (directory === undefined) {
        try {
          // The session info carries the directory only under `location`. The
          // flat top-level shape this used to read first was verified absent in
          // four live recordings — `hasTopLevelDirectory: false` in every one —
          // so reading it was reading a field that never exists.
          const info = (await ctx.session.get({ sessionID })) as
            | { parentID?: string; location?: { directory?: string } }
            | undefined
          if (info === undefined) return undefined
          rememberSession(sessionID, info.location?.directory, info.parentID)
          if (childSessions.has(sessionID)) return undefined
          directory = info.location?.directory
        } catch {
          return undefined // a failed lookup is retried on the next event
        }
      }
      if (directory === undefined || directory.length === 0) directory = envelopeDirectory
      if (directory === undefined || !ownsDirectory(directory)) return undefined
      return directory
    }

    const driver = new GoalDriver({
      getStore,
      session: ctx.session,
      log,
    })
    driver.setDirectory(root)

    //
    // Usage accounting: its own module, folding the durable session events as
    // they arrive rather than reading the transcript at turn completion. The
    // fold runs before the turn-completion event the driver acts on, so a
    // guardrail checked at admission sees the usage the turn actually spent.
    //
    // It is built after the driver because it asks the driver which turns are the
    // goal's own, and the driver is the only writer that can answer: it is the
    // one that submitted the prompt that started the turn.
    //
    const accounting = new GoalAccounting({
      storeFor: getStore,
      isGoalTurn: sessionID => driver.isGoalTurn(sessionID),
    })

    // Materialize the root store now: a store that already exists observes later
    // external mutations (e.g. a `/goal` create from the TUI command plane) as
    // changes and arms the driver. A store created lazily after such a mutation
    // would treat the goal as pre-existing and stay disarmed.
    getStore(root)

    log('plugin initialized', { root })

    // Goal tools (`get_goal`, `create_goal`, `update_goal`, `goal_wait`).
    const tools = goalTools(root, getStore, directory => accounting.commandsFor(directory))
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
          'Keep working toward this objective across turns. Call get_goal to inspect it, update_goal(action="complete") with a structured claim when achieved, update_goal(action="blocked") for a true impasse, or goal_wait while waiting on external events. Mutations resolve the goal themselves, so you never quote an id or a revision.',
        ].join('\n'),
      })
    })

    // Continuation driver: one guarded round per finished turn while the goal
    // is active and armed — and one first round when a session is created,
    // because opening a session is the human's go-ahead to run the goal. The
    // event stream ends when the server shuts down.
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          //
          // The location-less set above is load-bearing in exactly one way: it is
          // checked against reality. An event the recordings said carries a
          // location arriving without one, or the reverse, means the server
          // changed shape, and the symptom would be a silent fall back to a
          // per-turn lookup rather than an error.
          //
          if (event.type.startsWith('session.')) {
            const carriesLocation = event.location !== undefined && event.location !== null
            if (LOCATION_LESS_EVENTS.has(event.type) === carriesLocation) {
              log('session event location shape differs from the recorded one', {
                type: event.type,
                carriesLocation,
                expectedLocationLess: LOCATION_LESS_EVENTS.has(event.type),
              })
            }
          }
          if (event.type === 'session.idle') {
            // legacy completion signal: honored only while no round is in
            // flight, because 2.x can emit it without any turn finishing
            const sessionID = event.data.sessionID
            if (sessionID === undefined) continue
            void (async () => {
              const directory = await resolveTurnSession(sessionID, event.location?.directory)
              if (directory !== undefined) await driver.onSessionIdle(sessionID, directory)
            })()
          } else if (event.type === 'session.created') {
            // opencode reports one creation per entry; `data` has been seen both
            // as a single payload and as a list, so normalize before driving
            const entries = Array.isArray(event.data) ? event.data : [event.data]
            for (const entry of entries) {
              const sessionID = entry.sessionID ?? entry.info?.id
              if (sessionID === undefined) continue
              const parentID = entry.parentID ?? entry.info?.parentID
              const directory = entry.location?.directory ?? entry.info?.directory ?? event.location?.directory ?? root
              rememberSession(sessionID, directory, parentID)
              if (childSessions.has(sessionID)) continue // a subagent session never runs goal rounds
              if (!ownsDirectory(directory)) continue // another instance owns that project
              void driver.onSessionCreated(sessionID, directory)
            }
          } else if (
            event.type === 'session.execution.succeeded' ||
            event.type === 'session.execution.failed' ||
            event.type === 'session.execution.interrupted'
          ) {
            // the only reliable turn-completion signal in opencode 2.x: this is
            // what keeps the autonomous loop advancing round after round
            const sessionID = event.data.sessionID
            if (sessionID === undefined) continue
            const reason = event.type === 'session.execution.interrupted' ? event.data.reason : undefined
            // a failed turn carries the provider's structured refusal
            // (`{ type, message, status? }`, declared by `@opencode/protocol` and
            // confirmed by a live 403), which is what stops the goal durably
            // rather than leaving it disarmed and silently quiet
            const error = event.type === 'session.execution.failed' ? event.data.error : undefined
            void (async () => {
              const directory = await resolveTurnSession(sessionID, event.location?.directory)
              if (directory === undefined) return
              // Both stall counters are decided here, before the driver's own
              // completion handler, so a guardrail checked at admission sees the
              // counters the turn that just ended actually produced.
              accounting.onTurnEnded(directory, sessionID, error !== undefined)
              // A goal that predates this process is disarmed, and `session.created`
              // cannot re-arm it for a session that already existed — the
              // `opencode run --standalone` and restart cases. A finished human turn
              // does, and it is the only signal that can: the plugin context cannot
              // enumerate sessions, so there is no poll that would ever find one.
              driver.adoptOnHumanTurn(sessionID, directory)
              await driver.onTurnFinished(sessionID, directory, reason, error, event.durable?.seq)
            })()
          } else if (event.type === 'session.step.started') {
            //
            // Learn the session's project directory here, from an event that
            // carries one. Step-started fires at the start of every step and
            // always precedes the completion event of the same session, so the
            // location-less completion events are attributed from the map
            // rather than from a per-turn lookup.
            //
            const sessionID = event.data.sessionID
            if (sessionID === undefined) continue
            const stepDirectory = event.location?.directory
            if (stepDirectory !== undefined && stepDirectory.length > 0) {
              // remember only the subagent question here: a step-started carries
              // no parentID, so this records the directory and leaves the
              // subagent answer to whatever already decided it
              sessionDirectories.set(sessionID, stepDirectory)
            }
          } else if (event.type === 'session.deleted') {
            const sessionID = event.data.sessionID
            if (sessionID === undefined) continue
            sessionDirectories.delete(sessionID)
            childSessions.delete(sessionID)
            driver.forget(sessionID)
            accounting.forget(sessionID)
          } else if (
            event.type === 'session.step.ended' ||
            event.type === 'session.text.ended' ||
            event.type === 'session.tool.called' ||
            event.type === 'session.tool.success'
          ) {
            //
            // The durable accounting events. Unlike the execution events these
            // all carry a location, so the directory needs no lookup; the
            // resolver is still used for what only it can answer, which is
            // whether the session is a subagent's and whether this instance
            // owns the directory.
            //
            const sessionID = event.data.sessionID
            if (sessionID === undefined) continue
            const directory = await resolveTurnSession(sessionID, event.location?.directory)
            if (directory === undefined) continue
            if (event.type === 'session.step.ended') {
              accounting.onStepEnded(directory, event.data, event.durable?.seq)
              // A step of a round this process holds keeps the lease alive. A
              // step of anything else — a human's turn, a subagent's — must not,
              // because the lease is this process's claim on the round and
              // nothing else may renew it.
              driver.renewLeaseFor(sessionID, directory)
            } else if (event.type === 'session.text.ended') {
              accounting.onTextEnded(directory, event.data)
            } else if (event.type === 'session.tool.success') {
              // A success is both a signal that the goal acted and, when its
              // metadata carries an `exit`, a command that actually ran — the
              // fact a completion claim is cross-checked against.
              accounting.onToolActivity(directory, sessionID)
              accounting.onToolSuccess(directory, event.data)
            } else {
              accounting.onToolActivity(directory, sessionID)
            }
          } else if (event.type === 'session.inbox.enqueued') {
            //
            // A human arriving ends an external wait. This is the wake source a
            // waiting goal was told to arrange, and it is the reason the wait can
            // be durable at all: the goal no longer has to be awake to hear it.
            //
            // Distinguishing a human's item from the goal's own continuation
            // prompt is free, in two independent ways. `item.type` is a tagged
            // union — `user`, `synthetic`, `compaction`, `move` — so a human is
            // named outright. And structurally, while a goal is waiting admission
            // is suppressed, so the plugin submits no continuation prompt, so no
            // goal-originated inbox item can arrive during a wait at all. Either
            // fact alone would do; the second is what makes the first redundant
            // rather than the other way round.
            //
            // The directory comes from the resolver rather than from the event.
            // Four recordings had a location on this event; the live v2 server
            // sends none, and the invariant check above reports the disagreement
            // every time. This branch is the one that hears the wake source, so
            // it must not be the one branch that requires a location — that is
            // what made the wake a no-op on the server it has to run on. The
            // resolver also answers the subagent and ownership questions this
            // branch used to answer by hand, which is why it now answers them the
            // way the step and execution branches already do.
            //
            const sessionID = event.data.sessionID
            if (sessionID === undefined) continue
            void (async () => {
              const directory = await resolveTurnSession(sessionID, event.location?.directory)
              if (directory === undefined) return
              const store = getStore(directory)
              const goal = store.view()
              if (goal === undefined || goal.waitUntil === 0) return
              // Arming here is what lets the arriving turn drive the next round:
              // the goal is active and armed, so when this human's own turn
              // finishes, admission admits a round rather than reporting
              // `disarmed`. A store that never mutated the goal stays disarmed, and
              // this event is that mutation.
              store.activation = 'armed'
              store.endWait({ id: goal.id, revision: goal.revision })
              log('goal wait ended by a human arriving', { goalID: goal.id, directory })
            })()
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
