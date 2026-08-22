/**
 * Webview-bridged transport: the platform subclass for embedder webviews
 * (VS Code) whose page origin cannot pass the /api browser-trust fence. All
 * HTTP traffic crosses an embedder postMessage port to the extension host,
 * which replays it against the loopback server (a loopback Host passes the
 * fence like any non-browser client). The port carries whole requests and
 * chunked responses, so one `doFetch` override serves unary POSTs and the
 * SSE streams alike.
 */

import { AbstractApiClient } from './api.ts'
import { API_PROTOCOL_VERSION } from '@deepseek-ai/dsh-host-apiproxy/api'

/** Webview → extension host: one request start, or the abort of one in flight. */
export type BridgeRequestMessage =
  | {
    type: 'dsh-fetch'
    /** Client-minted correlation id, unique per port lifetime. */
    id: number
    /** Path plus search of the /api request; the host owns the loopback base. */
    path: string
    method: string
    headers: Record<string, string>
    body?: string
  }
  | { type: 'dsh-fetch-abort'; id: number }

/** Extension host → webview: response head, body chunks, then end or error. */
export type BridgeResponseMessage =
  | { type: 'dsh-fetch-head'; id: number; status: number }
  | { type: 'dsh-fetch-chunk'; id: number; chunk: string }
  | { type: 'dsh-fetch-end'; id: number }
  | { type: 'dsh-fetch-error'; id: number; message: string }

/**
 * The embedder messaging face this transport needs. The webview bootstrap
 * owns the embedder API (VS Code's one-shot `acquireVsCodeApi()`) and adapts
 * it to this shape before the client tree boots.
 */
export interface WebviewBridgePort {
  /**
   * Send one request-side message to the extension host.
   * @param message - the request start or abort to deliver.
   */
  postMessage(message: BridgeRequestMessage): void
  /**
   * Subscribe to response-side messages from the extension host. Messages for
   * unknown ids must be ignored by the listener (the port is shared).
   * @param listener - receives every bridge response message.
   * @returns the unsubscribe disposer.
   */
  onMessage(listener: (message: BridgeResponseMessage) => void): () => void
}

/** Outcome of the webview's pre-boot protocol handshake. */
export type WebviewProtocolCheck =
  | { ok: true; hostVersion: string }
  | { ok: false; reason: string }

declare global {
  /** The global seat the webview bootstrap fills before the client tree boots. */
  var __DSH_WEBVIEW_BRIDGE__: WebviewBridgePort | undefined
}

/** Normalize whatever HeadersInit form the base client passed into a plain record. */
function headersRecord(init: HeadersInit | undefined): Record<string, string> {
  const record: Record<string, string> = {}
  new Headers(init).forEach((value, key) => { record[key] = value })
  return record
}

const BRIDGE_REQUEST_IDS = Symbol.for('@deepseek-ai/dsh-client-connection/webview-bridge-request-ids')

/** Keep each port's correlation space stable across lazy-bundle/HMR evaluations. */
function requestIds(): WeakMap<WebviewBridgePort, number> {
  const root = globalThis as typeof globalThis & Record<symbol, WeakMap<WebviewBridgePort, number> | undefined>
  return root[BRIDGE_REQUEST_IDS] ??= new WeakMap<WebviewBridgePort, number>()
}

/** Allocate one correlation id across every client sharing this port. */
function allocateBridgeRequestId(port: WebviewBridgePort): number {
  const ids = requestIds()
  const next = ids.get(port) ?? 1
  /* v8 ignore next -- a finite test process cannot exhaust monotonic safe integers */
  if (!Number.isSafeInteger(next)) {
    throw new Error('webview bridge: request id space exhausted')
  }
  ids.set(port, next + 1)
  return next
}

/**
 * Webview platform subclass: transport = the embedder postMessage port. The
 * response body is rebuilt as a ReadableStream fed by bridge chunks, so the
 * base client's unary JSON reads and SSE frame decoding work unchanged.
 */
