import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  childExited,
  parseReadyLine,
  resolveWebLaunch,
  waitForHttpOk,
  waitForReadyLine,
  WEB_ARGS,
} from '../src/index.ts'

// Fixture paths are built with the host's `join` because the launcher resolves
// its candidates with the host's `node:path`; a Windows literal would not
// normalize on POSIX (`join('C:\\repo\\apps\\shell', '..', '..')` is `C:..`).
// `platform` is injected separately and only selects the permission fallback,
// so the win32 default below is independent of the path flavor.
const REPO_ROOT = join('repo')
const APP_DIR = join(REPO_ROOT, 'apps', 'shell')
const EXEC_PATH = join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron')

function launchWith(
  exists: (path: string) => boolean,
  env: NodeJS.ProcessEnv = {},
  platform: NodeJS.Platform = 'win32',
): ReturnType<typeof resolveWebLaunch> {
  return resolveWebLaunch({ env, appDir: APP_DIR, execPath: EXEC_PATH, exists, platform })
}

describe('parseReadyLine', () => {
  it('parses the plain readiness line', () => {
    const url = parseReadyLine('dsh web: http://127.0.0.1:34567')
    expect(url?.href).toBe('http://127.0.0.1:34567/')
  })

  it('parses the readiness line with the LAN note', () => {
    const url = parseReadyLine('dsh web: http://127.0.0.1:34567 (LAN: http://192.168.1.5:34567)')
    expect(url?.port).toBe('34567')
  })

  it('returns undefined for a non-readiness line', () => {
    expect(parseReadyLine('cordis: plugin loaded')).toBeUndefined()
  })

  it('returns undefined when the URL part is not a URL', () => {
    expect(parseReadyLine('dsh web: not a url')).toBeUndefined()
  })

  it('rejects a port-less URL as a chunk-split fragment', () => {
    // `http://127` parses as a valid URL; only the explicit port marks a
    // complete readiness line.
    expect(parseReadyLine('dsh web: http://127.0.0.1')).toBeUndefined()
  })
})

