import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  parseReadyLine,
  resolveWebLaunch,
  waitForHttpOk,
  waitForReadyLine,
  WEB_ARGS,
} from '../src/launcher.ts'

const APP_DIR = 'C:\\repo\\apps\\desktop'

function launchWith(
  exists: (path: string) => boolean,
  env: NodeJS.ProcessEnv = {},
  platform: NodeJS.Platform = 'win32',
): ReturnType<typeof resolveWebLaunch> {
  return resolveWebLaunch({ env, appDir: APP_DIR, execPath: 'C:\\repo\\node_modules\\electron\\dist\\electron.exe', exists, platform })
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
})

describe('resolveWebLaunch', () => {
  const base = { env: {}, appDir: APP_DIR, execPath: 'C:\\electron\\electron.exe' }

  it('prefers DSH_BIN over every other candidate', () => {
    const launch = resolveWebLaunch({
      ...base,
      env: { DSH_BIN: 'C:\\tools\\dsh.exe' },
    })
    expect(launch).toEqual({
      command: 'C:\\tools\\dsh.exe',
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
    expect(launch.command).toBe('C:\\repo\\node_modules\\electron\\dist\\electron.exe')
    expect(launch.args).toEqual(['--expose-internals', expect.stringContaining(suffix), ...WEB_ARGS])
    expect(launch.env).toEqual({ ELECTRON_RUN_AS_NODE: '1', DSH_PERMISSION_MODE: 'danger-full-access' })
    expect(launch.source).toBe('embedded closure')
  })

  it('prefers the checkout built lib over the source launch', () => {
    const launch = launchWith(path => path.endsWith(join('apps', 'cli', 'lib', 'bin.js')))
    expect(launch).toEqual({
      command: 'node',
      args: ['C:\\repo\\apps\\cli\\lib\\bin.js', ...WEB_ARGS],
      env: { DSH_PERMISSION_MODE: 'danger-full-access' },
      source: 'checkout lib',
    })
  })

  it('falls back to the tsx source launch with the repo root as cwd', () => {
    const launch = launchWith(path => path.endsWith(join('apps', 'cli', 'src', 'bin.ts')))
    expect(launch).toEqual({
      command: 'node',
      args: ['--import', 'tsx/esm', 'C:\\repo\\apps\\cli\\src\\bin.ts', ...WEB_ARGS],
      env: { DSH_PERMISSION_MODE: 'danger-full-access' },
      cwd: 'C:\\repo',
      source: 'checkout source',
    })
  })

  it('falls back to dsh on PATH when nothing else exists', () => {
    const launch = launchWith(() => false)
    expect(launch).toEqual({ command: 'dsh', args: [...WEB_ARGS], env: { DSH_PERMISSION_MODE: 'danger-full-access' }, source: 'PATH' })
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

  it('destroys the stream on timeout so the consumption loop cannot leak', async () => {
    const stream = new PassThrough()
    stream.write('nothing useful\n')
    await expect(waitForReadyLine(stream, { timeoutMs: 10 })).rejects.toThrow(/within 10ms/)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(stream.destroyed).toBe(true)
  })
})

describe('waitForHttpOk', () => {
  it('resolves when the server answers 200', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }))
    await expect(waitForHttpOk(new URL('http://127.0.0.1:1/'), { fetchImpl, timeoutMs: 100, pollIntervalMs: 5 })).resolves.toBeUndefined()
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
})
