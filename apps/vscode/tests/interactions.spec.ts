/**
 * NativeInteractions frame handling over a fake client + fake UI: approvals and
 * questions reach the UI (approvals enriched by the cached tool call), answers
 * respond on the request's envelope rpcId with the right payload, a
 * resolved-elsewhere frame closes an open prompt via its abort signal, a
 * `dismissed` outcome sends no answer, and a dropped stream reopens. The wire
 * client and the editor UI are both injected; no server runs.
 */

import { describe, expect, it, vi } from 'vitest'
import type { ClientResponse, MuxFrame, RpcReceipt, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { NativeInteractions, type NativeUi } from '../src/interactions.ts'

/** A hand-driven mux stream plus a respond spy, matching the client subset the consumer uses. */
function fakeClient() {
  let push: ((frame: RpcRequest<MuxFrame>) => void) | undefined
  let close: (() => void) | undefined
  let fail: ((error: Error) => void) | undefined
  const responses: ClientResponse[] = []
  const client = {
    events: {
      mux: (_payload: unknown, signal: AbortSignal): AsyncIterable<RpcRequest<MuxFrame>> => ({
        [Symbol.asyncIterator]: () => {
          const queue: RpcRequest<MuxFrame>[] = []
          let waiting: ((r: IteratorResult<RpcRequest<MuxFrame>>) => void) | undefined
          let rejectNext: ((e: Error) => void) | undefined
          let done = false
          const emit = (frame: RpcRequest<MuxFrame>): void => {
            if (waiting !== undefined) { waiting({ value: frame, done: false }); waiting = undefined }
            else queue.push(frame)
          }
          push = emit
          close = () => {
            done = true
            if (waiting !== undefined) { waiting({ value: undefined as never, done: true }); waiting = undefined }
          }
          fail = (error) => { if (rejectNext !== undefined) { rejectNext(error); rejectNext = undefined } }
          signal.addEventListener('abort', () => { close?.() }, { once: true })
          return {
            next: () => new Promise<IteratorResult<RpcRequest<MuxFrame>>>((resolve, reject) => {
              if (queue.length > 0) { resolve({ value: queue.shift()!, done: false }); return }
              if (done) { resolve({ value: undefined as never, done: true }); return }
              waiting = resolve
              rejectNext = reject
            }),
          }
        },
      }),
      host: () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ value: undefined as never, done: true }) }) }),
    },
    respond: (message: ClientResponse): Promise<RpcReceipt> => {
      responses.push(message)
      return Promise.resolve({ accepted: true })
    },
  }
  return {
    client,
    responses,
    emit: (frame: RpcRequest<MuxFrame>) => push?.(frame),
    endStream: () => close?.(),
    failStream: (error: Error) => fail?.(error),
  }
}

