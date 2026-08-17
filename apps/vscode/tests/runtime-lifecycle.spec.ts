import { describe, expect, it, vi } from 'vitest'
import { RuntimeLifecycle, type ManagedRuntime } from '../src/runtime-lifecycle.ts'

interface Deferred {
  promise: Promise<void>
  resolve(): void
  reject(error: unknown): void
}

function deferred(): Deferred {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

class FakeRuntime implements ManagedRuntime {
  readonly ready = deferred()
  readonly disposed = deferred()
  disposeCalls = 0
  isDisposed = false

  start(): Promise<void> {
    return this.ready.promise
  }

  async dispose(): Promise<void> {
    this.disposeCalls++
    this.isDisposed = true
    await this.disposed.promise
  }
}

function harness() {
  const runtimes: FakeRuntime[] = []
  const ready: FakeRuntime[] = []
  const errors: unknown[] = []
  const lifecycle = new RuntimeLifecycle({
    create: () => {
      const runtime = new FakeRuntime()
      runtimes.push(runtime)
      return runtime
    },
    onReady: (runtime) => { ready.push(runtime) },
    onStartError: (error) => { errors.push(error) },
  })
  return { lifecycle, runtimes, ready, errors }
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('RuntimeLifecycle', () => {
  it('serializes concurrent restarts and disposes every replaced runtime', async () => {
    const { lifecycle, runtimes } = harness()
    await lifecycle.start()
    const first = runtimes[0]!
    first.ready.resolve()
    await settle()

    const restartA = lifecycle.restart()
    const restartB = lifecycle.restart()
    await settle()
    expect(first.disposeCalls).toBe(1)
    expect(runtimes).toHaveLength(1)

    first.disposed.resolve()
    await restartA
    const second = runtimes[1]!
    await settle()
    expect(second.disposeCalls).toBe(1)
    second.disposed.resolve()
    await restartB

    expect(runtimes).toHaveLength(3)
    expect(lifecycle.current).toBe(runtimes[2])
  })

  it('prevents a restart racing deactivation from launching a replacement', async () => {
    const { lifecycle, runtimes } = harness()
    await lifecycle.start()
    const first = runtimes[0]!
    const restarting = lifecycle.restart()
    await settle()
    const deactivating = lifecycle.deactivate()
    first.disposed.resolve()
    await Promise.all([restarting, deactivating])

    expect(runtimes).toHaveLength(1)
    expect(lifecycle.current).toBeUndefined()
    await lifecycle.start()
    expect(runtimes).toHaveLength(1)
  })

  it('ignores readiness that settles after deactivation claimed the runtime', async () => {
    const { lifecycle, runtimes, ready } = harness()
    await lifecycle.start()
    const first = runtimes[0]!
    const deactivating = lifecycle.deactivate()
    first.ready.resolve()
    first.disposed.resolve()
    await deactivating
    await settle()
    expect(ready).toEqual([])
  })

  it('detaches and disposes a genuine startup failure before reporting it', async () => {
    const { lifecycle, runtimes, errors } = harness()
    await lifecycle.start()
    const first = runtimes[0]!
    first.ready.reject(new Error('not ready'))
    await settle()
    expect(first.disposeCalls).toBe(1)
    expect(lifecycle.current).toBeUndefined()
    first.disposed.resolve()
    await vi.waitFor(() => { expect(errors).toHaveLength(1) })
    expect(errors[0]).toEqual(new Error('not ready'))
  })

  it('reports a construction failure without publishing a runtime', async () => {
    const errors: unknown[] = []
    const lifecycle = new RuntimeLifecycle<ManagedRuntime>({
      create: () => { throw new Error('cannot construct') },
      onReady: vi.fn(),
      onStartError: (error) => { errors.push(error) },
    })

    await expect(lifecycle.start()).resolves.toBeUndefined()
    expect(lifecycle.current).toBeUndefined()
    expect(errors).toEqual([new Error('cannot construct')])
  })
})
