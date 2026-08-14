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
  private nextRequestId = 1

  /** @param port - the embedder messaging face the bootstrap adapted. */
  constructor(private readonly port: WebviewBridgePort) {
    super()
  }

  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    const id = this.nextRequestId++
    const signal = init?.signal ?? undefined
    return new Promise<Response>((resolve, reject) => {
      const encoder = new TextEncoder()
      let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined
      let settled = false
      // One cleanup for every exit (head-then-end, error, abort, stream
      // cancel): drop the port subscription and the abort listener so neither
      // leaks past the request's life.
      const cleanup = (): void => {
        unsubscribe()
        signal?.removeEventListener('abort', onAbort)
      }
      // Callers guard on `settled` before invoking: after the head, failures
      // route to the body stream, never back to the fetch promise.
      const failBeforeHead = (error: Error): void => {
        settled = true
        cleanup()
        reject(error)
      }
      const unsubscribe = this.port.onMessage((message) => {
        if (message.id !== id) return
        switch (message.type) {
          case 'dsh-fetch-head': {
            settled = true
            const stream = new ReadableStream<Uint8Array>({
              start: (controller) => { bodyController = controller },
              // The consumer cancelled the body (stopped reading): tell the
              // host to abort the upstream fetch, then clean up.
              cancel: () => {
                this.port.postMessage({ type: 'dsh-fetch-abort', id })
                cleanup()
              },
            })
            resolve(new Response(stream, { status: message.status }))
            break
          }
          case 'dsh-fetch-chunk':
            bodyController?.enqueue(encoder.encode(message.chunk))
            break
          case 'dsh-fetch-end':
            bodyController?.close()
            cleanup()
            break
          case 'dsh-fetch-error': {
            const error = new Error(message.message)
            if (settled) bodyController?.error(error)
            else failBeforeHead(error)
            cleanup()
            break
          }
        }
      })
      const onAbort = (): void => {
        this.port.postMessage({ type: 'dsh-fetch-abort', id })
        const error = new DOMException('The operation was aborted.', 'AbortError')
        if (settled) bodyController?.error(error)
        else failBeforeHead(error)
        cleanup()
      }
      if (signal !== undefined) {
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      this.port.postMessage({
        type: 'dsh-fetch',
        id,
        path: input.pathname + input.search,
        method: init?.method ?? 'GET',
        headers: headersRecord(init?.headers),
        ...typeof init?.body === 'string' ? { body: init.body } : {},
      })
    })
  }
}
