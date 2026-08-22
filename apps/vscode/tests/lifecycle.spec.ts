/** Runtime command paths over fake generations, including bridge rebinding. */

import { describe, expect, it, vi } from 'vitest'
import type { BridgeResponseMessage } from '@deepseek-ai/dsh-client-connection/client'
import { ApiBridge } from '../src/bridge.ts'
import { RuntimeLifecycle, type ManagedServer } from '../src/lifecycle.ts'

class FakeRuntime implements ManagedServer {
  readonly start = vi.fn(async () => this.url!)
  readonly dispose = vi.fn(async () => {})

  constructor(readonly url: URL | undefined) {}
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('RuntimeLifecycle', () => {
  it('restarts with a replacement generation and routes retained bridge traffic to it', async () => {
    const first = new FakeRuntime(new URL('http://127.0.0.1:5101/'))
    const second = new FakeRuntime(new URL('http://127.0.0.1:5102/'))
    const generations = [first, second]
    const native: string[] = []
    const failures: unknown[] = []
    const lifecycle = new RuntimeLifecycle({
      createRuntime: () => generations.shift()!,
      startNative: () => { native.push('start') },
      stopNative: () => { native.push('stop') },
      onStartFailure: error => failures.push(error),
    })
    const fetched: string[] = []
    const posted: BridgeResponseMessage[] = []
    const bridge = new ApiBridge({
      origin: lifecycle.origin,
      post: message => posted.push(message),
      fetchImpl: async (input) => {
        fetched.push(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url)
        return new Response(null, { status: 204 })
      },
    })

    lifecycle.start()
    await settle()
    bridge.handle({ type: 'dsh-fetch', id: 1, path: '/api/host.describe', method: 'POST', headers: {} })
    await settle()

    await lifecycle.restart()
    await settle()
    bridge.handle({ type: 'dsh-fetch', id: 2, path: '/api/host.describe', method: 'POST', headers: {} })
    await settle()

    expect(first.dispose).toHaveBeenCalledTimes(1)
    expect(second.start).toHaveBeenCalledTimes(1)
    expect(fetched).toEqual([
      'http://127.0.0.1:5101/api/host.describe',
      'http://127.0.0.1:5102/api/host.describe',
    ])
    expect(native).toEqual(['start', 'stop', 'start'])
    expect(failures).toEqual([])
    expect(posted.filter(message => message.type === 'dsh-fetch-end').map(message => message.id)).toEqual([1, 2])
    await lifecycle.dispose()
  })

  it('does not report a superseded generation\'s startup rejection', async () => {
    let rejectFirst: ((error: Error) => void) | undefined
    const first = new FakeRuntime(undefined)
    first.start.mockImplementation(() => new Promise<URL>((_resolve, reject) => { rejectFirst = reject }))
    const second = new FakeRuntime(new URL('http://127.0.0.1:5202/'))
    const generations = [first, second]
    const onStartFailure = vi.fn()
    const lifecycle = new RuntimeLifecycle({
      createRuntime: () => generations.shift()!,
      startNative: () => {},
      stopNative: () => {},
      onStartFailure,
    })

    lifecycle.start()
    const restarting = lifecycle.restart()
    rejectFirst?.(new Error('cancelled by restart'))
    await restarting
    await settle()
    expect(onStartFailure).not.toHaveBeenCalled()
    await lifecycle.dispose()
  })

  it('coalesces restart requests and makes deactivate wait for teardown', async () => {
    let release: (() => void) | undefined
    const first = new FakeRuntime(new URL('http://127.0.0.1:5301/'))
    first.dispose.mockImplementation(() => new Promise<void>((resolve) => { release = resolve }))
    const second = new FakeRuntime(new URL('http://127.0.0.1:5302/'))
    const generations = [first, second]
    const lifecycle = new RuntimeLifecycle({
      createRuntime: () => generations.shift()!,
      startNative: () => {},
      stopNative: () => {},
      onStartFailure: () => {},
    })

    lifecycle.start()
    await settle()
    const restartA = lifecycle.restart()
    const restartB = lifecycle.restart()
    const deactivate = lifecycle.dispose()
    expect(restartA).toBe(restartB)
    expect(first.dispose).toHaveBeenCalledTimes(1)
    expect(second.start).not.toHaveBeenCalled()
    release?.()
    await Promise.all([restartA, deactivate])
    expect(second.start).not.toHaveBeenCalled()
  })
})
