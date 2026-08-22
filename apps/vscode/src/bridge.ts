/**
 * Extension-host half of the webview bridge: replays `dsh-fetch` requests
 * from the webview against the managed server's loopback origin and streams
 * the responses back as bridge messages. The webview half
 * (`PostMessageApiClient` in `@deepseek-ai/dsh-client-connection`) owns the
 * message vocabulary; this class is a faithful fetch relay — the loopback
 * Host passes the server's /api browser-trust fence like any non-browser
 * client, which is the whole reason the bridge exists.
 */

import type {
  BridgeRequestMessage,
  BridgeResponseMessage,
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
  post: (message: BridgeResponseMessage) => void
  /** Transport; defaults to global fetch. */
  fetchImpl?: typeof fetch
}

/** One panel's request relay; dispose aborts everything in flight. */
export class ApiBridge {
  private readonly inflight = new Map<number, AbortController>()
  private readonly fetchImpl: typeof fetch

  /** @param options - origin resolution, response sink, and transport. */
  constructor(private readonly options: ApiBridgeOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /**
   * Handle one request-side bridge message. Fire-and-forget: every outcome —
   * head, chunks, end, error, abort — returns to the webview as response-side
   * messages correlated by the message id.
   * @param message - the webview's request start or abort.
   */
  handle(message: BridgeRequestMessage): void {
    if (message.type === 'dsh-fetch-abort') {
      this.inflight.get(message.id)?.abort()
      return
    }
    void this.relay(message)
  }

  private async relay(message: Extract<BridgeRequestMessage, { type: 'dsh-fetch' }>): Promise<void> {
    const { id } = message
    const origin = this.options.origin()
    if (origin === undefined) {
      this.options.post({ type: 'dsh-fetch-error', id, message: 'dsh web is not running yet' })
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
      this.options.post({ type: 'dsh-fetch-error', id, message: `refused non-/api request target: ${message.path}` })
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
      this.options.post({ type: 'dsh-fetch-head', id, status: response.status })
      if (response.body !== null) {
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          this.options.post({ type: 'dsh-fetch-chunk', id, chunk: decoder.decode(value, { stream: true }) })
        }
      }
      this.options.post({ type: 'dsh-fetch-end', id })
    } catch (error) {
      // Abort and transport failures share one arm: the webview client maps
      // the message onto the owning call or stream either way.
      this.options.post({
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
    for (const controller of this.inflight.values()) controller.abort()
    this.inflight.clear()
  }
}
