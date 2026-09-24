/**
 * Goal accounting: fold opencode 2.x's durable session events into a goal's
 * usage counters and its no-progress fingerprint.
 *
 * This module is transport-free and durable-event-only. It takes a directory
 * and a payload and answers; it never subscribes, never looks a session up, and
 * never reads a transcript. That is what lets it be tested against the exact
 * payloads a live server emits.
 *
 * Why the events it reads are the ones it reads:
 *
 * - `session.step.ended` is **durable** (the envelope carries a `durable`
 *   aggregate + sequence), carries the project directory, and carries the
 *   assistant message id beside the usage. Its `tokens` and `cost` are the
 *   step's **delta**, so the fold sums rather than diffs a cumulative.
 * - `session.text.ended` is durable and carries the assistant text per ordinal
 *   part, so the no-progress guard reads what was actually said without reading
 *   the transcript.
 * - `session.tool.called` is durable and is the signal that the goal acted.
 *
 * The convenient usage event, `session.usage.updated`, is deliberately NOT read:
 * it is **ephemeral** — confirmed both in the schema and by a live envelope
 * carrying no `durable` block — and it carries no location. Folding it into a
 * durable counter under-counts silently after a restart, which is the one
 * failure a budget guard cannot have.
 *
 * A note on where these shapes are declared: `@opencode/protocol` (the project's
 * own dependency) declares every event name here, and declares the step-ended
 * payload's `tokens` and `cost` exactly as recorded. `@opencode-ai/sdk`, which
 * sits under `.opencode/`, is a different and older package that describes only
 * `session.next.*` — reading the wrong one is how this was nearly gotten wrong
 * twice. The payload shapes below are still taken from recorded live envelopes,
 * and every field is read optionally so a shape the plugin has not met yet
 * degrades to "ignore" rather than throwing.
 */

import type { GoalStore } from './state.ts'

/** The `session.step.ended` payload, as a live server emits it. */
export interface StepEndedData {
  readonly sessionID?: string
  readonly assistantMessageID?: string
  readonly finish?: string
  readonly rawFinish?: string
  readonly cost?: number
  readonly tokens?: {
    readonly input?: number
    readonly output?: number
    readonly reasoning?: number
    readonly cache?: { readonly read?: number; readonly write?: number }
  }
}

/**
 * The `session.tool.success` payload, as a live server emits it.
 *
 * Only the metadata matters here, and only one part of it: a command that
 * actually ran reports `exit` (and `status`). A read tool reports neither — the
 * two live examples were `{ truncated: false }` for a `read` and
 * `{ status: "completed", truncated: false, exit: 0 }` for a `bash`.
 */
export interface ToolSuccessData {
  readonly sessionID?: string
  readonly assistantMessageID?: string
  readonly id?: string
  readonly metadata?: {
    readonly exit?: number
    readonly status?: string
    readonly truncated?: boolean
  }
}

/** The `session.text.ended` payload, as a live server emits it. */
export interface TextEndedData {
  readonly sessionID?: string
  readonly assistantMessageID?: string
  readonly ordinal?: number
  readonly text?: string
}

/** The `session.tool.called` payload, as a live server emits it. */
export interface ToolCalledData {
  readonly sessionID?: string
  readonly assistantMessageID?: string
  readonly id?: string
  readonly executed?: boolean
}

/** One ordinal part of an assistant message, in arrival order. */
export interface TextPart {
  readonly ordinal: number
  readonly text: string
}

export interface GoalAccountingHooks {
  /** The goal store for one project directory. */
  storeFor(directory: string): GoalStore
  /**
   * Whether the turn now running in a session is one this plugin submitted a
   * continuation prompt for — a goal round, as opposed to a human turn.
   *
   * The answer is a hook rather than a field because only the driver knows it:
   * it is the one that submitted the prompt, and its in-flight set is exactly
   * the set of goal-originated turns. The human command plane cannot answer
   * this and the server can, for the reason written into `GoalDriver.drive()`.
   */
  isGoalTurn(sessionID: string): boolean
}

