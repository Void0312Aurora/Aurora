/**
 * Extension-host half of the webview bridge: replays `dsh-fetch` requests
 * from the webview against the managed server's loopback origin and streams
 * the responses back as bridge messages. The webview half
 * (`PostMessageApiClient` in `@deepseek-ai/dsh-client-connection`) owns the
 * message vocabulary; this class is a faithful fetch relay — the loopback
 * Host passes the server's /api browser-trust fence like any non-browser
 * client, which is the whole reason the bridge exists.
 */

import {
  parseBridgeRequestMessage,
  type BridgeRequestMessage,
  type BridgeResponseMessage,
} from '@deepseek-ai/dsh-client-connection/client'

/** The one path prefix the bridge relays; everything else is refused before a fetch. */
const API_PREFIX = '/api/'

/**
 * Resolve a webview-supplied request path against the server origin, returning
 * the target only when it stays on that exact origin and under `/api/`.
 * Returns undefined for anything that would leave the managed server —
 * absolute URLs, protocol-relative `//host` authorities, backslash
 * authorities, and non-API paths — so the caller fails the request closed.
 * @param path - the `path` field from a webview `dsh-fetch` message.
 * @param origin - the current managed-server origin.
 * @returns the confined target URL, or undefined when the path escapes it.
 */
export function resolveApiTarget(path: string, origin: URL): URL | undefined {
  // A backslash is an authority separator to WHATWG URL parsing; reject it
  // outright so `/\evil.com` or `\\evil.com` cannot become an authority.
  if (path.includes('\\')) return undefined
  let target: URL
  try {
    target = new URL(path, origin)
  } catch {
    // new URL(path, origin) throws only for an unparsable base+path; treat as escape.
    return undefined
  }
  if (target.origin !== origin.origin) return undefined
  if (!target.pathname.startsWith(API_PREFIX)) return undefined
  return target
}

/** Wire faces the bridge needs from its surroundings; injectable for tests. */
export interface ApiBridgeOptions {
  /** Current server origin; undefined while the server is still starting. */
  origin: () => URL | undefined
  /** Response-side sink (the webview's postMessage). */
  post: (message: BridgeResponseMessage) => void | PromiseLike<boolean>
  /** Transport; defaults to global fetch. */
  fetchImpl?: typeof fetch
}

/** One panel's request relay; dispose aborts everything in flight. */
export class ApiBridge {
  private readonly inflight = new Map<number, AbortController>()
  private readonly seenIds = new Set<number>()
  private readonly fetchImpl: typeof fetch
  private disposed = false

  /** @param options - origin resolution, response sink, and transport. */
  constructor(private readonly options: ApiBridgeOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /**
   * Handle one request-side bridge message. Fire-and-forget: every outcome —
   * head, chunks, end, error, abort — returns to the webview as response-side
   * messages correlated by the message id.
   * @param value - untrusted Webview message to parse and dispatch.
   */
  handle(value: unknown): void {
    const parsed = parseBridgeRequestMessage(value)
    if (!parsed.ok) {
      if (parsed.id !== undefined) {
        this.rejectRequest(parsed.id, `invalid bridge request: ${parsed.reason}`)
      }
      return
    }
    const message = parsed.message
    if (message.type === 'dsh-fetch-abort') {
      this.inflight.get(message.id)?.abort()
      return
    }
    if (this.disposed) {
      this.postError(message.id, 'bridge is disposed')
      return
    }
    if (this.seenIds.has(message.id)) {
      this.rejectRequest(message.id, 'duplicate bridge request id')
      return
    }
    this.seenIds.add(message.id)
    void this.relay(message).catch((error: unknown) => {
      // `post` is an embedder boundary and can reject independently of fetch;
      // keep fire-and-forget relay calls from becoming unhandled rejections.
      console.error('[dsh-vscode] bridge relay failed:', error)
    })
  }

  private postError(id: number, message: string): void {
    void this.safePost({ type: 'dsh-fetch-error', id, message })
  }

  /** Reject a correlatable id and stop any relay whose response would now be orphaned. */
  private rejectRequest(id: number, message: string): void {
    this.seenIds.add(id)
    this.inflight.get(id)?.abort()
    this.postError(id, message)
  }

  private async safePost(message: BridgeResponseMessage): Promise<boolean> {
    try {
      const result = this.options.post(message)
      return result === undefined || await result
    } catch (error) {
      console.error('[dsh-vscode] bridge response post failed:', error)
      return false
    }
  }

  private async relay(message: Extract<BridgeRequestMessage, { type: 'dsh-fetch' }>): Promise<void> {
    const { id } = message
    const origin = this.options.origin()
    if (origin === undefined) {
      this.postError(id, 'dsh web is not running yet')
      return
    }
    // Confinement, not convenience: the webview may run injected script, so the
    // host — which holds loopback network reach — must refuse to leave the
    // managed server. Resolve the request path against the server origin and
    // require the result to stay on that exact origin and under `/api/`. This
    // rejects an absolute URL, a protocol-relative `//host` authority, a
    // backslash authority, and any path that escapes the API prefix — the
    // confused-deputy / SSRF surface a bare `new URL(path, origin)` would open.
    const target = resolveApiTarget(message.path, origin)
    if (target === undefined) {
      this.postError(id, `refused non-/api request target: ${message.path}`)
      return
    }
    const controller = new AbortController()
    this.inflight.set(id, controller)
    try {
      const response = await this.fetchImpl(target, {
        method: message.method,
        headers: message.headers,
        ...message.body === undefined ? {} : { body: message.body },
        signal: controller.signal,
      })
      if (!await this.safePost({ type: 'dsh-fetch-head', id, status: response.status })) {
        controller.abort()
        return
      }
      if (response.body !== null) {
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (!await this.safePost({ type: 'dsh-fetch-chunk', id, chunk: decoder.decode(value, { stream: true }) })) {
            controller.abort()
            await reader.cancel().catch(() => {
              // The owning request is already aborted; cancellation has no
              // second recovery channel if the response body rejects it.
            })
            return
          }
        }
        const tail = decoder.decode()
        if (tail !== '' && !await this.safePost({ type: 'dsh-fetch-chunk', id, chunk: tail })) {
          controller.abort()
          return
        }
      }
      await this.safePost({ type: 'dsh-fetch-end', id })
    } catch (error) {
      // Abort and transport failures share one arm: the webview client maps
      // the message onto the owning call or stream either way.
      await this.safePost({
        type: 'dsh-fetch-error',
        id,
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      this.inflight.delete(id)
    }
  }

  /** Abort every in-flight relay (panel disposal). */
  dispose(): void {
    this.disposed = true
    for (const controller of this.inflight.values()) controller.abort()
    this.inflight.clear()
  }
}
