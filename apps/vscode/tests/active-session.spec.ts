/**
 * ActiveSessionTracker over a fake host stream: it adopts the first added
 * session, a running flip becomes the active one, removing the active session
 * clears it, and a dropped stream reopens. The client is injected; no server.
 */

import { describe, expect, it } from 'vitest'
import type { HostFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { ActiveSessionTracker } from '../src/active-session.ts'

function fakeHostStream() {
  let push: ((frame: RpcRequest<HostFrame>) => void) | undefined
  let fail: ((error: Error) => void) | undefined
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
  }
  return {
    client,
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
    const tracker = new ActiveSessionTracker({ client: fake.client, log: () => {} })
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
    const fake = fakeHostStream()
    const tracker = new ActiveSessionTracker({ client: fake.client, log: () => {}, reconnectMs: 1 })
    void tracker.run()
    await settle()
    fake.failStream(new Error('lost'))
    await new Promise(resolve => setTimeout(resolve, 10))
    fake.emit({ type: 'host/session-status', sessionId: 's9' as never, running: true })
    await settle()
    expect(tracker.active()).toBe('s9')
    tracker.dispose()
  })
})
