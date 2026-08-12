/**
 * ApiBridge relay behavior: it replays webview `dsh-fetch` requests against
 * the managed server origin and streams responses back as bridge messages,
 * mirrors abort both ways, fails cleanly before the server is up, and drops
 * a relay when the origin is gone. The webview client half owns the message
 * vocabulary; this suite fakes both the fetch transport and the response sink.
 */

import { describe, expect, it } from 'vitest'
import type { BridgeResponseMessage } from '@deepseek-ai/dsh-client-connection/client'
import { ApiBridge } from '../src/bridge.ts'

const RUNNING_ORIGIN = new URL('http://127.0.0.1:5173/')

// origin is required (no default): a default would swallow an explicit
// `undefined` — JS default params fire on undefined regardless of how it
// was passed — and the "no origin yet" case needs a genuine undefined.
function collectingBridge(fetchImpl: typeof fetch, origin: URL | undefined) {
  const posted: BridgeResponseMessage[] = []
  const bridge = new ApiBridge({
    origin: () => origin,
    post: message => posted.push(message),
    fetchImpl,
  })
  return { bridge, posted }
}

function streamResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { status })
}

/** A response whose body never closes until the request signal aborts (real fetch abort behavior). */
function hangingResponse(signal: AbortSignal | undefined): Response {
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      signal?.addEventListener('abort', () => {
        controller.error(new DOMException('The operation was aborted.', 'AbortError'))
      }, { once: true })
    },
  })
  return new Response(body, { status: 200 })
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('ApiBridge', () => {
  it('relays a request against the server origin and streams head + chunks + end', async () => {
    let seen: { url: string; method: string; body?: string } | undefined
    const fetchImpl: typeof fetch = async (input, init) => {
      seen = {
        // The bridge always passes a URL; the other RequestInfo forms are unreached here.
        url: input instanceof URL ? input.href : input instanceof Request ? input.url : input,
        method: init?.method ?? 'GET',
        ...typeof init?.body === 'string' ? { body: init.body } : {},
      }
      return streamResponse(['{"rpcId":"r1",', '"result":{"ok":true}}'])
    }
    const { bridge, posted } = collectingBridge(fetchImpl, RUNNING_ORIGIN)

    bridge.handle({ type: 'dsh-fetch', id: 1, path: '/api/session.list', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    await settle()

    expect(seen).toEqual({ url: 'http://127.0.0.1:5173/api/session.list', method: 'POST', body: '{}' })
    expect(posted).toEqual([
      { type: 'dsh-fetch-head', id: 1, status: 200 },
      { type: 'dsh-fetch-chunk', id: 1, chunk: '{"rpcId":"r1",' },
      { type: 'dsh-fetch-chunk', id: 1, chunk: '"result":{"ok":true}}' },
      { type: 'dsh-fetch-end', id: 1 },
    ])
  })

  it('forwards a non-2xx status as the head so the client raises the transport failure', async () => {
    const fetchImpl = (async () => streamResponse([], 503)) as typeof fetch
    const { bridge, posted } = collectingBridge(fetchImpl, RUNNING_ORIGIN)
    bridge.handle({ type: 'dsh-fetch', id: 7, path: '/api/host.describe', method: 'POST', headers: {} })
    await settle()
    expect(posted[0]).toEqual({ type: 'dsh-fetch-head', id: 7, status: 503 })
    expect(posted.at(-1)).toEqual({ type: 'dsh-fetch-end', id: 7 })
  })

  it('answers with an error before the server has an origin', async () => {
    // Explicit undefined must stay undefined (not fall to the default origin).
    const fetchImpl = (async () => streamResponse([])) as typeof fetch
    const noOrigin: URL | undefined = undefined
    const { bridge, posted } = collectingBridge(fetchImpl, noOrigin)
    bridge.handle({ type: 'dsh-fetch', id: 2, path: '/api/host.describe', method: 'POST', headers: {} })
    await settle()
    expect(posted).toEqual([{ type: 'dsh-fetch-error', id: 2, message: 'dsh web is not running yet' }])
  })

  it('reports a transport failure as an error message', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch
    const { bridge, posted } = collectingBridge(fetchImpl, RUNNING_ORIGIN)
    bridge.handle({ type: 'dsh-fetch', id: 3, path: '/api/session.list', method: 'POST', headers: {} })
    await settle()
    expect(posted).toEqual([{ type: 'dsh-fetch-error', id: 3, message: 'ECONNREFUSED' }])
  })

  it('aborts an in-flight relay when the webview sends dsh-fetch-abort', async () => {
    let observedSignal: AbortSignal | undefined
    const fetchImpl: typeof fetch = async (_input, init) => {
      observedSignal = init?.signal ?? undefined
      // A never-ending body that errors on abort (real fetch behavior).
      return hangingResponse(observedSignal)
    }
    const { bridge, posted } = collectingBridge(fetchImpl, RUNNING_ORIGIN)

    bridge.handle({ type: 'dsh-fetch', id: 4, path: '/api/events.mux', method: 'GET', headers: {} })
    await settle()
    expect(observedSignal?.aborted).toBe(false)
    bridge.handle({ type: 'dsh-fetch-abort', id: 4 })
    await settle()
    expect(observedSignal?.aborted).toBe(true)
    expect(posted.some(m => m.type === 'dsh-fetch-error' && m.id === 4)).toBe(true)
  })

  it('aborts everything in flight on dispose', async () => {
    const signals: AbortSignal[] = []
    const fetchImpl: typeof fetch = async (_input, init) => {
      const signal = init?.signal ?? undefined
      if (signal !== undefined) signals.push(signal)
      return hangingResponse(signal)
    }
    const { bridge } = collectingBridge(fetchImpl, RUNNING_ORIGIN)
    bridge.handle({ type: 'dsh-fetch', id: 5, path: '/api/events.mux', method: 'GET', headers: {} })
    bridge.handle({ type: 'dsh-fetch', id: 6, path: '/api/events.host', method: 'GET', headers: {} })
    await settle()
    bridge.dispose()
    expect(signals).toHaveLength(2)
    expect(signals.every(s => s.aborted)).toBe(true)
  })
})