function envelope(rpcId: string, payload: MuxFrame): RpcRequest<MuxFrame> {
  return { rpcId: rpcId as RpcRequest<MuxFrame>['rpcId'], payload }
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('NativeInteractions', () => {
  it('answers an approval on the request envelope rpcId, enriched by the cached call', async () => {
    const fake = fakeClient()
    const prompts: Parameters<NativeUi['confirmApproval']>[0][] = []
    const ui: NativeUi = {
      confirmApproval: (prompt) => { prompts.push(prompt); return Promise.resolve('allowed-once') },
      askQuestions: async () => undefined,
    }
    const native = new NativeInteractions({ client: fake.client, ui, log: () => {} })
    void native.run()
    await settle()

    // A tool call arrives first, with its diff view — the approval enriches from it.
    fake.emit(envelope('evt-1', {
      type: 'session/event',
      sessionId: 's1' as never,
      event: { type: 'tool/call', seq: 1, time: 0, data: { turn: 0, step: 0, callId: 'c1', name: 'write', arguments: '{}' } } as never,
      view: { for: 'call', view: { card: 'diff', title: 'Write a.ts', diffs: [{ path: 'a.ts', oldText: null, newText: 'x' }] } },
    }))
    fake.emit(envelope('req-approve-1', {
      type: 'approval/requested', sessionId: 's1' as never, approvalId: 'ap1' as never, toolName: 'write', callId: 'c1' as never, reason: 'writes a file',
    }))
    await settle()

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({ sessionId: 's1', toolName: 'write', reason: 'writes a file', call: { card: 'diff', title: 'Write a.ts' } })
    expect(fake.responses).toEqual([{
      type: 'client-response',
      rpcId: 'req-approve-1',
      result: { ok: true, value: { sessionId: 's1', approvalId: 'ap1', outcome: 'allowed-once' } },
    }])
    native.dispose()
  })

  it('sends no answer when the approval is dismissed', async () => {
    const fake = fakeClient()
    const ui: NativeUi = { confirmApproval: async () => 'dismissed', askQuestions: async () => undefined }
    const native = new NativeInteractions({ client: fake.client, ui, log: () => {} })
    void native.run()
    await settle()
    fake.emit(envelope('req-approve-2', { type: 'approval/requested', sessionId: 's1' as never, approvalId: 'ap2' as never, toolName: 'bash' }))
    await settle()
    expect(fake.responses).toEqual([])
    native.dispose()
  })

  it('closes an open approval when a resolved frame arrives (answered elsewhere)', async () => {
    const fake = fakeClient()
    let observedSignal: AbortSignal | undefined
    const ui: NativeUi = {
      confirmApproval: (_prompt, signal) => new Promise((resolve) => {
        observedSignal = signal
        signal.addEventListener('abort', () => { resolve('dismissed') }, { once: true })
      }),
      askQuestions: async () => undefined,
    }
    const native = new NativeInteractions({ client: fake.client, ui, log: () => {} })
    void native.run()
    await settle()
    fake.emit(envelope('req-approve-3', { type: 'approval/requested', sessionId: 's1' as never, approvalId: 'ap3' as never, toolName: 'bash' }))
    await settle()
    expect(observedSignal?.aborted).toBe(false)
    fake.emit(envelope('evt-resolved', { type: 'approval/resolved', sessionId: 's1' as never, approvalId: 'ap3' as never, outcome: 'allowed-once' }))
    await settle()
    expect(observedSignal?.aborted).toBe(true)
    expect(fake.responses).toEqual([])
    native.dispose()
  })

  it('answers a question batch on the envelope rpcId', async () => {
    const fake = fakeClient()
    const ui: NativeUi = {
      confirmApproval: async () => 'dismissed',
      askQuestions: async items => ({ answers: items.map(item => ({ id: item.id, selected: [item.options?.[0]?.label ?? ''] })) }),
    }
    const native = new NativeInteractions({ client: fake.client, ui, log: () => {} })
    void native.run()
    await settle()
    fake.emit(envelope('req-q-1', {
      type: 'question/requested',
      sessionId: 's1' as never,
      questions: [{ id: 'q1', question: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }],
    }))
    await settle()
    expect(fake.responses).toEqual([{
      type: 'client-response',
      rpcId: 'req-q-1',
      result: { ok: true, value: { sessionId: 's1', answer: { answers: [{ id: 'q1', selected: ['A'] }] } } },
    }])
    native.dispose()
  })

  it('reopens the stream after a drop (pending frames replay on reopen)', async () => {
    const fake = fakeClient()
    const confirmApproval = vi.fn(async () => 'rejected' as const)
    const ui: NativeUi = { confirmApproval, askQuestions: async () => undefined }
    const native = new NativeInteractions({ client: fake.client, ui, log: () => {}, reconnectMs: 1 })
    void native.run()
    await settle()
    fake.failStream(new Error('connection lost'))
    await new Promise(resolve => setTimeout(resolve, 10))
    // The reopened stream replays the pending approval, which the consumer answers.
    fake.emit(envelope('req-approve-4', { type: 'approval/requested', sessionId: 's1' as never, approvalId: 'ap4' as never, toolName: 'bash' }))
    await settle()
    expect(confirmApproval).toHaveBeenCalledTimes(1)
    native.dispose()
  })
})
