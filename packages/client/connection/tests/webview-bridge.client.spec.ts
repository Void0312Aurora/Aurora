/**
 * PostMessageApiClient transport behavior over a fake embedder port: unary
 * round-trips ride the full base-client path (envelope wrap, zod parse), SSE
 * responses rebuild as streamed frames, aborts cross the port both before and
 * after the response head, and transport errors reject the calls that own
 * them. The extension-host side of the port is faked here; its real replay
 * loop lives with the VS Code extension.
 */

import { describe, expect, it, vi } from 'vitest'
import type {
  BridgeRequestMessage,
  BridgeResponseMessage,
  WebviewBridgePort,
} from '../src/client/webview-bridge.ts'
import {
  parseBridgeRequestMessage,
  parseBridgeResponseMessage,
  PostMessageApiClient,
  verifyWebviewBridgeProtocol,
} from '../src/client/webview-bridge.ts'

/** Exposes the protected transport for direct response-body lifecycle checks. */
class ProbeClient extends PostMessageApiClient {
  probeFetch(input: URL, init?: RequestInit): Promise<Response> {
    return this.doFetch(input, init)
  }
}

interface FakePort {
  sent: BridgeRequestMessage[]
  emit(message: BridgeResponseMessage): void
  /** Deliver a value the host would never send, exercising the parse boundary. */
  emitRaw(value: unknown): void
  listenerCount(): number
  port: {
    postMessage(message: BridgeRequestMessage): void
    onMessage(listener: (message: BridgeResponseMessage) => void): () => void
  }
}