export class PostMessageApiClient extends AbstractApiClient {
  /** @param port - the embedder messaging face the bootstrap adapted. */
  constructor(private readonly port: WebviewBridgePort) {
    super()
  }

  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    const id = allocateBridgeRequestId(this.port)
    const signal = init?.signal ?? undefined
    return new Promise<Response>((resolve, reject) => {
      const encoder = new TextEncoder()
      let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined
      const lifecycle = {
        headReceived: false,
        requestPosted: false,
        abortRequested: false,
        abortPosted: false,
        terminal: false,
      }
      const unsubscribeRef: { current?: () => void } = {}
      const cleanup = (): void => {
        /* v8 ignore next -- terminal messages and reentrant failures return before a second cleanup */
        if (lifecycle.terminal) return
        lifecycle.terminal = true
        unsubscribeRef.current?.()
        signal?.removeEventListener('abort', onAbort)
      }
      const abortUpstream = (): void => {
        if (!lifecycle.requestPosted || lifecycle.abortPosted) return
        lifecycle.abortPosted = true
        try {
          this.port.postMessage({ type: 'dsh-fetch-abort', id })
        } catch {
          // The local request is already terminal; the port offers no other
          // recovery channel when abort delivery itself fails.
        }
      }
      const requestUpstreamAbort = (): void => {
        lifecycle.abortRequested = true
        abortUpstream()
      }
      const fail = (error: Error): void => {
        if (lifecycle.terminal) return
        if (lifecycle.headReceived) bodyController?.error(error)
        else reject(error)
        cleanup()
      }
      const onAbort = (): void => {
        requestUpstreamAbort()
        fail(new DOMException('The operation was aborted.', 'AbortError'))
      }
      const subscribed = this.port.onMessage((message) => {
        if (message.id !== id || lifecycle.terminal) return
        switch (message.type) {
          case 'dsh-fetch-head': {
            if (lifecycle.headReceived) {
              requestUpstreamAbort()
              fail(new Error('webview bridge: duplicate response head'))
              return
            }
            lifecycle.headReceived = true
            const stream = new ReadableStream<Uint8Array>({
              start: (controller) => { bodyController = controller },
              cancel: () => {
                requestUpstreamAbort()
                cleanup()
              },
            })
            resolve(new Response(stream, { status: message.status }))
            break
          }
          case 'dsh-fetch-chunk': {
            if (!lifecycle.headReceived) {
              requestUpstreamAbort()
              fail(new Error('webview bridge: response chunk preceded response head'))
              return
            }
            bodyController?.enqueue(encoder.encode(message.chunk))
            break
          }
          case 'dsh-fetch-end': {
            if (!lifecycle.headReceived) {
              requestUpstreamAbort()
              fail(new Error('webview bridge: response end preceded response head'))
              return
            }
            bodyController?.close()
            cleanup()
            break
          }
          case 'dsh-fetch-error': {
            fail(new Error(message.message))
            break
          }
        }
      })
      unsubscribeRef.current = subscribed
      if (lifecycle.terminal) {
        subscribed()
        return
      }
      if (signal !== undefined) {
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      try {
        this.port.postMessage({
          type: 'dsh-fetch',
          id,
          path: input.pathname + input.search,
          method: init?.method ?? 'GET',
          headers: headersRecord(init?.headers),
          ...typeof init?.body === 'string' ? { body: init.body } : {},
        })
        lifecycle.requestPosted = true
        if (lifecycle.abortRequested) abortUpstream()
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
}

/**
 * Probe an embedder bridge before the client plugin graph starts. Only
 * `host.describe` crosses the port during this check; callers must not publish
 * the port to the connection plugin unless the versions match.
 * @param port - the embedder bridge port.
 * @param signal - optional cancellation for the handshake.
 * @returns compatibility with this client's API protocol.
 */
export async function verifyWebviewBridgeProtocol(
  port: WebviewBridgePort,
  signal?: AbortSignal,
): Promise<WebviewProtocolCheck> {
  try {
    const response = await new PostMessageApiClient(port).host.describe({}, signal)
    if (!response.result.ok) {
      return { ok: false, reason: `host.describe failed: ${response.result.error.code}` }
    }
    const { protocolVersion, version } = response.result.value
    if (protocolVersion !== API_PROTOCOL_VERSION) {
      return {
        ok: false,
        reason: `host protocolVersion ${String(protocolVersion)} != client ${String(API_PROTOCOL_VERSION)}`,
      }
    }
    return { ok: true, hostVersion: version }
  } catch (error) {
    return {
      ok: false,
      reason: `host.describe returned an incompatible response: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
