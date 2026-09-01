/**
 * Webview-bridged transport: the platform subclass for embedder webviews
 * (VS Code) whose page origin cannot pass the /api browser-trust fence. All
 * HTTP traffic crosses an embedder postMessage port to the extension host,
 * which replays it against the loopback server (a loopback Host passes the
 * fence like any non-browser client). The port carries whole requests and
 * chunked responses, so one `doFetch` override serves unary POSTs and the
 * SSE streams alike.
 */

import { AbstractApiClient, API_PROTOCOL_VERSION } from './api.ts'

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

/** Runtime parse result for one untrusted postMessage value. */
export type BridgeMessageParseResult<T> =
  | { ok: true; message: T }
  | { ok: false; id?: number; reason: string }

/** Result of the webview's pre-boot host protocol handshake. */
export type WebviewProtocolCheck =
  | { ok: true; hostVersion: string }
  | { ok: false; reason: string }

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function bridgeIdOf(record: Record<string, unknown>): number | undefined {
  const id = record.id
  return typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 ? id : undefined
}

function stringRecordOf(value: unknown): Record<string, string> | undefined {
  const record = recordOf(value)
  if (record === undefined) return undefined
  for (const entry of Object.values(record)) {
    if (typeof entry !== 'string') return undefined
  }
  return record as Record<string, string>
}

/**
 * Parse a Webview-to-host bridge message at the postMessage boundary.
 * @param value - untrusted value received from the Webview.
 * @returns the request message, or a correlatable rejection when its id is valid.
 */
export function parseBridgeRequestMessage(value: unknown): BridgeMessageParseResult<BridgeRequestMessage> {
  const record = recordOf(value)
  if (record === undefined) return { ok: false, reason: 'message must be an object' }
  const id = bridgeIdOf(record)
  if (id === undefined) return { ok: false, reason: 'id must be a non-negative safe integer' }
  if (record.type === 'dsh-fetch-abort') return { ok: true, message: { type: 'dsh-fetch-abort', id } }
  if (record.type !== 'dsh-fetch') return { ok: false, id, reason: 'unknown request message type' }
  const headers = stringRecordOf(record.headers)
  if (typeof record.path !== 'string' || typeof record.method !== 'string' || headers === undefined) {
    return { ok: false, id, reason: 'fetch path, method, and string-valued headers are required' }
  }
  if (record.body !== undefined && typeof record.body !== 'string') {
    return { ok: false, id, reason: 'fetch body must be a string when present' }
  }
  return {
    ok: true,
    message: {
      type: 'dsh-fetch',
      id,
      path: record.path,
      method: record.method,
      headers,
      ...record.body === undefined ? {} : { body: record.body },
    },
  }
}

/**
 * Parse a host-to-Webview bridge message at the postMessage boundary.
 * @param value - untrusted value received from the extension host.
 * @returns the response message, or a correlatable rejection when its id is valid.
 */
export function parseBridgeResponseMessage(value: unknown): BridgeMessageParseResult<BridgeResponseMessage> {
  const record = recordOf(value)
  if (record === undefined) return { ok: false, reason: 'message must be an object' }
  const id = bridgeIdOf(record)
  if (id === undefined) return { ok: false, reason: 'id must be a non-negative safe integer' }
  switch (record.type) {
    case 'dsh-fetch-head':
      return typeof record.status === 'number'
        && Number.isInteger(record.status)
        && record.status >= 200
        && record.status <= 599
        ? { ok: true, message: { type: 'dsh-fetch-head', id, status: record.status } }
        : { ok: false, id, reason: 'response status must be an integer from 200 through 599' }
    case 'dsh-fetch-chunk':
      return typeof record.chunk === 'string'
        ? { ok: true, message: { type: 'dsh-fetch-chunk', id, chunk: record.chunk } }
        : { ok: false, id, reason: 'response chunk must be a string' }
    case 'dsh-fetch-end':
      return { ok: true, message: { type: 'dsh-fetch-end', id } }
    case 'dsh-fetch-error':
      return typeof record.message === 'string'
        ? { ok: true, message: { type: 'dsh-fetch-error', id, message: record.message } }
        : { ok: false, id, reason: 'response error message must be a string' }
    default:
      return { ok: false, id, reason: 'unknown response message type' }
  }
}

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
   * @param listener - receives each untrusted response candidate.
   * @returns the unsubscribe disposer.
   */
  onMessage(listener: (message: unknown) => void): () => void
}