function fakePort(onPost?: (message: BridgeRequestMessage) => void): FakePort {
  const sent: BridgeRequestMessage[] = []
  const listeners = new Set<(message: BridgeResponseMessage) => void>()
  const deliver = (value: unknown): void => {
    for (const listener of [...listeners]) listener(value as BridgeResponseMessage)
  }
  return {
    sent,
    emit: deliver,
    emitRaw: deliver,
    listenerCount: () => listeners.size,
    port: {
      postMessage: (message) => {
        sent.push(message)
        onPost?.(message)
      },
      onMessage: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
  }
}

function requestBodyOf(message: BridgeRequestMessage): { rpcId: string } {
  if (message.type !== 'dsh-fetch' || message.body === undefined) throw new Error('expected a dsh-fetch with a body')
  return JSON.parse(message.body) as { rpcId: string }
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

function throwUnknown(value: unknown): never {
  throw value
}

describe('PostMessageApiClient', () => {
  it('round-trips a unary call through the port with the full envelope path', async () => {
    const fake = fakePort()
    const client = new PostMessageApiClient(fake.port)
    const call = client.host.describe({})
    await settle()

    expect(fake.sent).toHaveLength(1)
    const start = fake.sent[0]!
    expect(start.type).toBe('dsh-fetch')
    if (start.type !== 'dsh-fetch') throw new Error('unreachable')
    expect(start.path).toBe('/api/host.describe')
    expect(start.method).toBe('POST')
    expect(start.headers['content-type']).toBe('application/json')

    const { rpcId } = requestBodyOf(start)
    const value = { protocolVersion: 1, version: 'v', cwd: '/w', attachedSessions: 0, canOpenPath: false }
    fake.emit({ id: start.id, type: 'dsh-fetch-head', status: 200 })
    fake.emit({
      id: start.id,
      type: 'dsh-fetch-chunk',
      chunk: JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }),
    })
    fake.emit({ id: start.id, type: 'dsh-fetch-end' })

    const response = await call
    expect(response.result).toEqual({ ok: true, value })
    expect(fake.listenerCount()).toBe(0)
  })

  it('streams SSE frames chunk by chunk, including a frame split across chunks', async () => {
    const fake = fakePort()
    const client = new PostMessageApiClient(fake.port)
    const abort = new AbortController()
    let opened = false
    const stream = client.events.mux({}, abort.signal, () => { opened = true })
    const frames: unknown[] = []
    const consumed = (async () => {
      for await (const frame of stream) frames.push(frame.payload)
    })()
    await settle()

    const start = fake.sent[0]!
    if (start.type !== 'dsh-fetch') throw new Error('expected the stream start')
    expect(start.path).toBe('/api/events.mux')
    fake.emit({ id: start.id, type: 'dsh-fetch-head', status: 200 })
    await settle()
    expect(opened).toBe(true)

    const frame = { type: 'server-request', rpcId: 'frame-1', method: 'events.mux', payload: { type: 'session/subscribed', sessionId: 's1', lastSeq: -1 } }
    const wire = `data: ${JSON.stringify(frame)}\n\n`
    fake.emit({ id: start.id, type: 'dsh-fetch-chunk', chunk: wire.slice(0, 24) })
    fake.emit({ id: start.id, type: 'dsh-fetch-chunk', chunk: wire.slice(24) })
    fake.emit({ id: start.id, type: 'dsh-fetch-end' })
    await consumed

    expect(frames).toEqual([{ type: 'session/subscribed', sessionId: 's1', lastSeq: -1 }])
  })

  it('drops its port listener after a completed unary round (no listener leak)', async () => {
    const fake = fakePort()
    const client = new PostMessageApiClient(fake.port)
    const call = client.sessions.list({})
    await settle()
    const start = fake.sent[0]!
    fake.emit({ id: start.id, type: 'dsh-fetch-head', status: 200 })
    fake.emit({ id: start.id, type: 'dsh-fetch-chunk', chunk: JSON.stringify({ type: 'server-response', rpcId: requestBodyOf(start).rpcId, result: { ok: true, value: { items: [] } } }) })
    fake.emit({ id: start.id, type: 'dsh-fetch-end' })
    await call
    expect(fake.listenerCount()).toBe(0)
  })

  it('drops its port listener and abort listener after a stream abort (no leak)', async () => {
    const fake = fakePort()
    const client = new PostMessageApiClient(fake.port)
    const abort = new AbortController()
    const stream = client.events.mux({}, abort.signal)
    const consumed = (async () => {
      for await (const _frame of stream) { /* drain until abort */ }
    })()
    await settle()
    const start = fake.sent[0]!
    fake.emit({ id: start.id, type: 'dsh-fetch-head', status: 200 })
    await settle()
    abort.abort()
    await expect(consumed).rejects.toThrow(/aborted/i)
    // The abort posts dsh-fetch-abort upstream and the doFetch cleanup drops
    // the port subscription (the leak the fix closes).
    expect(fake.sent.some(message => message.type === 'dsh-fetch-abort' && message.id === start.id)).toBe(true)
    expect(fake.listenerCount()).toBe(0)
  })

  it('posts dsh-fetch-abort and cleans up when the response body is cancelled directly', async () => {
    const fake = fakePort()
    const client = new ProbeClient(fake.port)
    const responsePromise = client.probeFetch(new URL('http://host/api/events.mux'))
    await settle()
    const start = fake.sent[0]!
    fake.emit({ id: start.id, type: 'dsh-fetch-head', status: 200 })
    const response = await responsePromise
    // A consumer that cancels the body (not via the request signal) must still
    // abort upstream and drop the port listener.
    await response.body?.cancel()
    expect(fake.sent.some(message => message.type === 'dsh-fetch-abort' && message.id === start.id)).toBe(true)
    expect(fake.listenerCount()).toBe(0)
  })

  it('sends dsh-fetch-abort and rejects when aborted before the head', async () => {
    const fake = fakePort()
    const client = new PostMessageApiClient(fake.port)
    const abort = new AbortController()
    const stream = client.events.host({}, abort.signal)
    const consumed = (async () => {
      for await (const _frame of stream) { /* drain until the abort rejection */ }
    })()
    await settle()

    const start = fake.sent[0]!
    if (start.type !== 'dsh-fetch') throw new Error('expected the stream start')
    abort.abort()
    await expect(consumed).rejects.toThrow(/aborted/i)
    expect(fake.sent.filter(message => message.type === 'dsh-fetch-abort')).toHaveLength(1)
    expect(fake.listenerCount()).toBe(0)

    fake.emit({ id: start.id, type: 'dsh-fetch-end' })
    expect(fake.listenerCount()).toBe(0)
  })

  it('fails the stream on a post-head abort', async () => {
    const fake = fakePort()
    const client = new PostMessageApiClient(fake.port)
    const abort = new AbortController()
    const stream = client.events.mux({}, abort.signal)
    const consumed = (async () => {
      for await (const _frame of stream) { /* drain until the abort error */ }
    })()
    await settle()

    const start = fake.sent[0]!
    fake.emit({ id: start.id, type: 'dsh-fetch-head', status: 200 })
    await settle()
    abort.abort()
    await expect(consumed).rejects.toThrow(/aborted/i)
    expect(fake.sent.filter(message => message.type === 'dsh-fetch-abort' && message.id === start.id)).toHaveLength(1)
    expect(fake.listenerCount()).toBe(0)

    fake.emit({ id: start.id, type: 'dsh-fetch-end' })
    expect(fake.listenerCount()).toBe(0)
  })

  it('rejects immediately on an already-aborted signal without starting a request', async () => {
    const fake = fakePort()
    const client = new PostMessageApiClient(fake.port)
    const aborted = AbortSignal.abort()
    const stream = client.events.mux({}, aborted)
    await expect((async () => {
      for await (const _frame of stream) { /* drain until the abort rejection */ }
    })()).rejects.toThrow(/aborted/i)
    expect(fake.sent).toEqual([])
    expect(fake.listenerCount()).toBe(0)
  })

  it('aborts upstream and cleans up when the response body is cancelled directly', async () => {
    const fake = fakePort()
    const client = new ProbeClient(fake.port)
    const abort = new AbortController()
    const responsePromise = client.probeFetch(new URL('http://host/api/events.mux'), { signal: abort.signal })
    await settle()

    const start = fake.sent[0]!
    if (start.type !== 'dsh-fetch') throw new Error('expected the stream start')
    fake.emit({ id: start.id, type: 'dsh-fetch-head', status: 200 })
    const response = await responsePromise
    await response.body?.cancel()
    abort.abort()

    expect(fake.sent.filter(message => message.type === 'dsh-fetch-abort' && message.id === start.id)).toHaveLength(1)
    expect(fake.listenerCount()).toBe(0)
  })

  it.each([new Error('port closed'), 'port closed'])('does not send an abort when the initial request post throws %s', async (failure) => {
    const listeners = new Set<(message: BridgeResponseMessage) => void>()
    const sent: BridgeRequestMessage[] = []
    const port = {
      postMessage(message: BridgeRequestMessage): void {
        if (message.type === 'dsh-fetch') throw failure
        sent.push(message)
      },
      onMessage(listener: (message: BridgeResponseMessage) => void): () => void {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
    const abort = new AbortController()
    const client = new ProbeClient(port)

    await expect(client.probeFetch(new URL('http://host/api/session.list'), { signal: abort.signal })).rejects.toThrow('port closed')
    abort.abort()

    expect(sent).toEqual([])
    expect(listeners.size).toBe(0)
  })

  it('contains an abort-delivery failure after rejecting the local request', async () => {
    const fake = fakePort((message) => {
      if (message.type === 'dsh-fetch-abort') throw new Error('abort port closed')
    })
    const abort = new AbortController()
    const client = new ProbeClient(fake.port)
    const response = client.probeFetch(new URL('http://host/api/events.mux'), { signal: abort.signal })
    await settle()

    abort.abort()

    await expect(response).rejects.toThrow(/aborted/i)
    expect(fake.sent.map(message => message.type)).toEqual(['dsh-fetch', 'dsh-fetch-abort'])
    expect(fake.listenerCount()).toBe(0)
  })

  it('defers a reentrant abort until the initial request post succeeds', async () => {
    const abort = new AbortController()
    const fake = fakePort((message) => {
      if (message.type === 'dsh-fetch') abort.abort()
    })
    const client = new ProbeClient(fake.port)

    await expect(client.probeFetch(new URL('http://host/api/session.list'), { signal: abort.signal }))
      .rejects.toThrow(/aborted/i)

    expect(fake.sent.map(message => message.type)).toEqual(['dsh-fetch', 'dsh-fetch-abort'])
    expect(fake.listenerCount()).toBe(0)
  })

  it('rejects the owning call on a pre-head transport error and ignores foreign ids', async () => {
    const fake = fakePort()
    const client = new PostMessageApiClient(fake.port)
    const call = client.sessions.list({})
    await settle()

    const start = fake.sent[0]!
    // A foreign id must not settle this call.
    fake.emit({ id: start.id + 999, type: 'dsh-fetch-error', message: 'someone else broke' })
    fake.emit({ id: start.id, type: 'dsh-fetch-error', message: 'server unreachable' })
    await expect(call).rejects.toThrow(/server unreachable/)
  })

  it('fails the owning call on a malformed message and aborts upstream', async () => {
    const fake = fakePort()
    const client = new PostMessageApiClient(fake.port)
    const call = client.sessions.list({})
    await settle()

    const start = fake.sent[0]!
    // Correlatable but malformed: the id parses, the status does not. The call
    // must fail rather than wait for a head that will never be valid.
    fake.emitRaw({ type: 'dsh-fetch-head', id: start.id, status: 42 })

    await expect(call).rejects.toThrow(/invalid bridge response: response status must be an integer/)
    expect(fake.sent.some(message => message.type === 'dsh-fetch-abort' && message.id === start.id)).toBe(true)
  })

  it('ignores a malformed message that carries no usable id', async () => {
    const fake = fakePort()
    const client = new PostMessageApiClient(fake.port)
    const call = client.sessions.list({})
    await settle()

    const start = fake.sent[0]!
    // No id survives parsing, so nothing identifies an owner to fail; the port
    // is shared, and guessing would settle an unrelated request.
    fake.emitRaw('garbage')
    fake.emitRaw({ type: 'dsh-fetch-head', status: 200 })
    await settle()

    let settled = false
    void call.finally(() => { settled = true })
    await settle()
    expect(settled).toBe(false)

    fake.emit({ id: start.id, type: 'dsh-fetch-head', status: 200 })
    fake.emit({ id: start.id, type: 'dsh-fetch-chunk', chunk: JSON.stringify({ type: 'server-response', rpcId: requestBodyOf(start).rpcId, result: { ok: true, value: { items: [] } } }) })
    fake.emit({ id: start.id, type: 'dsh-fetch-end' })
    expect((await call).result).toEqual({ ok: true, value: { items: [] } })
  })

  it('ignores a malformed message addressed to another in-flight request', async () => {
    const fake = fakePort()
    const client = new PostMessageApiClient(fake.port)
    const call = client.sessions.list({})
    await settle()

    const start = fake.sent[0]!
    fake.emitRaw({ type: 'dsh-fetch-chunk', id: start.id + 999, chunk: 42 })
    await settle()

    let settled = false
    void call.finally(() => { settled = true })
    await settle()
    expect(settled).toBe(false)

    fake.emit({ id: start.id, type: 'dsh-fetch-head', status: 200 })
    fake.emit({ id: start.id, type: 'dsh-fetch-chunk', chunk: JSON.stringify({ type: 'server-response', rpcId: requestBodyOf(start).rpcId, result: { ok: true, value: { items: [] } } }) })
    fake.emit({ id: start.id, type: 'dsh-fetch-end' })
    expect((await call).result).toEqual({ ok: true, value: { items: [] } })
  })

  it('errors the stream body on a post-head transport error', async () => {
    const fake = fakePort()
    const client = new PostMessageApiClient(fake.port)
    const abort = new AbortController()
    const stream = client.events.mux({}, abort.signal)
    const consumed = (async () => {
      for await (const _frame of stream) { /* drain until the transport error */ }
    })()
    await settle()

    const start = fake.sent[0]!
    fake.emit({ id: start.id, type: 'dsh-fetch-head', status: 200 })
    await settle()
    fake.emit({ id: start.id, type: 'dsh-fetch-error', message: 'pipe collapsed' })
    await expect(consumed).rejects.toThrow(/pipe collapsed/)
  })

  it('rejects duplicate response heads and aborts the upstream request once', async () => {
    const fake = fakePort((message) => {
      if (message.type === 'dsh-fetch-abort') {
        fake.emit({ id: message.id, type: 'dsh-fetch-head', status: 200 })
      }
    })
    const client = new ProbeClient(fake.port)
    const response = client.probeFetch(new URL('http://host/api/events.mux'))
    await settle()

    const start = fake.sent[0]!
    fake.emit({ id: start.id, type: 'dsh-fetch-head', status: 200 })
    const body = (await response).text()
    fake.emit({ id: start.id, type: 'dsh-fetch-head', status: 200 })

    await expect(body).rejects.toThrow(/duplicate response head/)
    expect(fake.sent.filter(message => message.type === 'dsh-fetch-abort')).toHaveLength(1)
    expect(fake.listenerCount()).toBe(0)
  })

  it.each([
    ['chunk', { type: 'dsh-fetch-chunk', chunk: 'orphan' }],
    ['end', { type: 'dsh-fetch-end' }],
  ] as const)('rejects a response %s received before its head', async (_kind, message) => {
    const fake = fakePort()
    const client = new ProbeClient(fake.port)
    const response = client.probeFetch(new URL('http://host/api/events.mux'))
    await settle()

    const start = fake.sent[0]!
    fake.emit({ id: start.id, ...message })

    await expect(response).rejects.toThrow(/preceded response head/)
    expect(fake.sent.filter(item => item.type === 'dsh-fetch-abort')).toHaveLength(1)
    expect(fake.listenerCount()).toBe(0)
  })

  it('cleans a synchronously completed response after subscription setup returns', async () => {
    const queuedId = 1
    let unsubscribed = false
    let posted = false
    const client = new ProbeClient({
      postMessage() { posted = true },
      onMessage(next) {
        next({ id: queuedId, type: 'dsh-fetch-head', status: 200 })
        next({ id: queuedId, type: 'dsh-fetch-end' })
        return () => { unsubscribed = true }
      },
    })

    const response = await client.probeFetch(new URL('http://host/api/session.list'))

    await expect(response.text()).resolves.toBe('')
    expect(unsubscribed).toBe(true)
    expect(posted).toBe(false)
  })

  it('surfaces a non-2xx head as the base transport failure', async () => {
    const fake = fakePort()
    const client = new PostMessageApiClient(fake.port)
    const call = client.sessions.list({})
    await settle()

    const start = fake.sent[0]!
    fake.emit({ id: start.id, type: 'dsh-fetch-head', status: 503 })
    await expect(call).rejects.toThrow(/HTTP 503/)
  })

  it('carries a signal-less user-paced call (the caller-signal-only unary policy)', async () => {
    // host.pickDirectory without a caller signal reaches doFetch with no
    // signal at all — the transport must not require one.
    const fake = fakePort()
    const client = new PostMessageApiClient(fake.port)
    const call = client.host.pickDirectory({})
    await settle()

    const start = fake.sent[0]!
    if (start.type !== 'dsh-fetch') throw new Error('expected the start')
    fake.emit({ id: start.id, type: 'dsh-fetch-head', status: 200 })
    fake.emit({ id: start.id, type: 'dsh-fetch-chunk', chunk: JSON.stringify({ type: 'server-response', rpcId: requestBodyOf(start).rpcId, result: { ok: true, value: { path: null } } }) })
    fake.emit({ id: start.id, type: 'dsh-fetch-end' })
    expect((await call).result).toEqual({ ok: true, value: { path: null } })
  })

  it('correlates concurrent requests by id', async () => {
    const fake = fakePort()
    const client = new PostMessageApiClient(fake.port)
    const first = client.sessions.list({})
    const second = client.host.describe({})
    await settle()

    const [a, b] = fake.sent
    if (a?.type !== 'dsh-fetch' || b?.type !== 'dsh-fetch') throw new Error('expected two starts')
    expect(a.id).not.toBe(b.id)

    // Answer the second request first: correlation must route by id, not order.
    const describeValue = { protocolVersion: 1, version: 'v', cwd: '/w', attachedSessions: 0, canOpenPath: false }
    fake.emit({ id: b.id, type: 'dsh-fetch-head', status: 200 })
    fake.emit({ id: b.id, type: 'dsh-fetch-chunk', chunk: JSON.stringify({ type: 'server-response', rpcId: requestBodyOf(b).rpcId, result: { ok: true, value: describeValue } }) })
    fake.emit({ id: b.id, type: 'dsh-fetch-end' })
    fake.emit({ id: a.id, type: 'dsh-fetch-head', status: 200 })
    fake.emit({ id: a.id, type: 'dsh-fetch-chunk', chunk: JSON.stringify({ type: 'server-response', rpcId: requestBodyOf(a).rpcId, result: { ok: true, value: { items: [] } } }) })
    fake.emit({ id: a.id, type: 'dsh-fetch-end' })

    expect((await second).result).toEqual({ ok: true, value: describeValue })
    expect((await first).result).toEqual({ ok: true, value: { items: [] } })
  })

  it('allocates distinct ids across clients sharing one port', async () => {
    const fake = fakePort()
    const firstClient = new PostMessageApiClient(fake.port)
    const secondClient = new PostMessageApiClient(fake.port)
    const first = firstClient.sessions.list({})
    const second = secondClient.host.describe({})
    await settle()

    const [a, b] = fake.sent
    if (a?.type !== 'dsh-fetch' || b?.type !== 'dsh-fetch') throw new Error('expected two starts')
    expect(a.id).not.toBe(b.id)

    const describeValue = { protocolVersion: 1, version: 'v', cwd: '/w', attachedSessions: 0, canOpenPath: false }
    fake.emit({ id: b.id, type: 'dsh-fetch-head', status: 200 })
    fake.emit({ id: b.id, type: 'dsh-fetch-chunk', chunk: JSON.stringify({ type: 'server-response', rpcId: requestBodyOf(b).rpcId, result: { ok: true, value: describeValue } }) })
    fake.emit({ id: b.id, type: 'dsh-fetch-end' })
    fake.emit({ id: a.id, type: 'dsh-fetch-head', status: 200 })
    fake.emit({ id: a.id, type: 'dsh-fetch-chunk', chunk: JSON.stringify({ type: 'server-response', rpcId: requestBodyOf(a).rpcId, result: { ok: true, value: { items: [] } } }) })
    fake.emit({ id: a.id, type: 'dsh-fetch-end' })

    expect((await second).result).toEqual({ ok: true, value: describeValue })
    expect((await first).result).toEqual({ ok: true, value: { items: [] } })
    expect(fake.listenerCount()).toBe(0)
  })

  it('keeps ids distinct across independent module evaluations sharing one port', async () => {
    vi.resetModules()
    const firstModule = await import('../src/client/webview-bridge.ts')
    vi.resetModules()
    const secondModule = await import('../src/client/webview-bridge.ts')
    const fake = fakePort()
    const first = new firstModule.PostMessageApiClient(fake.port).sessions.list({})
    const second = new secondModule.PostMessageApiClient(fake.port).host.describe({})
    await settle()

    const [a, b] = fake.sent
    if (a?.type !== 'dsh-fetch' || b?.type !== 'dsh-fetch') throw new Error('expected two starts')
    expect(a.id).not.toBe(b.id)

    let secondSettled = false
    void second.finally(() => { secondSettled = true })
    fake.emit({ id: a.id, type: 'dsh-fetch-head', status: 200 })
    fake.emit({ id: a.id, type: 'dsh-fetch-chunk', chunk: JSON.stringify({ type: 'server-response', rpcId: requestBodyOf(a).rpcId, result: { ok: true, value: { items: [] } } }) })
    fake.emit({ id: a.id, type: 'dsh-fetch-end' })
    expect((await first).result).toEqual({ ok: true, value: { items: [] } })
    await settle()
    expect(secondSettled).toBe(false)

    const describeValue = { protocolVersion: 1, version: 'v', cwd: '/w', attachedSessions: 0, canOpenPath: false }
    fake.emit({ id: b.id, type: 'dsh-fetch-head', status: 200 })
    fake.emit({ id: b.id, type: 'dsh-fetch-chunk', chunk: JSON.stringify({ type: 'server-response', rpcId: requestBodyOf(b).rpcId, result: { ok: true, value: describeValue } }) })
    fake.emit({ id: b.id, type: 'dsh-fetch-end' })
    expect((await second).result).toEqual({ ok: true, value: describeValue })
    expect(fake.listenerCount()).toBe(0)
  })

  it('reports a host.describe RPC failure during the protocol probe', async () => {
    const fake = fakePort()
    const check = verifyWebviewBridgeProtocol(fake.port)
    await settle()

    const start = fake.sent[0]!
    if (start.type !== 'dsh-fetch') throw new Error('expected the protocol probe')
    fake.emit({ id: start.id, type: 'dsh-fetch-head', status: 200 })
    fake.emit({
      id: start.id,
      type: 'dsh-fetch-chunk',
      chunk: JSON.stringify({
        type: 'server-response',
        rpcId: requestBodyOf(start).rpcId,
        result: { ok: false, error: { code: 'internal', message: 'probe failed', details: {} } },
      }),
    })
    fake.emit({ id: start.id, type: 'dsh-fetch-end' })

    await expect(check).resolves.toEqual({ ok: false, reason: 'host.describe failed: internal' })
  })

  it('describes a non-Error bridge rejection during the protocol probe', async () => {
    const port: WebviewBridgePort = {
      postMessage() {},
      onMessage() {
        return throwUnknown('bridge exploded')
      },
    }

    await expect(verifyWebviewBridgeProtocol(port)).resolves.toEqual({
      ok: false,
      reason: 'host.describe returned an incompatible response: bridge exploded',
    })
  })

  it('rejects a host whose protocolVersion differs from the bundled client', async () => {
    const fake = fakePort()
    const check = verifyWebviewBridgeProtocol(fake.port)
    await settle()

    const start = fake.sent[0]!
    if (start.type !== 'dsh-fetch') throw new Error('expected the protocol probe')
    const value = { protocolVersion: 99, version: 'v9', cwd: '/w', attachedSessions: 0, canOpenPath: false }
    fake.emit({ id: start.id, type: 'dsh-fetch-head', status: 200 })
    fake.emit({
      id: start.id,
      type: 'dsh-fetch-chunk',
      chunk: JSON.stringify({ type: 'server-response', rpcId: requestBodyOf(start).rpcId, result: { ok: true, value } }),
    })
    fake.emit({ id: start.id, type: 'dsh-fetch-end' })

    await expect(check).resolves.toEqual({ ok: false, reason: 'host protocolVersion 99 != client 1' })
  })

  it('accepts a matching host and reports its version', async () => {
    const fake = fakePort()
    const check = verifyWebviewBridgeProtocol(fake.port)
    await settle()

    const start = fake.sent[0]!
    if (start.type !== 'dsh-fetch') throw new Error('expected the protocol probe')
    const value = { protocolVersion: 1, version: '0.1.0-rc.5', cwd: '/w', attachedSessions: 0, canOpenPath: false }
    fake.emit({ id: start.id, type: 'dsh-fetch-head', status: 200 })
    fake.emit({
      id: start.id,
      type: 'dsh-fetch-chunk',
      chunk: JSON.stringify({ type: 'server-response', rpcId: requestBodyOf(start).rpcId, result: { ok: true, value } }),
    })
    fake.emit({ id: start.id, type: 'dsh-fetch-end' })

    await expect(check).resolves.toEqual({ ok: true, hostVersion: '0.1.0-rc.5' })
  })
})

/**
 * The parsers are the wire boundary for untrusted postMessage values: the
 * extension host reads webview requests with one, the webview reads host
 * responses with the other. A malformed value must be rejected with a reason,
 * and correlatably whenever its id survived parsing, so the owning request can
 * be failed instead of hanging.
 */
describe('parseBridgeRequestMessage', () => {
  it.each([
    ['a non-object', 'not-an-object', 'message must be an object'],
    ['an array', [], 'message must be an object'],
    ['null', null, 'message must be an object'],
  ])('rejects %s without an id to correlate', (_label, value, reason) => {
    expect(parseBridgeRequestMessage(value)).toEqual({ ok: false, reason })
  })

  it.each([
    ['a missing id', { type: 'dsh-fetch' }],
    ['a non-numeric id', { type: 'dsh-fetch', id: '1' }],
    ['a fractional id', { type: 'dsh-fetch', id: 1.5 }],
    ['a negative id', { type: 'dsh-fetch', id: -1 }],
    ['an unsafe integer id', { type: 'dsh-fetch', id: Number.MAX_SAFE_INTEGER + 2 }],
  ])('rejects %s as uncorrelatable', (_label, value) => {
    expect(parseBridgeRequestMessage(value))
      .toEqual({ ok: false, reason: 'id must be a non-negative safe integer' })
  })

  it('accepts an abort by id alone, discarding any other fields', () => {
    expect(parseBridgeRequestMessage({ type: 'dsh-fetch-abort', id: 7, path: '/api/x' }))
      .toEqual({ ok: true, message: { type: 'dsh-fetch-abort', id: 7 } })
  })

  it('rejects an unknown type but keeps the id correlatable', () => {
    expect(parseBridgeRequestMessage({ type: 'dsh-evict', id: 3 }))
      .toEqual({ ok: false, id: 3, reason: 'unknown request message type' })
  })

  it.each([
    ['a non-string path', { type: 'dsh-fetch', id: 1, path: 1, method: 'GET', headers: {} }],
    ['a non-string method', { type: 'dsh-fetch', id: 1, path: '/api/x', method: 1, headers: {} }],
    ['missing headers', { type: 'dsh-fetch', id: 1, path: '/api/x', method: 'GET' }],
    ['array headers', { type: 'dsh-fetch', id: 1, path: '/api/x', method: 'GET', headers: [] }],
    ['a non-string header value', { type: 'dsh-fetch', id: 1, path: '/api/x', method: 'GET', headers: { accept: 1 } }],
  ])('rejects a fetch with %s', (_label, value) => {
    expect(parseBridgeRequestMessage(value)).toEqual({
      ok: false,
      id: 1,
      reason: 'fetch path, method, and string-valued headers are required',
    })
  })

  it('rejects a non-string body', () => {
    expect(parseBridgeRequestMessage({ type: 'dsh-fetch', id: 1, path: '/api/x', method: 'POST', headers: {}, body: 1 }))
      .toEqual({ ok: false, id: 1, reason: 'fetch body must be a string when present' })
  })

  it('accepts a bodyless fetch without inventing a body field', () => {
    const parsed = parseBridgeRequestMessage({ type: 'dsh-fetch', id: 0, path: '/api/x', method: 'GET', headers: {} })

    expect(parsed).toEqual({ ok: true, message: { type: 'dsh-fetch', id: 0, path: '/api/x', method: 'GET', headers: {} } })
    expect(parsed.ok && 'body' in parsed.message).toBe(false)
  })

  it('accepts a fetch carrying a body and string headers', () => {
    expect(parseBridgeRequestMessage({
      type: 'dsh-fetch', id: 2, path: '/api/x?a=1', method: 'POST', headers: { accept: 'text/event-stream' }, body: '{}',
    })).toEqual({
      ok: true,
      message: {
        type: 'dsh-fetch', id: 2, path: '/api/x?a=1', method: 'POST', headers: { accept: 'text/event-stream' }, body: '{}',
      },
    })
  })
})

describe('parseBridgeResponseMessage', () => {
  it.each([
    ['a non-object', 'nope'],
    ['an array', []],
  ])('rejects %s without an id to correlate', (_label, value) => {
    expect(parseBridgeResponseMessage(value)).toEqual({ ok: false, reason: 'message must be an object' })
  })

  it('rejects an uncorrelatable id', () => {
    expect(parseBridgeResponseMessage({ type: 'dsh-fetch-end', id: -3 }))
      .toEqual({ ok: false, reason: 'id must be a non-negative safe integer' })
  })

  it.each([
    ['a non-numeric status', { type: 'dsh-fetch-head', id: 1, status: '200' }],
    ['a fractional status', { type: 'dsh-fetch-head', id: 1, status: 200.5 }],
    ['a status below 200', { type: 'dsh-fetch-head', id: 1, status: 199 }],
    ['a status above 599', { type: 'dsh-fetch-head', id: 1, status: 600 }],
  ])('rejects a head with %s', (_label, value) => {
    expect(parseBridgeResponseMessage(value)).toEqual({
      ok: false,
      id: 1,
      reason: 'response status must be an integer from 200 through 599',
    })
  })

  it.each([200, 404, 599])('accepts an in-range head status %i', (status) => {
    expect(parseBridgeResponseMessage({ type: 'dsh-fetch-head', id: 4, status }))
      .toEqual({ ok: true, message: { type: 'dsh-fetch-head', id: 4, status } })
  })

  it('rejects a non-string chunk and accepts a string one', () => {
    expect(parseBridgeResponseMessage({ type: 'dsh-fetch-chunk', id: 5, chunk: 1 }))
      .toEqual({ ok: false, id: 5, reason: 'response chunk must be a string' })
    expect(parseBridgeResponseMessage({ type: 'dsh-fetch-chunk', id: 5, chunk: 'data: {}' }))
      .toEqual({ ok: true, message: { type: 'dsh-fetch-chunk', id: 5, chunk: 'data: {}' } })
  })

  it('accepts an end by id alone', () => {
    expect(parseBridgeResponseMessage({ type: 'dsh-fetch-end', id: 6 }))
      .toEqual({ ok: true, message: { type: 'dsh-fetch-end', id: 6 } })
  })

  it('rejects a non-string error message and accepts a string one', () => {
    expect(parseBridgeResponseMessage({ type: 'dsh-fetch-error', id: 8, message: {} }))
      .toEqual({ ok: false, id: 8, reason: 'response error message must be a string' })
    expect(parseBridgeResponseMessage({ type: 'dsh-fetch-error', id: 8, message: 'boom' }))
      .toEqual({ ok: true, message: { type: 'dsh-fetch-error', id: 8, message: 'boom' } })
  })

  it('rejects an unknown type but keeps the id correlatable', () => {
    expect(parseBridgeResponseMessage({ type: 'dsh-fetch-teapot', id: 9 }))
      .toEqual({ ok: false, id: 9, reason: 'unknown response message type' })
  })
})
