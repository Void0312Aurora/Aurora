/**
 * Native interaction bridge: a host-side consumer of the mux stream that
 * surfaces the agent's approval and question requests through editor-native UI
 * and answers them over `/api/respond`. It runs beside the webview's own
 * stream — the wire is multi-client, so whichever surface answers first wins
 * and the other's late answer is a harmless `not-pending` receipt. The
 * consumer keeps a `callId → tool view` cache so an approval prompt can show
 * what the call will do (the approval frame itself carries only a tool name).
 */

import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import type { MuxFrame, RpcId, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ToolCallView } from '@deepseek-ai/dsh-tools/presentation'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'

/** What a pending approval asks the user, enriched from the cached tool call. */
export interface ApprovalPrompt {
  sessionId: string
  toolName: string
  /** Free-text reason the policy attached, when any. */
  reason?: string
  /** The cached call view for this approval's `callId`, when the call was seen. */
  call?: ToolCallView
}

/** Editor-native surfaces the consumer drives; the vscode adapter implements them. */
export interface NativeUi {
  /**
   * Present one approval. Resolve `allowed-once`/`rejected` to answer, or
   * `dismissed` to leave it for another surface (no wire answer is sent).
   * @param prompt - the tool, reason, and cached call view.
   * @param signal - aborts when the request resolves elsewhere; the UI should close.
   */
  confirmApproval(prompt: ApprovalPrompt, signal: AbortSignal): Promise<'allowed-once' | 'rejected' | 'dismissed'>
  /**
   * Present one ask() batch. Resolve the answer to submit, or undefined to
   * leave it for another surface.
   * @param items - the question batch.
   * @param signal - aborts when the request resolves elsewhere.
   */
  askQuestions(items: AskUserQuestionItem[], signal: AbortSignal): Promise<AskUserQuestionAnswer | undefined>
}

/** Wiring the consumer needs; the client and UI are injectable for tests. */
export interface NativeInteractionsOptions {
  /** The host wire client (mux stream + respond). */
  client: Pick<IApiClient, 'events' | 'respond'>
  /** Editor-native prompt surfaces. */
  ui: NativeUi
  /** Diagnostic line sink. */
  log: (line: string) => void
  /** Backoff before reopening a dropped stream; test seam. Defaults to 1000ms. */
  reconnectMs?: number
}

/** One cached tool call: its name and (when the view arrived) its call presentation. */
interface CachedCall {
  name: string
  view?: ToolCallView
}

/** Cache key scoping a provider callId to its session (mux multiplexes sessions). */
function callKey(sessionId: string, callId: string): string {
  return `${sessionId}\u0000${callId}`
}

/**
 * Consume the mux stream and drive native approval/question prompts. Start with
 * {@link run}; stop with {@link dispose}. Reconnection reopens the stream (the
 * host replays still-pending approval/question frames on open), so no history
 * reconciliation is needed for this surface.
 */
export class NativeInteractions {
  // Cached tool calls, keyed by (sessionId, callId): mux multiplexes sessions
  // and a provider callId is only unique within its session, so a bare callId
  // key could surface another session's command in an approval. Entries are
  // dropped when the call's tool/result arrives, bounding the cache.
  private readonly calls = new Map<string, CachedCall>()
  // Keyed by the correlation id a `*/resolved` frame carries: the approvalId
  // for approvals, the request rpcId for questions. Aborting closes a prompt
  // that another surface answered first.
  private readonly pending = new Map<string, AbortController>()
  private stopped = false
  private streamAbort: AbortController | undefined

  /** @param options - client, UI, logging, and reconnect cadence. */
  constructor(private readonly options: NativeInteractionsOptions) {}