/**
 * Keep request ids unique for one bridge even when multiple client instances,
 * or independently evaluated copies of this module, share that bridge. The
 * state lives on globalThis through a registered symbol so Vite/Node module
 * duplication cannot reset the counter and reuse an in-flight id.
 */
const REQUEST_ID_STATE = Symbol.for('dsh.webviewBridge.requestIdState')

function nextRequestId(port: WebviewBridgePort): number {
  const globalState = globalThis as unknown as Record<PropertyKey, unknown>
  let counters = globalState[REQUEST_ID_STATE] as WeakMap<object, number> | undefined
  if (counters === undefined) {
    counters = new WeakMap<object, number>()
    globalState[REQUEST_ID_STATE] = counters
  }
  const id = (counters.get(port) ?? 0) + 1
  counters.set(port, id)
  return id
}

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
    const id = nextRequestId(this.port)
    const signal = init?.signal ?? undefined
    return new Promise<Response>((resolve, reject) => {
      const encoder = new TextEncoder()
      let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined
      let headReceived = false
      let requestPosted = false
      let abortPosted = false
      let terminal = false
      let cleanupRequested = false
      let unsubscribe: (() => void) | undefined
      // Function reads, not inline flag comparisons: both flags are mutated by
      // the listener closure below, which a synchronous embedder can drive
      // while `onMessage` is still installing. Static control-flow narrowing
      // does not model that call and would treat the reads as always-false.
      const isTerminal = (): boolean => terminal
      const isCleanupRequested = (): boolean => cleanupRequested
      const cleanup = (): void => {
        /* v8 ignore next -- idempotence guard per the teardown rule: every current caller
           (fail, the end arm, the body-cancel arm) already returns early when terminal, and
           a closed or errored stream never re-invokes cancel, so no path reaches this twice. */
        if (terminal) return
        terminal = true
        if (unsubscribe === undefined) cleanupRequested = true
        else unsubscribe()
        signal?.removeEventListener('abort', onAbort)
      }
      const abortUpstream = (): void => {
        if (!requestPosted || abortPosted) return
        // Mark before posting: a hostile/reentrant embedder can synchronously
        // deliver another response while this postMessage call is on the stack.
        abortPosted = true
        try {
          this.port.postMessage({ type: 'dsh-fetch-abort', id })
        } catch {
          // The caller is already failing or cancelling; the port has no
          // additional recovery channel once postMessage itself is gone.
        }
      }
      const fail = (error: Error): void => {
        if (terminal) return
        if (headReceived) bodyController?.error(error)
        else reject(error)
        cleanup()
      }
      const failProtocol = (message: string): void => {
        abortUpstream()
        fail(new Error(`invalid bridge response: ${message}`))
      }
      const onAbort = (): void => {
        abortUpstream()
        fail(new DOMException('The operation was aborted.', 'AbortError'))
      }
      unsubscribe = this.port.onMessage((value) => {
        const parsed = parseBridgeResponseMessage(value)
        if (!parsed.ok) {
          if (parsed.id === id) failProtocol(parsed.reason)
          return
        }
        const message = parsed.message
        if (message.id !== id || terminal) return
        switch (message.type) {
          case 'dsh-fetch-head': {
            if (headReceived) {
              failProtocol('duplicate response head')
              return
            }
            headReceived = true
            const stream = new ReadableStream<Uint8Array>({
              start: (controller) => { bodyController = controller },
              cancel: () => {
                abortUpstream()
                cleanup()
              },
            })
            resolve(new Response(stream, { status: message.status }))
            break
          }
          case 'dsh-fetch-chunk': {
            if (!headReceived) {
              failProtocol('body chunk preceded response head')
              return
            }
            bodyController?.enqueue(encoder.encode(message.chunk))
            break
          }
          case 'dsh-fetch-end': {
            if (!headReceived) {
              failProtocol('response end preceded response head')
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
      if (isCleanupRequested()) {
        unsubscribe()
        unsubscribe = undefined
      }
      // A synchronous test/embedder response may have completed the request
      // while onMessage was still installing the subscription. Do not post a
      // now-terminal request into the host after that completion.
      if (isTerminal()) return
      if (signal !== undefined) {
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      requestPosted = true
      try {
        this.port.postMessage({
          type: 'dsh-fetch',
          id,
          path: input.pathname + input.search,
          method: init?.method ?? 'GET',
          headers: headersRecord(init?.headers),
          ...typeof init?.body === 'string' ? { body: init.body } : {},
        })
      } catch (error) {
        requestPosted = false
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
