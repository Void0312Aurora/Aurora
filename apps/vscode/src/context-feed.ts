/**
 * IDE-context feed: debounces editor-change nudges, samples the current editor
 * state, suppresses a snapshot whose signature matches the last one it sent,
 * and injects the reading into the active session over `session.injectContext`
 * (the no-wakeup wire method). The VS Code event wiring and the active-session
 * resolution are injected, so the debounce/suppress/inject core is testable
 * without an editor or a server.
 */

import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import type { EditorState, SampleLimits } from './ide-context.ts'
import { sampleIdeContext } from './ide-context.ts'

/** Wiring the feed needs; every side effect is injected for tests. */
export interface ContextFeedOptions {
  /** The wire client (only `sessions.injectContext` is used). */
  client: Pick<IApiClient, 'sessions'>
  /** Reads the current editor facts on demand (the VS Code sampler in production). */
  readEditorState: () => EditorState
  /** Resolves the session to inject into, or undefined when none is active. */
  activeSession: () => string | undefined
  /** Text/diagnostic bounds per sample. */
  limits: SampleLimits
  /** Debounce window collapsing bursts of editor events; test seam. Defaults to 400ms. */
  debounceMs?: number
  /** Diagnostic line sink. */
  log: (line: string) => void
  /** Schedules a debounced run; test seam. Defaults to setTimeout. */
  schedule?: (fn: () => void, ms: number) => { cancel: () => void }
}

function defaultSchedule(fn: () => void, ms: number): { cancel: () => void } {
  const timer = setTimeout(fn, ms)
  return { cancel: () => { clearTimeout(timer) } }
}

/**
 * Debounced sampler that injects editor context into the active session.
 * Call {@link nudge} from every editor-change event; call {@link dispose} to
 * cancel a pending run. Per active session it remembers the last injected
 * signature, so switching files or sessions injects, while an idempotent event
 * (same file, same selection, same diagnostics) does not.
 */
export class IdeContextFeed {
  private readonly lastSignature = new Map<string, string>()
  private readonly primes = new Map<string, Promise<void>>()
  private pending: { cancel: () => void } | undefined

  /** @param options - client, samplers, bounds, and scheduling. */
  constructor(private readonly options: ContextFeedOptions) {}

  /** Nudge the feed after an editor change; the actual sample runs after the debounce. */
  nudge(): void {
    this.pending?.cancel()
    const schedule = this.options.schedule ?? defaultSchedule
    this.pending = schedule(() => {
      this.pending = undefined
      void this.flush()
    }, this.options.debounceMs ?? 400)
  }

  /**
   * Sample immediately after the target session changes. This cancels a
   * pending editor debounce so the current reading is admitted before the
   * user's first prompt in that session can be assembled.
   */
  async sync(): Promise<void> {
    this.pending?.cancel()
    this.pending = undefined
    const sessionId = this.options.activeSession()
    if (sessionId !== undefined) await this.beforeFirstPrompt(sessionId)
  }

  /**
   * Attempt one context admission before a session's first prompt is relayed.
   * Concurrent active-session and prompt paths share the same attempt.
   */
  beforeFirstPrompt(sessionId: string): Promise<void> {
    const current = this.primes.get(sessionId)
    if (current !== undefined) return current
    const prime = this.flush(sessionId)
    this.primes.set(sessionId, prime)
    return prime
  }

  private async flush(explicitSessionId?: string): Promise<void> {
    const sessionId = explicitSessionId ?? this.options.activeSession()
    if (sessionId === undefined) return
    const snapshot = sampleIdeContext(this.options.readEditorState(), this.options.limits)
    if (snapshot.text === undefined) return
    // Suppress a no-op: same session, same signature as the last injection.
    if (this.lastSignature.get(sessionId) === snapshot.signature) return
    try {
      const response = await this.options.client.sessions.injectContext({
        sessionId: sessionId as Parameters<IApiClient['sessions']['injectContext']>[0]['sessionId'],
        content: [{ type: 'text', text: snapshot.text }],
      })
      if (response.result.ok) {
        this.lastSignature.set(sessionId, snapshot.signature)
      } else {
        this.options.log(`injectContext rejected for ${sessionId}: ${response.result.error.code}`)
      }
    } catch (error) {
      this.options.log(`injectContext failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Forget a session's last-injected signature (e.g. when it is removed). */
  forget(sessionId: string): void {
    this.lastSignature.delete(sessionId)
    this.primes.delete(sessionId)
  }

  /** Cancel any pending debounced run. */
  dispose(): void {
    this.pending?.cancel()
    this.pending = undefined
  }
}
