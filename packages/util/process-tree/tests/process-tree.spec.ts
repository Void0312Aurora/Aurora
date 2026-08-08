import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { killProcessTree } from '../src/index.ts'

/**
 * All decisions are tested through the injectable knobs (platform, signal,
 * taskkill, logger, grace); the default bindings are exercised against a
 * pid (2147483647) that cannot name a live process, so the real `process.kill`
 * / `taskkill` paths run without touching a real process tree.
 */
const DEAD_PID = 2_147_483_647

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('killProcessTree — POSIX process-group signalling', () => {
  it('SIGTERMs the negated group id, then SIGKILLs it after the default 5000 ms grace', async () => {
    vi.useFakeTimers()
    let forceKilled = false
    const signal = vi.fn((_pid: number, sig: NodeJS.Signals) => { forceKilled ||= sig === 'SIGKILL' })
    const treeAlive = vi.fn(() => !forceKilled)
    const logger = vi.fn()
    const pending = killProcessTree(1234, { platform: 'linux', signal, treeAlive, logger })
    expect(signal).toHaveBeenCalledTimes(1)
    expect(signal).toHaveBeenCalledWith(-1234, 'SIGTERM')
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(signal).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(signal).toHaveBeenLastCalledWith(-1234, 'SIGKILL')
    expect(logger).not.toHaveBeenCalled()
  })

  it('honors a custom escalation grace', async () => {
    vi.useFakeTimers()
    let forceKilled = false
    const signal = vi.fn((_pid: number, sig: NodeJS.Signals) => { forceKilled ||= sig === 'SIGKILL' })
    const pending = killProcessTree(1234, {
      platform: 'linux',
      signal,
      treeAlive: () => !forceKilled,
      graceMs: 250,
    })
    await vi.advanceTimersByTimeAsync(249)
    expect(signal).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(signal).toHaveBeenLastCalledWith(-1234, 'SIGKILL')
  })

  it('resolves during the grace period when SIGTERM removes the group', async () => {
    vi.useFakeTimers()
    let alive = true
    const signal = vi.fn(() => { alive = false })
    await expect(killProcessTree(1234, { platform: 'linux', signal, treeAlive: () => alive }))
      .resolves.toBeUndefined()
    expect(signal).toHaveBeenCalledExactlyOnceWith(-1234, 'SIGTERM')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('treats SIGTERM ESRCH as success: silent and no escalation scheduled', () => {
    vi.useFakeTimers()
    const err = new Error('no such process') as NodeJS.ErrnoException
    err.code = 'ESRCH'
    const signal = vi.fn(() => { throw err })
    const logger = vi.fn()
    void killProcessTree(1234, { platform: 'linux', signal, logger })
    expect(signal).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    expect(logger).not.toHaveBeenCalled()
  })

  it('reports a non-ESRCH SIGTERM failure and does not schedule the escalation', () => {
    vi.useFakeTimers()
    const err = new Error('permission denied') as NodeJS.ErrnoException
    err.code = 'EPERM'
    const signal = vi.fn(() => { throw err })
    const logger = vi.fn()
    void killProcessTree(1234, { platform: 'linux', signal, logger })
    expect(logger).toHaveBeenCalledExactlyOnceWith('SIGTERM failed for pid 1234: Error: permission denied')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('treats SIGKILL ESRCH as success', async () => {
    vi.useFakeTimers()
    const err = new Error('no such process') as NodeJS.ErrnoException
    err.code = 'ESRCH'
    const signal = vi.fn()
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => { throw err })
    const logger = vi.fn()
    const pending = killProcessTree(1234, { platform: 'linux', signal, treeAlive: () => true, logger })
    await vi.advanceTimersByTimeAsync(5_000)
    await pending
    expect(signal).toHaveBeenLastCalledWith(-1234, 'SIGKILL')
    expect(logger).not.toHaveBeenCalled()
  })

  it('reports a non-ESRCH SIGKILL failure', async () => {
    vi.useFakeTimers()
    const err = new Error('permission denied') as NodeJS.ErrnoException
    err.code = 'EPERM'
    const signal = vi.fn()
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => { throw err })
    const logger = vi.fn()
    const pending = killProcessTree(1234, { platform: 'linux', signal, treeAlive: () => true, logger })
    await vi.advanceTimersByTimeAsync(5_000)
    await pending
    expect(logger).toHaveBeenCalledExactlyOnceWith('SIGKILL failed for pid 1234: Error: permission denied')
  })

  it('does not resolve after SIGKILL until the group is observed absent', async () => {
    vi.useFakeTimers()
    let alive = true
    let resolved = false
    const pending = killProcessTree(1234, {
      platform: 'linux',
      signal: vi.fn(),
      treeAlive: () => alive,
      graceMs: 20,
      pollMs: 5,
    }).then(() => { resolved = true })
    await vi.advanceTimersByTimeAsync(20)
    expect(resolved).toBe(false)
    alive = false
    await vi.advanceTimersByTimeAsync(5)
    await pending
    expect(resolved).toBe(true)
  })

  it('reports an unexpected liveness-probe failure without rejecting', async () => {
    const logger = vi.fn()
    await expect(killProcessTree(1234, {
      platform: 'linux',
      signal: vi.fn(),
      treeAlive: () => { throw new Error('probe failed') },
      logger,
    })).resolves.toBeUndefined()
    expect(logger).toHaveBeenCalledExactlyOnceWith('liveness probe failed for pid 1234: Error: probe failed')
  })

  it('uses the default group probe and treats ESRCH as quiescence', async () => {
    const esrch = Object.assign(new Error('gone'), { code: 'ESRCH' })
    const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0) throw esrch
      return true
    })
    await expect(killProcessTree(1234, { platform: 'linux' })).resolves.toBeUndefined()
    expect(kill).toHaveBeenCalledWith(-1234, 'SIGTERM')
    expect(kill).toHaveBeenCalledWith(-1234, 0)
  })

  it('treats EPERM from the default group probe as alive until force-kill quiescence', async () => {
    vi.useFakeTimers()
    const esrch = Object.assign(new Error('gone'), { code: 'ESRCH' })
    const eperm = Object.assign(new Error('denied'), { code: 'EPERM' })
    let forceKilled = false
    const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 'SIGKILL') forceKilled = true
      if (signal === 0) {
        if (forceKilled) throw esrch
        throw eperm
      }
      return true
    })
    const pending = killProcessTree(1234, { platform: 'linux', graceMs: 20, pollMs: 5 })
    await vi.advanceTimersByTimeAsync(20)
    await pending
    expect(kill).toHaveBeenCalledWith(-1234, 'SIGKILL')
  })

  it('contains an unexpected error from the default group probe', async () => {
    const invalid = Object.assign(new Error('invalid'), { code: 'EINVAL' })
    const logger = vi.fn()
    vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0) throw invalid
      return true
    })
    await expect(killProcessTree(1234, { platform: 'linux', logger })).resolves.toBeUndefined()
    expect(logger).toHaveBeenCalledExactlyOnceWith('liveness probe failed for pid 1234: Error: invalid')
  })

  it('contains a liveness-probe failure after SIGKILL', async () => {
    vi.useFakeTimers()
    let forceKilled = false
    const logger = vi.fn()
    const pending = killProcessTree(1234, {
      platform: 'linux',
      signal: (_pid, signal) => { forceKilled ||= signal === 'SIGKILL' },
      treeAlive: () => {
        if (forceKilled) throw new Error('post-kill probe failed')
        return true
      },
      graceMs: 20,
      pollMs: 5,
      logger,
    })
    await vi.advanceTimersByTimeAsync(20)
    await pending
    expect(logger).toHaveBeenCalledExactlyOnceWith('liveness probe failed for pid 1234: Error: post-kill probe failed')
  })

  it('default signal binding signals a real dead group: ESRCH is silent and no timer is set', () => {
    vi.useFakeTimers()
    const logger = vi.fn()
    void killProcessTree(DEAD_PID, { platform: 'linux', logger })
    expect(vi.getTimerCount()).toBe(0)
    expect(logger).not.toHaveBeenCalled()
  })

  it('default logger reports through console.error', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const err = new Error('boom') as NodeJS.ErrnoException
    err.code = 'EPERM'
    void killProcessTree(5, { platform: 'linux', signal: () => { throw err } })
    expect(consoleError).toHaveBeenCalledExactlyOnceWith('SIGTERM failed for pid 5: Error: boom')
  })
})