export class GoalAccounting {
  /**
   * Text parts of assistant messages whose step has not ended yet, per session
   * then per message. One message can report several ordinal parts; the
   * no-progress guard reads them as one message's output, so they are collected
   * and joined when the message's step ends rather than fed in one part at a
   * time.
   *
   * Scoped by session so `forget` can drop a deleted session's buffer. A message
   * whose step never ends holds its parts until then — a leak bounded by the
   * session, not by the process.
   */
  private readonly pendingText = new Map<string, Map<string, TextPart[]>>()

  /**
   * Highest durable sequence folded per session. Durable events are delivered
   * at least once, so a redelivery must not be folded twice — the sequence makes
   * that check O(1) instead of remembering every event id.
   */
  private readonly foldedSeq = new Map<string, number>()

  /**
   * Exit codes of commands that actually ran in this goal, newest last.
   *
   * This is what makes a completion claim cross-checkable rather than trusted.
   * It is keyed by goal id and held in the process because it is derived state:
   * the events that carry it are already durable, so anything lost here is
   * re-derivable, and the claim it cross-checks is made in this same process.
   *
   * A command reports `exit` only when it is a command; a `read` reports no
   * metadata at all beyond `truncated`, so it records nothing rather than a
   * guessed zero.
   */
  private readonly ranCommands = new Map<string, number[]>()

  /**
   * Whether the turn currently running in a session has made a tool call. Per
   * session so the turn boundary can be crossed on any session's completion
   * event, and cleared at that boundary rather than at the start of the next
   * turn — a turn that ended without a tool call is the observation, and it must
   * be counted before the next turn can clear it.
   */
  private readonly toolCallThisTurn = new Set<string>()

  constructor(private readonly hooks: GoalAccountingHooks) {}

  /**
   * Fold one finished step: its usage delta into the goal, and the assistant
   * text it produced into the no-progress guard.
   *
   * Input, output, reasoning and cache-read are all counted: a goal's token
   * budget is a statement about what the provider billed, not about which field
   * of the bill it landed in.
   */
  onStepEnded(directory: string, data: StepEndedData, durableSeq?: number): void {
    const store = this.hooks.storeFor(directory)
    if (store.view() === undefined) return
    const sessionID = data.sessionID
    if (sessionID !== undefined && this.alreadyFolded(sessionID, durableSeq)) return
    // A human turn is not a goal round, so it spends neither the round budget nor
    // the token budget, and it does not move the no-progress fingerprint. Folding
    // every assistant message newer than the last accounted one — which is what
    // this used to do — charged a human's question to the goal's allowance and
    // let a human's rephrasing read as progress.
    if (sessionID !== undefined && !this.hooks.isGoalTurn(sessionID)) return

    const tokens = data.tokens
    const inputTokens = positive(tokens?.input) + positive(tokens?.cache?.read)
    const outputTokens = positive(tokens?.output) + positive(tokens?.reasoning)
    const cost = positive(data.cost)
    if (inputTokens > 0 || outputTokens > 0 || cost > 0) {
      store.addUsage({ inputTokens, outputTokens, cost })
    }
    this.flushText(store, sessionID, data.assistantMessageID)
    if (sessionID !== undefined) this.noteFolded(sessionID, durableSeq)
  }

  /**
   * Buffer one ordinal part of an assistant message. The parts are joined and
   * folded when that message's step ends, so a multi-part answer is one round's
   * output rather than several.
   */
  onTextEnded(_directory: string, data: TextEndedData): void {
    const sessionID = data.sessionID
    const messageID = data.assistantMessageID
    const text = data.text
    if (sessionID === undefined || messageID === undefined || text === undefined) return
    let messages = this.pendingText.get(sessionID)
    if (messages === undefined) {
      messages = new Map()
      this.pendingText.set(sessionID, messages)
    }
    let parts = messages.get(messageID)
    if (parts === undefined) {
      parts = []
      messages.set(messageID, parts)
    }
    parts.push({ ordinal: numeric(data.ordinal), text })
  }