describe('resolveWebLaunch', () => {
  // `platform` is explicit: the permission fallback is a win32 behavior, and
  // leaving it to `process.platform` would make these cases host-dependent.
  const base = { env: {}, appDir: APP_DIR, execPath: EXEC_PATH, platform: 'win32' as NodeJS.Platform }

  it('prefers DSH_BIN over every other candidate', () => {
    const dshBin = join('tools', 'dsh')
    const launch = resolveWebLaunch({
      ...base,
      env: { DSH_BIN: dshBin },
    })
    expect(launch).toEqual({
      command: dshBin,
      args: [...WEB_ARGS],
      env: { DSH_PERMISSION_MODE: 'danger-full-access' },
      source: 'DSH_BIN',
    })
  })

  it('falls back to danger-full-access on win32 when DSH_PERMISSION_MODE is unset', () => {
    const launch = launchWith(() => false)
    expect(launch.env).toEqual({ DSH_PERMISSION_MODE: 'danger-full-access' })
  })

  it('keeps an explicit DSH_PERMISSION_MODE untouched', () => {
    const launch = launchWith(() => false, { DSH_PERMISSION_MODE: 'workspace-write' })
    expect(launch.env).toEqual({})
  })

  it('adds no permission fallback off Windows', () => {
    const launch = launchWith(() => false, {}, 'linux')
    expect(launch.env).toEqual({})
  })

  it('uses the embedded closure under Electron-as-Node when present', () => {
    const suffix = join('deploy', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const launch = launchWith(path => path.endsWith(suffix))
    expect(launch.command).toBe(EXEC_PATH)
    expect(launch.args).toEqual(['--expose-internals', expect.stringContaining(suffix), ...WEB_ARGS])
    expect(launch.env).toEqual({ ELECTRON_RUN_AS_NODE: '1', DSH_PERMISSION_MODE: 'danger-full-access' })
    expect(launch.source).toBe('embedded closure')
  })

  it('prefers the checkout built lib over the source launch', () => {
    const launch = launchWith(path => path.endsWith(join('apps', 'cli', 'lib', 'bin.js')))
    expect(launch).toEqual({
      command: 'node',
      args: [join(REPO_ROOT, 'apps', 'cli', 'lib', 'bin.js'), ...WEB_ARGS],
      env: { DSH_PERMISSION_MODE: 'danger-full-access' },
      source: 'checkout lib',
    })
  })

  it('falls back to the tsx source launch with the repo root as cwd', () => {
    const launch = launchWith(path => path.endsWith(join('apps', 'cli', 'src', 'bin.ts')))
    expect(launch).toEqual({
      command: 'node',
      args: ['--import', 'tsx/esm', join(REPO_ROOT, 'apps', 'cli', 'src', 'bin.ts'), ...WEB_ARGS],
      env: { DSH_PERMISSION_MODE: 'danger-full-access' },
      cwd: REPO_ROOT,
      source: 'checkout source',
    })
  })

  it('falls back to dsh on PATH when nothing else exists', () => {
    const launch = launchWith(() => false)
    expect(launch).toEqual({ command: 'dsh', args: [...WEB_ARGS], env: { DSH_PERMISSION_MODE: 'danger-full-access' }, source: 'PATH' })
  })

  it('treats an empty DSH_BIN as unset', () => {
    const launch = launchWith(() => false, { DSH_BIN: '' })
    expect(launch).toEqual({ command: 'dsh', args: [...WEB_ARGS], env: { DSH_PERMISSION_MODE: 'danger-full-access' }, source: 'PATH' })
  })

  it('treats an empty DSH_PERMISSION_MODE as unset on win32', () => {
    const launch = launchWith(() => false, { DSH_PERMISSION_MODE: '' })
    expect(launch.env).toEqual({ DSH_PERMISSION_MODE: 'danger-full-access' })
  })

  it('uses the real filesystem and platform when exists/platform are omitted', () => {
    // No fixture paths exist on the real filesystem, so resolution walks to
    // the PATH fallback; the permission env then reflects the host platform.
    const launch = resolveWebLaunch({ env: {}, appDir: APP_DIR, execPath: EXEC_PATH })
    expect(launch.command).toBe('dsh')
    expect(launch.source).toBe('PATH')
    expect(launch.env).toEqual(process.platform === 'win32' ? { DSH_PERMISSION_MODE: 'danger-full-access' } : {})
  })

  it('honors an explicit nodeCommand for checkout launches', () => {
    const launch = resolveWebLaunch({
      ...base,
      nodeCommand: join('custom', 'node'),
      exists: path => path.endsWith(join('apps', 'cli', 'lib', 'bin.js')),
    })
    expect(launch.command).toBe(join('custom', 'node'))
    expect(launch.source).toBe('checkout lib')
  })
})

describe('waitForReadyLine', () => {
  function streamOf(chunks: string[]): AsyncIterable<string> {
    return (async function* () {
      for (const chunk of chunks) yield chunk
    })()
  }

  it('resolves with the URL even when the line spans chunks', async () => {
    const url = await waitForReadyLine(streamOf(['dsh web: http://127', '.0.0.1:1234\nmore noise']))
    expect(url.href).toBe('http://127.0.0.1:1234/')
  })

  it('rejects when the stream ends without a readiness line', async () => {
    await expect(waitForReadyLine(streamOf(['cordis: booting\n']))).rejects.toThrow(/exited before printing/)
  })

  it('rejects after the timeout when the stream never yields a line', async () => {
    const pending = new Promise<string>(() => {})
    const stream = (async function* () { yield 'no line here\n'; await pending })()
    await expect(waitForReadyLine(stream, { timeoutMs: 10 })).rejects.toThrow(/within 10ms/)
  })

  it('accepts a final readiness line without a trailing newline', async () => {
    const url = await waitForReadyLine(streamOf(['noise line\n', 'dsh web: http://127.0.0.1:4321']))
    expect(url.href).toBe('http://127.0.0.1:4321/')
  })

  it('keeps consuming the stream after readiness instead of destroying it', async () => {
    // Regression: returning from a `for await` over a Node stream destroys it,
    // and the live server then dies with EPIPE on its next stdout write.
    const stream = new PassThrough()
    const forwarded: string[] = []
    const urlPromise = waitForReadyLine(stream, { onChunk: (chunk) => { forwarded.push(chunk) } })
    stream.write('dsh web: http://127.0.0.1:1234\n')
    const url = await urlPromise
    expect(url.href).toBe('http://127.0.0.1:1234/')
    stream.write('more server output after readiness\n')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(stream.destroyed).toBe(false)
    expect(forwarded.join('')).toContain('more server output after readiness')
    stream.end()
    await new Promise(resolve => setTimeout(resolve, 20))
  })

  it('reports an onChunk failure and keeps draining later chunks', async () => {
    const forwarded: string[] = []
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const url = await waitForReadyLine(streamOf([
        'dsh web: http://127.0.0.1:1234\n',
        'callback failure\n',
        'later output\n',
      ]), {
        onChunk: (chunk) => {
          if (chunk.includes('callback failure')) throw new Error('log sink failed')
          forwarded.push(chunk)
        },
      })

      expect(url.href).toBe('http://127.0.0.1:1234/')
      await vi.waitFor(() => { expect(forwarded).toContain('later output\n') })
      expect(reported).toHaveBeenCalledWith(
        'dsh-web-launcher: onChunk callback failed:',
        expect.objectContaining({ message: 'log sink failed' }),
      )
    } finally {
      reported.mockRestore()
    }
  })

  it('destroys the stream on timeout so the consumption loop cannot leak', async () => {
    const stream = new PassThrough()
    stream.write('nothing useful\n')
    await expect(waitForReadyLine(stream, { timeoutMs: 10 })).rejects.toThrow(/within 10ms/)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(stream.destroyed).toBe(true)
  })

  it('swallows a post-readiness stream error instead of rejecting late', async () => {
    const stream = new PassThrough()
    const urlPromise = waitForReadyLine(stream)
    stream.write('dsh web: http://127.0.0.1:1234\n')
    const url = await urlPromise
    expect(url.href).toBe('http://127.0.0.1:1234/')
    // The consumption loop is still draining; a stream error now reaches the
    // catch arm after resolution and must not surface anywhere.
    stream.destroy(new Error('post-readiness pipe error'))
    await new Promise(resolve => setTimeout(resolve, 20))
  })

  it('times out cleanly on an iterator without return or destroy', async () => {
    // A minimal AsyncIterable (no generator machinery): the timeout path's
    // iterator.return?./destroy?. calls must tolerate both being absent.
    const stream: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<string>>(() => {}),
      }),
    }
    await expect(waitForReadyLine(stream, { timeoutMs: 10 })).rejects.toThrow(/within 10ms/)
  })

  it('rejects with the iteration error when the stream throws', async () => {
    const stream = (async function* (): AsyncGenerator<string> {
      yield 'noise\n'
      throw new Error('pipe collapsed')
    })()
    await expect(waitForReadyLine(stream)).rejects.toThrow('pipe collapsed')
  })

  it('wraps a non-Error iteration failure', async () => {
    const stream = (async function* (): AsyncGenerator<string> {
      yield 'noise\n'
      // A bare string throw exercises the non-Error rejection arm.
      throw 'not an error'
    })()
    await expect(waitForReadyLine(stream)).rejects.toThrow('not an error')
  })
})

