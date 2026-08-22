/**
 * ServerRuntime lifecycle over an injected spawn: readiness resolves from the
 * launcher's stdout line + HTTP poll, start is idempotent and re-armable after
 * exit, a spawn failure rejects, an exit after readiness fires onExit (but a
 * disposal-driven exit does not), and dispose tree-kills a live child. The
 * launcher primitive's own resolution/parsing is covered in its package; this
 * suite asserts the runtime glue around it.
 */

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { ServerRuntime, type ServerRuntimeOptions } from '../src/runtime.ts'

/** A minimal spawn-shaped fake child driving stdout/stderr and exit by hand. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  pid = 4321
  kill(): boolean { return true }

  ready(port = 5123): void {
    this.stdout.setEncoding('utf8')
    this.stdout.write(`dsh web: http://127.0.0.1:${String(port)}\n`)
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
  }
}

function runtimeWith(child: FakeChild, extra: Partial<ServerRuntimeOptions> = {}): {
  runtime: ServerRuntime
  spawn: ReturnType<typeof vi.fn>
  spawnNext: (next: FakeChild) => void
  logs: string[]
} {
  const logs: string[] = []
  // The next child the mock returns; a fresh start after failure swaps it in
  // (the cast stays in the factory body, never at a mockReturnValue call site).
  let current = child
  const spawnNext = (next: FakeChild): void => { current = next }
  const fetchImpl: typeof fetch = async () => new Response('ok', { status: 200 })
  const spawn = vi.fn((): ChildProcess => current as unknown as ChildProcess)
  const runtime = new ServerRuntime({
    appDir: '/ext',
    env: { DSH_BIN: '/tools/dsh' }, // pins the launch to one deterministic branch
    log: line => logs.push(line),
    spawn,
    fetchImpl,
    killTree: async () => {},
    ...extra,
  })
  return { runtime, spawn, spawnNext, logs }
}

describe('ServerRuntime', () => {
  it('resolves the advertised origin once the readiness line and HTTP poll pass', async () => {
    const child = new FakeChild()
    const { runtime } = runtimeWith(child)
    const started = runtime.start()
    child.ready(5123)
    const url = await started
    expect(url.href).toBe('http://127.0.0.1:5123/')
    expect(runtime.url?.href).toBe('http://127.0.0.1:5123/')
  })

  it('shares one attempt across concurrent starts', async () => {
    const child = new FakeChild()
    const { runtime, spawn } = runtimeWith(child)
    const a = runtime.start()
    const b = runtime.start()
    child.ready()
    await Promise.all([a, b])
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('rejects on a spawn error and re-arms for the next start', async () => {
    const child = new FakeChild()
    const { runtime, spawn, spawnNext } = runtimeWith(child)
    const failing = runtime.start()
    child.emit('error', new Error('command not found'))
    await expect(failing).rejects.toThrow(/failed to spawn dsh web.*command not found/)

    // A fresh start spawns again (the poisoned attempt was cleared).
    const child2 = new FakeChild()
    spawnNext(child2)
    const retry = runtime.start()
    child2.ready(6000)
    expect((await retry).href).toBe('http://127.0.0.1:6000/')
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('kills a failed live startup generation before a retry can replace it', async () => {
    const child = new FakeChild()
    Object.defineProperty(child, 'stdout', { value: null })
    const order: string[] = []
    const { runtime, spawn } = runtimeWith(child, {
      killTree: async (pid) => { order.push(`kill:${String(pid)}`) },
    })
    spawn.mockImplementation(() => {
      order.push('spawn')
      return child
    })

    const failing = runtime.start()
    await expect(failing).rejects.toThrow(/without its stdout\/stderr pipes/)
    expect(order).toEqual(['spawn', 'kill:4321'])

    const child2 = new FakeChild()
    child2.pid = 5432
    spawn.mockImplementation(() => {
      order.push('spawn')
      return child2
    })
    const retry = runtime.start()
    child2.ready(6001)
    expect((await retry).href).toBe('http://127.0.0.1:6001/')
    expect(order).toEqual(['spawn', 'kill:4321', 'spawn'])
  })

  it('fires onExit when a started server exits on its own', async () => {
    const child = new FakeChild()
    const exits: Array<[number | null, NodeJS.Signals | null]> = []
    const { runtime } = runtimeWith(child, { onExit: (code, signal) => exits.push([code, signal]) })
    const started = runtime.start()
    child.ready()
    await started
    child.exit(1, null)
    expect(exits).toEqual([[1, null]])
    expect(runtime.url).toBeUndefined()
  })

  it('does not fire onExit for a disposal-driven exit', async () => {
    const child = new FakeChild()
    let exitCalls = 0
    const { runtime } = runtimeWith(child, { onExit: () => { exitCalls++ } })
    const started = runtime.start()
    child.ready()
    await started
    await runtime.dispose()
    child.exit(null, 'SIGTERM')
    expect(exitCalls).toBe(0)
  })

  it('tree-kills a live child on dispose and refuses further starts', async () => {
    const child = new FakeChild()
    const killed: number[] = []
    const { runtime } = runtimeWith(child, { killTree: async (pid) => { killed.push(pid) } })
    const started = runtime.start()
    child.ready()
    await started
    await runtime.dispose()
    expect(killed).toEqual([4321])
    await expect(runtime.start()).rejects.toThrow(/disposed/)
  })

  it('rejects if the child exits while its port is being verified', async () => {
    const child = new FakeChild()
    const fetchImpl: typeof fetch = async () => {
      // Answer 200 but only after the child has already exited, so the
      // adopt-a-stranger guard trips.
      child.exitCode = 3
      return new Response('ok', { status: 200 })
    }
    const { runtime } = runtimeWith(child, { fetchImpl })
    const started = runtime.start()
    child.ready()
    await expect(started).rejects.toThrow(/while its port was verified/)
  })
})