describe('killProcessTree — Windows taskkill', () => {
  it('invokes taskkill with the tree root pid and never signals a group', () => {
    const taskkill = vi.fn(() => Promise.resolve())
    const signal = vi.fn()
    const logger = vi.fn()
    void killProcessTree(1234, { platform: 'win32', taskkill, signal, logger })
    expect(taskkill).toHaveBeenCalledExactlyOnceWith(1234)
    expect(signal).not.toHaveBeenCalled()
    expect(logger).not.toHaveBeenCalled()
  })

  it('default taskkill binding spawns a real taskkill on a dead pid without throwing', async () => {
    const logger = vi.fn()
    await expect(killProcessTree(DEAD_PID, { platform: 'win32', logger })).resolves.toBeUndefined()
    if (process.platform === 'win32') {
      expect(logger).not.toHaveBeenCalled()
    } else {
      expect(logger).toHaveBeenCalledOnce()
      expect(logger.mock.calls[0]?.[0]).toContain(`taskkill failed for pid ${String(DEAD_PID)}:`)
    }
  })

  it('reports a rejected taskkill implementation without rejecting', async () => {
    const logger = vi.fn()
    const taskkill = vi.fn(() => Promise.reject(new Error('launch failed')))
    await expect(killProcessTree(1234, { platform: 'win32', taskkill, logger })).resolves.toBeUndefined()
    expect(logger).toHaveBeenCalledExactlyOnceWith('taskkill failed for pid 1234: Error: launch failed')
  })
})

