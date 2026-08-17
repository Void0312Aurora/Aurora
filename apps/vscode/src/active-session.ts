/**
 * Active-session tracker: follows the host event stream and remembers which
 * session the user is most plausibly working in, so the IDE-context feed has a
 * target. The webview owns true session selection; until a webview→host signal
 * exists, "the last session to start running, else the last one added" is the
 * host-side heuristic — correct for the common single-session flow. Reconnects
 * on drop like the interaction consumer.
 */

import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import type { HostFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'

/** Wiring the tracker needs; the client is injected for tests. */
export interface ActiveSessionOptions {
  /** The host wire client (only the host event stream is used). */
  client: Pick<IApiClient, 'events'>
  /** Diagnostic line sink. */
  log: (line: string) => void
  /** Called synchronously after the active session id changes. */
  onActiveChanged?: (previous: string | undefined, current: string | undefined) => void
  /** Backoff before reopening a dropped stream; test seam. Defaults to 1000ms. */
  reconnectMs?: number
}

/**
 * Tracks the active session id from host frames. Start with {@link run}; read
 * with {@link active}; stop with {@link dispose}.
 */
export class ActiveSessionTracker {
  private activeId: string | undefined
  private stopped = false
  private streamAbort: AbortController | undefined

  /** @param options - client, logging, and reconnect cadence. */
  constructor(private readonly options: ActiveSessionOptions) {}

  /** The current active session id, or undefined when none is known. */
  active(): string | undefined {
    return this.activeId
  }

  /** Publish an active-id change once, after updating the readable value. */
  private setActive(next: string | undefined): void {
    const previous = this.activeId
    if (previous === next) return
    this.activeId = next
    this.options.onActiveChanged?.(previous, next)
  }

  /** Run the host-stream consume/reconnect loop until {@link dispose}. */
  async run(): Promise<void> {
    const reconnectMs = this.options.reconnectMs ?? 1000
    while (!this.stopped) {
      const abort = new AbortController()
      this.streamAbort = abort
      try {
        for await (const envelope of this.options.client.events.host({}, abort.signal)) {
          this.handle(envelope)
        }
      } catch (error) {
        if (abort.signal.aborted) return
        this.options.log(`host stream dropped: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (abort.signal.aborted) return
      await new Promise(resolve => setTimeout(resolve, reconnectMs))
    }
  }

  private handle(envelope: RpcRequest<HostFrame>): void {
    const frame = envelope.payload
    switch (frame.type) {
      case 'host/session-status':
        // A session going running is the strongest "user is here" signal.
        if (frame.running) this.setActive(frame.sessionId)
        break
      case 'host/session-added':
        // Adopt the first session seen so a fresh single-session window has a
        // target before any turn runs; a later running flip refines it.
        if (this.activeId === undefined) this.setActive(frame.sessionId)
        break
      case 'host/session-removed':
        if (this.activeId === frame.sessionId) this.setActive(undefined)
        break
      default:
        // Workspace, settings, model, and error frames do not move the cursor.
        break
    }
  }

  /** Stop the loop. */
  dispose(): void {
    this.stopped = true
    this.streamAbort?.abort()
  }
}