describe('waitForHttpOk', () => {
  it('resolves when the server answers 200', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }))
    await expect(waitForHttpOk(new URL('http://127.0.0.1:1/'), { fetchImpl, timeoutMs: 100, pollIntervalMs: 5 })).resolves.toBeUndefined()
  })

  it('defaults to global fetch and the standing timeouts when options are omitted', async () => {
    // An immediate 200 returns on the first attempt, so the default 30s
    // deadline and 250ms cadence are exercised without ever waiting on them.
    const stubbed = vi.fn(async () => new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', stubbed)
    try {
      await expect(waitForHttpOk(new URL('http://127.0.0.1:1/'))).resolves.toBeUndefined()
      expect(stubbed).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('resolves once a failing server recovers', async () => {
    let attempts = 0
    const fetchImpl = vi.fn(async () => {
      attempts += 1
      return attempts < 3 ? new Response('no', { status: 503 }) : new Response('ok', { status: 200 })
    })
    await expect(waitForHttpOk(new URL('http://127.0.0.1:1/'), { fetchImpl, timeoutMs: 200, pollIntervalMs: 5 })).resolves.toBeUndefined()
    expect(attempts).toBe(3)
  })

  it('rejects with the URL when the server never answers', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    await expect(waitForHttpOk(new URL('http://127.0.0.1:1/'), { fetchImpl, timeoutMs: 30, pollIntervalMs: 5 }))
      .rejects.toThrow(/http:\/\/127\.0\.0\.1:1\/.*ECONNREFUSED/)
  })

  it('keeps polling and rejects when the server only answers non-2xx', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }))
    await expect(waitForHttpOk(new URL('http://127.0.0.1:1/'), { fetchImpl, timeoutMs: 50, pollIntervalMs: 5 }))
      .rejects.toThrow(/HTTP 500/)
    // The poll must have retried until the deadline, not given up after one attempt.
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1)
  })

  it('bounds a hanging fetch by the overall deadline', async () => {
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      signal?.addEventListener('abort', () => {
        reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)))
      }, { once: true })
    }))
    const started = performance.now()

    await expect(waitForHttpOk(new URL('http://127.0.0.1:1/'), {
      fetchImpl,
      timeoutMs: 30,
      pollIntervalMs: 1_000,
    })).rejects.toThrow(/within 30ms/)

    expect(performance.now() - started).toBeLessThan(500)
  })

  it('bounds the polling sleep by the overall deadline', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 }))
    const started = performance.now()

    await expect(waitForHttpOk(new URL('http://127.0.0.1:1/'), {
      fetchImpl,
      timeoutMs: 30,
      pollIntervalMs: 1_000,
    })).rejects.toThrow(/within 30ms/)

    expect(performance.now() - started).toBeLessThan(500)
  })

  it('does not sleep after an attempt consumes the remaining deadline', async () => {
    const now = vi.spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(101)
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 }))

    try {
      await expect(waitForHttpOk(new URL('http://127.0.0.1:1/'), {
        fetchImpl,
        timeoutMs: 100,
        pollIntervalMs: 1_000,
      })).rejects.toThrow(/within 100ms/)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    } finally {
      now.mockRestore()
    }
  })
})

describe('childExited', () => {
  it('is false while the child is still running', () => {
    expect(childExited({ exitCode: null, signalCode: null })).toBe(false)
  })

  it('is true once the child exited with a code', () => {
    expect(childExited({ exitCode: 0, signalCode: null })).toBe(true)
  })

  it('is true once the child was killed by a signal', () => {
    expect(childExited({ exitCode: null, signalCode: 'SIGKILL' })).toBe(true)
  })
})
