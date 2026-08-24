/**
 * ActiveSessionTracker over a fake host stream: it adopts the first added
 * session, a running flip becomes the active one, removing the active session
 * clears it, and a dropped stream reopens. The client is injected; no server.
 */

import { describe, expect, it } from 'vitest'
import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import type { HostFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionSummary } from '@deepseek-ai/dsh-host-apiproxy/api'
import { ActiveSessionTracker } from '../src/active-session.ts'

function fakeHostStream(options: {
  lists?: SessionSummary[][]
  list?: (signal: AbortSignal | undefined) => ReturnType<IApiClient['sessions']['list']>
} = {}) {
  let push: ((frame: RpcRequest<HostFrame>) => void) | undefined
  let fail: ((error: Error) => void) | undefined
  let listCalls = 0
  const client = {
    events: {
      mux: () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ value: undefined as never, done: true }) }) }),
      host: (_payload: unknown, signal: AbortSignal): AsyncIterable<RpcRequest<HostFrame>> => ({
        [Symbol.asyncIterator]: () => {
          const queue: RpcRequest<HostFrame>[] = []
          let waiting: ((r: IteratorResult<RpcRequest<HostFrame>>) => void) | undefined
          let rejectNext: ((e: Error) => void) | undefined
          push = (frame) => {
            if (waiting !== undefined) { waiting({ value: frame, done: false }); waiting = undefined }
            else queue.push(frame)
          }
          fail = (error) => { if (rejectNext !== undefined) { rejectNext(error); rejectNext = undefined } }
          signal.addEventListener('abort', () => {
            if (waiting !== undefined) { waiting({ value: undefined as never, done: true }); waiting = undefined }
          }, { once: true })
          return {
            next: () => new Promise<IteratorResult<RpcRequest<HostFrame>>>((resolve, reject) => {
              if (queue.length > 0) { resolve({ value: queue.shift()!, done: false }); return }
              waiting = resolve
              rejectNext = reject
            }),
          }
        },
      }),
    },
    sessions: {
      list: (_payload: unknown, signal?: AbortSignal) => {
        listCalls++
        if (options.list !== undefined) return options.list(signal)
        const lists = options.lists ?? [[]]
        const items = lists[Math.min(listCalls - 1, lists.length - 1)] ?? []
        return Promise.resolve({ rpcId: 'list' as never, result: { ok: true as const, value: { items } } })
      },
    },
  }
  return {
    client,
    listCalls: () => listCalls,
    emit: (frame: HostFrame) => push?.({ rpcId: 'h' as never, payload: frame }),
    failStream: (error: Error) => fail?.(error),
  }
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('ActiveSessionTracker', () => {
  it('adopts the first added session and prefers a running flip', async () => {
    const fake = fakeHostStream()
    const changes: Array<[string | undefined, string | undefined]> = []
    const tracker = new ActiveSessionTracker({
      client: fake.client,
      log: () => {},
      onActiveChanged: (previous, current) => { changes.push([previous, current]) },
    })
    void tracker.run()
    await settle()
    expect(tracker.active()).toBeUndefined()

    fake.emit({ type: 'host/session-added', sessionId: 's1' as never, blank: true })
    await settle()
    expect(tracker.active()).toBe('s1')

    fake.emit({ type: 'host/session-added', sessionId: 's2' as never, blank: true })
    await settle()
    expect(tracker.active()).toBe('s1') // first-added stays until a running flip

    fake.emit({ type: 'host/session-status', sessionId: 's2' as never, running: true })
    await settle()
    expect(tracker.active()).toBe('s2')
    expect(changes).toEqual([[undefined, 's1'], ['s1', 's2']])
    tracker.dispose()
  })

  it('clears the active id when the active session is removed', async () => {
    const fake = fakeHostStream()
    const tracker = new ActiveSessionTracker({ client: fake.client, log: () => {} })
    void tracker.run()
    await settle()
    fake.emit({ type: 'host/session-status', sessionId: 's1' as never, running: true })
    await settle()
    expect(tracker.active()).toBe('s1')
    fake.emit({ type: 'host/session-removed', sessionId: 's1' as never })
    await settle()
    expect(tracker.active()).toBeUndefined()
    tracker.dispose()
  })

  it('reopens the host stream after a drop', async () => {
    const fake = fakeHostStream({ lists: [
      [{ sessionId: 's1' as never, updatedAt: 1, running: false, blank: false }],
      [{ sessionId: 's9' as never, updatedAt: 2, running: true, blank: false }],
    ] })
    const tracker = new ActiveSessionTracker({ client: fake.client, log: () => {}, reconnectMs: 1 })
    void tracker.run()
    await settle()
    expect(tracker.active()).toBe('s1')
    fake.failStream(new Error('lost'))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(tracker.active()).toBe('s9')
    expect(fake.listCalls()).toBeGreaterThanOrEqual(2)
    tracker.dispose()
  })

  it('replays stream increments received while the reconnect baseline is pending', async () => {
    let resolveList!: (value: Awaited<ReturnType<IApiClient['sessions']['list']>>) => void
    const pendingList = new Promise<Awaited<ReturnType<IApiClient['sessions']['list']>>>((resolve) => { resolveList = resolve })
    const fake = fakeHostStream({ list: () => pendingList })
    const tracker = new ActiveSessionTracker({ client: fake.client, log: () => {} })
    void tracker.run()
    await settle()

    fake.emit({ type: 'host/session-added', sessionId: 'added' as never, blank: true })
    fake.emit({ type: 'host/session-status', sessionId: 'running' as never, running: true })
    fake.emit({ type: 'host/session-removed', sessionId: 'running' as never })
    resolveList({
      rpcId: 'list' as never,
      result: { ok: true, value: { items: [{ sessionId: 'baseline' as never, updatedAt: 3, running: false, blank: false }] } },
    })
    await settle()
    expect(tracker.active()).toBeUndefined()
    tracker.dispose()
  })
})
