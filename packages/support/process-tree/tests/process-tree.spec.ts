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
  it('SIGTERMs the negated group id, then SIGKILLs it after the default 5000 ms grace', () => {
    vi.useFakeTimers()
    const signal = vi.fn()
    const logger = vi.fn()
    void killProcessTree(1234, { platform: 'linux', signal, logger })
    expect(signal).toHaveBeenCalledTimes(1)
    expect(signal).toHaveBeenCalledWith(-1234, 'SIGTERM')
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(4_999)
    expect(signal).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(signal).toHaveBeenLastCalledWith(-1234, 'SIGKILL')
    expect(logger).not.toHaveBeenCalled()
  })

  it('honors a custom escalation grace', () => {
    vi.useFakeTimers()
    const signal = vi.fn()
    void killProcessTree(1234, { platform: 'linux', signal, graceMs: 250 })
    vi.advanceTimersByTime(249)
    expect(signal).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(signal).toHaveBeenLastCalledWith(-1234, 'SIGKILL')
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

  it('treats SIGKILL ESRCH as success', () => {
    vi.useFakeTimers()
    const err = new Error('no such process') as NodeJS.ErrnoException
    err.code = 'ESRCH'
    const signal = vi.fn()
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => { throw err })
    const logger = vi.fn()
    void killProcessTree(1234, { platform: 'linux', signal, logger })
    vi.advanceTimersByTime(5_000)
    expect(signal).toHaveBeenLastCalledWith(-1234, 'SIGKILL')
    expect(logger).not.toHaveBeenCalled()
  })

  it('reports a non-ESRCH SIGKILL failure', () => {
    vi.useFakeTimers()
    const err = new Error('permission denied') as NodeJS.ErrnoException
    err.code = 'EPERM'
    const signal = vi.fn()
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => { throw err })
    const logger = vi.fn()
    void killProcessTree(1234, { platform: 'linux', signal, logger })
    vi.advanceTimersByTime(5_000)
    expect(logger).toHaveBeenCalledExactlyOnceWith('SIGKILL failed for pid 1234: Error: permission denied')
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
    expect(logger).not.toHaveBeenCalled()
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