  /**
   * Note that the turn running in a session made a tool call, and that the goal
   * acted. Both counters this feeds are decided at the turn boundary by
   * `onTurnEnded`, so this records the observation and defers the decision.
   */
  onToolActivity(directory: string, sessionID: string): void {
    if (sessionID !== undefined) this.toolCallThisTurn.add(sessionID)
    const store = this.hooks.storeFor(directory)
    if (store.view() === undefined) return
    store.noteToolCall()
  }

  onTurnEnded(directory: string, sessionID: string): void {
    const store = this.hooks.storeFor(directory)
    if (store.view() === undefined) {
      this.toolCallThisTurn.delete(sessionID)
      return
    }
    if (this.toolCallThisTurn.has(sessionID)) {
      store.noteToolCall()
    } else {
      store.noteTurnWithoutToolCall()
    }
    this.toolCallThisTurn.delete(sessionID)
  }

  /**
   * Note a command that actually ran, with the exit code the event reported.
   *
   * Called for `session.tool.success` when its metadata carries an `exit`. A
   * success with no exit code is not a command and records nothing.
   */
  onToolSuccess(directory: string, data: ToolSuccessData): void {
    const store = this.hooks.storeFor(directory)
    const goal = store.view()
    if (goal === undefined) return
    const exit = data.metadata?.exit
    if (typeof exit !== 'number' || !Number.isFinite(exit)) return
    const seen = this.ranCommands.get(goal.id) ?? []
    seen.push(exit)
    if (seen.length > 64) seen.splice(0, seen.length - 64)
    this.ranCommands.set(goal.id, seen)
  }

  /** Exit codes of the commands that ran for the goal in this directory. */
  commandsFor(directory: string): number[] {
    const goal = this.hooks.storeFor(directory).view()
    if (goal === undefined) return []
    return this.ranCommands.get(goal.id) ?? []
  }

  /** Drop every trace of a session so stale buffers cannot leak. */
  forget(sessionID: string): void {
    this.pendingText.delete(sessionID)
    this.foldedSeq.delete(sessionID)
  }

  /** The buffered parts of one assistant message, for tests and diagnostics. */
  pendingParts(sessionID: string, messageID: string): TextPart[] {
    return this.pendingText.get(sessionID)?.get(messageID) ?? []
  }

  /** Highest durable sequence folded for one session, for tests and diagnostics. */
  lastFoldedSeq(sessionID: string): number | undefined {
    return this.foldedSeq.get(sessionID)
  }

  /**
   * Join a message's buffered parts and record them as this round's output.
   *
   * The parts are joined with a space rather than a newline: two parts of one
   * answer joined with a newline fingerprinted as a difference, so the
   * no-progress guard read a rephrasing as progress.
   */
  private flushText(store: GoalStore, sessionID: string | undefined, messageID: string | undefined): void {
    if (sessionID === undefined || messageID === undefined) return
    const messages = this.pendingText.get(sessionID)
    if (messages === undefined) return
    const parts = messages.get(messageID)
    messages.delete(messageID)
    if (parts === undefined || parts.length === 0) return
    const text = [...parts].sort((a, b) => a.ordinal - b.ordinal).map(part => part.text).join(' ')
    store.recordRoundOutput(text)
  }

  /** Whether this session's event at this sequence has already been folded. */
  private alreadyFolded(sessionID: string, durableSeq: number | undefined): boolean {
    if (durableSeq === undefined) return false
    const seen = this.foldedSeq.get(sessionID)
    return seen !== undefined && durableSeq <= seen
  }

  private noteFolded(sessionID: string, durableSeq: number | undefined): void {
    const seen = this.foldedSeq.get(sessionID)
    if (durableSeq === undefined) {
      if (seen !== undefined) this.foldedSeq.delete(sessionID)
      return
    }
    if (seen === undefined || durableSeq > seen) this.foldedSeq.set(sessionID, durableSeq)
  }
}

/** Coerce a possibly-absent number to a non-negative finite one. */
function positive(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** Coerce a possibly-absent number to a non-negative finite one. */
function numeric(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}
