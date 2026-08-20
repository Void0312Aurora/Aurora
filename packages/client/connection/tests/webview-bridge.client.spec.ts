import { describe, expect, it } from 'vitest'
import { PostMessageApiClient, type WebviewBridgePort } from '../src/client/webview-bridge.ts'

class TestClient extends PostMessageApiClient {
  request(path: string, init?: RequestInit): Promise<Response> {
    return this.doFetch(new URL(path, 'http://127.0.0.1:4321'), init)
  }
}

function port(): {
  bridge: WebviewBridgePort
  sent: Array<Parameters<WebviewBridgePort['postMessage']>[0]>
  emit: (message: unknown) => void
  listenerCount: () => number
} {
  const sent: Array<Parameters<WebviewBridgePort['postMessage']>[0]> = []
  const listeners = new Set<(message: unknown) => void>()
  return {
    sent,
    bridge: {
      postMessage: (message) => { sent.push(message) },
      onMessage: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    emit: (message) => { for (const listener of [...listeners]) listener(message) },
    listenerCount: () => listeners.size,
  }
}

describe('PostMessageApiClient', () => {
  it('rebuilds a streamed response and preserves request metadata', async () => {
    const channel = port()
    const response = new TestClient(channel.bridge).request('/api/session.list?x=1', {
      method: 'POST',
      headers: { 'x-test': 'yes' },
      body: '{}',
    })
    const request = channel.sent[0]
    expect(request).toMatchObject({
      type: 'dsh-fetch', path: '/api/session.list?x=1', method: 'POST',
      headers: { 'x-test': 'yes' }, body: '{}',
    })
    if (request?.type !== 'dsh-fetch') throw new Error('bridge request was not sent')
    channel.emit({ type: 'dsh-fetch-head', id: request.id, status: 200 })
    channel.emit({ type: 'dsh-fetch-chunk', id: request.id, chunk: '{"ok":' })
    channel.emit({ type: 'dsh-fetch-chunk', id: request.id, chunk: 'true}' })
    channel.emit({ type: 'dsh-fetch-end', id: request.id })
    expect(await (await response).text()).toBe('{"ok":true}')
  })

  it('sends an abort for a cancelled request', async () => {
    const channel = port()
    const controller = new AbortController()
    const pending = new TestClient(channel.bridge).request('/api/events/mux', { signal: controller.signal })
    const request = channel.sent[0]
    if (request?.type !== 'dsh-fetch') throw new Error('bridge request was not sent')
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(channel.sent.at(-1)).toEqual({ type: 'dsh-fetch-abort', id: request.id })
    expect(channel.listenerCount()).toBe(0)
  })

  it('rejects an already-aborted request without starting a bridge fetch', async () => {
    const channel = port()
    const pending = new TestClient(channel.bridge).request('/api/events/mux', {
      signal: AbortSignal.abort(),
    })
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(channel.sent.filter(message => message.type === 'dsh-fetch')).toHaveLength(0)
    expect(channel.sent.filter(message => message.type === 'dsh-fetch-abort')).toHaveLength(0)
    expect(channel.listenerCount()).toBe(0)
  })

  it('propagates direct ReadableStream cancellation and removes listeners', async () => {
    const channel = port()
    const pending = new TestClient(channel.bridge).request('/api/events/mux')
    const request = channel.sent[0]
    if (request?.type !== 'dsh-fetch') throw new Error('bridge request was not sent')
    channel.emit({ type: 'dsh-fetch-head', id: request.id, status: 200 })
    const response = await pending
    await response.body?.cancel()
    expect(channel.sent.at(-1)).toEqual({ type: 'dsh-fetch-abort', id: request.id })
    expect(channel.listenerCount()).toBe(0)
  })

  it('propagates an AbortSignal after the response head and errors the body', async () => {
    const channel = port()
    const controller = new AbortController()
    const pending = new TestClient(channel.bridge).request('/api/events/mux', { signal: controller.signal })
    const request = channel.sent[0]
    if (request?.type !== 'dsh-fetch') throw new Error('bridge request was not sent')
    channel.emit({ type: 'dsh-fetch-head', id: request.id, status: 200 })
    const response = await pending
    controller.abort()
    await expect(response.text()).rejects.toMatchObject({ name: 'AbortError' })
    expect(channel.sent.at(-1)).toEqual({ type: 'dsh-fetch-abort', id: request.id })
    expect(channel.listenerCount()).toBe(0)
  })

  it('rejects malformed and duplicate response frames for the owning request', async () => {
    const channel = port()
    const pending = new TestClient(channel.bridge).request('/api/session.list')
    const request = channel.sent[0]
    if (request?.type !== 'dsh-fetch') throw new Error('bridge request was not sent')
    channel.emit({ type: 'dsh-fetch-head', id: request.id, status: 200 })
    channel.emit({ type: 'dsh-fetch-head', id: request.id, status: 200 })
    const response = await pending
    await expect(response.text()).rejects.toThrow(/duplicate response head/)
    expect(channel.sent.at(-1)).toEqual({ type: 'dsh-fetch-abort', id: request.id })
    expect(channel.listenerCount()).toBe(0)
  })

  it('rejects a chunk before the response head instead of orphaning the fetch', async () => {
    const channel = port()
    const pending = new TestClient(channel.bridge).request('/api/session.list')
    const request = channel.sent[0]
    if (request?.type !== 'dsh-fetch') throw new Error('bridge request was not sent')
    channel.emit({ type: 'dsh-fetch-chunk', id: request.id, chunk: 'bad' })
    await expect(pending).rejects.toThrow(/preceded response head/)
    expect(channel.sent.at(-1)).toEqual({ type: 'dsh-fetch-abort', id: request.id })
    expect(channel.listenerCount()).toBe(0)
  })

  it('routes a malformed matching frame to the owning request and ignores foreign ids', async () => {
    const channel = port()
    const pending = new TestClient(channel.bridge).request('/api/session.list')
    const request = channel.sent[0]
    if (request?.type !== 'dsh-fetch') throw new Error('bridge request was not sent')
    channel.emit({ type: 'dsh-fetch-chunk', id: request.id + 1, chunk: 42 })
    channel.emit({ type: 'dsh-fetch-chunk', id: request.id, chunk: 42 })
    await expect(pending).rejects.toThrow(/invalid bridge response/)
    expect(channel.sent.at(-1)).toEqual({ type: 'dsh-fetch-abort', id: request.id })
    expect(channel.listenerCount()).toBe(0)
  })
})