  /** Run the consume/reconnect loop until {@link dispose}. */
  async run(): Promise<void> {
    const reconnectMs = this.options.reconnectMs ?? 1000
    // The loop exits through `dispose()` aborting the live stream: that throw
    // is caught below and, being an owned abort, returns without reopening
    // (keying teardown off the abort signal, not the mutable stopped flag —
    // the signal is what dispose actually trips mid-iteration).
    while (!this.stopped) {
      const abort = new AbortController()
      this.streamAbort = abort
      try {
        for await (const envelope of this.options.client.events.mux({}, abort.signal)) {
          this.handle(envelope)
        }
      } catch (error) {
        if (abort.signal.aborted) return
        this.options.log(`mux stream dropped: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (abort.signal.aborted) return
      // The generation ended (drop or clean close). Close every open prompt:
      // the reopened stream replays still-pending approval/question frames, so
      // leaving the old prompts up would double them (and the reopened frame's
      // handler would overwrite their pending entries). The replay recreates
      // whatever is still pending.
      this.resetPending()
      await new Promise(resolve => setTimeout(resolve, reconnectMs))
    }
  }

  /** Abort and clear every open prompt (a stream generation ended). */
  private resetPending(): void {
    for (const controller of this.pending.values()) controller.abort()
    this.pending.clear()
  }

  /** Drop every cached call for one session (its turn ended; the calls are settled). */
  private purgeSessionCalls(sessionId: string): void {
    const prefix = callKey(sessionId, '')
    for (const key of this.calls.keys()) {
      if (key.startsWith(prefix)) this.calls.delete(key)
    }
  }

  private handle(envelope: RpcRequest<MuxFrame>): void {
    const frame = envelope.payload
    switch (frame.type) {
      case 'session/event':
        // Cache tool calls so an approval can show what it will do (the call's
        // view rides the same frame). A turn's calls are settled at turn/end
        // (any approval already happened during the turn), so purge that
        // session's cache there — this bounds the cache without needing the
        // result event's callId.
        if (frame.event.type === 'tool/call') {
          const data = frame.event.data as { callId: string; name: string }
          const view = frame.view?.for === 'call' ? frame.view.view : undefined
          this.calls.set(callKey(frame.sessionId, data.callId), { name: data.name, ...view === undefined ? {} : { view } })
        } else if (frame.event.type === 'turn/end') {
          this.purgeSessionCalls(frame.sessionId)
        }
        break
      case 'approval/requested':
        // The answer echoes the request's envelope rpcId; the approvalId is the
        // correlation key a later approval/resolved frame carries.
        void this.onApproval(envelope.rpcId, frame.approvalId, frame)
        break
      case 'question/requested':
        // The question's request rpcId is both the echo id and the correlation
        // key (question/resolved carries it as questionRpcId).
        void this.onQuestion(envelope.rpcId, frame)
        break
      case 'approval/resolved':
        this.settle(frame.approvalId)
        break
      case 'question/resolved':
        this.settle(frame.questionRpcId)
        break
      default:
        // Other frames (queue, projection, subscribed, status) are the
        // webview's concern; the native surface ignores them.
        break
    }
  }

  private async onApproval(
    respondId: RpcId,
    correlationId: string,
    frame: Extract<MuxFrame, { type: 'approval/requested' }>,
  ): Promise<void> {
    // A prompt is already open for this request (a duplicate frame within one
    // generation); do not open a second.
    if (this.pending.has(correlationId)) return
    const abort = new AbortController()
    this.pending.set(correlationId, abort)
    try {
      const cached = frame.callId === undefined ? undefined : this.calls.get(callKey(frame.sessionId, frame.callId))
      const prompt: ApprovalPrompt = {
        sessionId: frame.sessionId,
        toolName: frame.toolName,
        ...frame.reason === undefined ? {} : { reason: frame.reason },
        ...cached?.view === undefined ? {} : { call: cached.view },
      }
      const outcome = await this.options.ui.confirmApproval(prompt, abort.signal)
      if (outcome === 'dismissed' || abort.signal.aborted) return
      await this.respond(respondId, { sessionId: frame.sessionId, approvalId: frame.approvalId, outcome })
    } finally {
      this.clearPending(correlationId, abort)
    }
  }

  private async onQuestion(
    respondId: RpcId,
    frame: Extract<MuxFrame, { type: 'question/requested' }>,
  ): Promise<void> {
    const correlationId = respondId as unknown as string
    if (this.pending.has(correlationId)) return
    const abort = new AbortController()
    this.pending.set(correlationId, abort)
    try {
      const answer = await this.options.ui.askQuestions(frame.questions, abort.signal)
      if (answer === undefined || abort.signal.aborted) return
      await this.respond(respondId, { sessionId: frame.sessionId, answer })
    } finally {
      this.clearPending(correlationId, abort)
    }
  }

  /** Remove a pending entry only when it still holds this exact controller (a reset/replay may have replaced it). */
  private clearPending(correlationId: string, abort: AbortController): void {
    if (this.pending.get(correlationId) === abort) this.pending.delete(correlationId)
  }

  private async respond(rpcId: RpcId, value: unknown): Promise<void> {
    try {
      const receipt = await this.options.client.respond({ type: 'client-response', rpcId, result: { ok: true, value } })
      if (!receipt.accepted) this.options.log(`respond ${String(rpcId)} not accepted: ${receipt.reason}`)
    } catch (error) {
      this.options.log(`respond ${String(rpcId)} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private settle(correlationId: string): void {
    this.pending.get(correlationId)?.abort()
  }

  /** Stop the loop and close any open prompts. */
  dispose(): void {
    this.stopped = true
    this.streamAbort?.abort()
    for (const controller of this.pending.values()) controller.abort()
    this.pending.clear()
  }
}