describe('killProcessTree — guards and defaults', () => {
  it.each(['win32', 'linux'] as const)('is a no-op for a non-positive pid on %s', (platform) => {
    const taskkill = vi.fn(() => Promise.resolve())
    const signal = vi.fn()
    const logger = vi.fn()
    void killProcessTree(0, { platform, taskkill, signal, logger })
    void killProcessTree(-1, { platform, taskkill, signal, logger })
    expect(taskkill).not.toHaveBeenCalled()
    expect(signal).not.toHaveBeenCalled()
    expect(logger).not.toHaveBeenCalled()
  })

  it('defaults to the running platform without throwing', async () => {
    const logger = vi.fn()
    await expect(killProcessTree(DEAD_PID, { logger })).resolves.toBeUndefined()
    expect(logger).not.toHaveBeenCalled()
  })
})

describe.skipIf(process.platform === 'win32')('killProcessTree — real POSIX process group', () => {
  it('waits for a TERM-resistant leader and descendant to disappear', async () => {
    const script = [
      "const { spawn } = require('node:child_process')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      "process.on('SIGTERM', () => {})",
      "process.stdout.write(String(child.pid) + '\\n')",
      'setInterval(() => {}, 1000)',
    ].join(';')
    const leader = spawn(process.execPath, ['-e', script], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const pid = leader.pid
    if (pid === undefined) throw new Error('process-group leader did not spawn')
    const descendant = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('descendant pid was not reported')) }, 5_000)
      leader.stdout.setEncoding('utf8')
      leader.stdout.once('data', (chunk: string) => {
        clearTimeout(timer)
        resolve(Number(chunk.trim()))
      })
    })
    try {
      await killProcessTree(pid, { platform: process.platform, graceMs: 50 })
      expect(() => { process.kill(-pid, 0) }).toThrow()
      expect(() => { process.kill(descendant, 0) }).toThrow()
    } finally {
      try { process.kill(-pid, 'SIGKILL') } catch { /* The group is already gone. */ }
    }
  })
})
