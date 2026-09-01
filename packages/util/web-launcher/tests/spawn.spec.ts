import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  spawnWebLaunch,
  type SpawnFn,
  type WebLaunchChild,
  type WebServerLaunch,
  WEB_ARGS,
} from '../src/index.ts'

interface ChildResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

/** Collect one short-lived launch without hiding spawn or exit failures. */
async function collect(child: WebLaunchChild): Promise<ChildResult> {
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: string) => { stdout += chunk })
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  const failed = new Promise<never>((_resolve, reject) => { child.once('error', reject) })
  const closed = once(child, 'close').then((values) => {
    const [code, signal] = values as [number | null, NodeJS.Signals | null]
    return { code, signal, stdout, stderr }
  })
  return Promise.race([closed, failed])
}

describe('spawnWebLaunch', () => {
  it('owns the shared spawn options while honoring launch and host cwd precedence', () => {
    const child = {} as ChildProcess
    const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = []
    const spawn: SpawnFn = (command, args, options) => {
      calls.push({ command, args, options })
      return child
    }
    const base: WebServerLaunch = {
      command: 'dsh',
      args: [...WEB_ARGS],
      env: { LAUNCH_ONLY: '1' },
      source: 'test',
    }

    expect(spawnWebLaunch(base, {
      cwd: 'host-root',
      env: { HOST_ONLY: '1', LAUNCH_ONLY: 'old' },
      platform: 'win32',
    }, spawn)).toBe(child)
    expect(spawnWebLaunch({ ...base, cwd: 'launch-root' }, {
      cwd: 'host-root',
      env: { HOST_ONLY: '1' },
      platform: 'linux',
    }, spawn)).toBe(child)
    expect(calls).toEqual([
      {
        command: 'dsh',
        args: [...WEB_ARGS],
        options: {
          cwd: 'host-root',
          env: { HOST_ONLY: '1', LAUNCH_ONLY: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          detached: false,
        },
      },
      {
        command: 'dsh',
        args: [...WEB_ARGS],
        options: {
          cwd: 'launch-root',
          env: { HOST_ONLY: '1', LAUNCH_ONLY: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          detached: true,
        },
      },
    ])
  })

  it('uses the production compatibility spawner by default', async () => {
    const result = await collect(spawnWebLaunch({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("spawn-ok")'],
      env: {},
      source: 'test node',
    }, { env: process.env }))
    expect(result).toEqual({ code: 0, signal: null, stdout: 'spawn-ok', stderr: '' })
  })

  it.runIf(process.platform === 'win32')('runs PATH-resolved and absolute cmd shims on Windows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-web-launcher-'))
    try {
      const shim = join(directory, 'dsh-fixture.cmd')
      await writeFile(shim, '@echo off\r\necho args:%*\r\n', 'utf8')
      const env = { ...process.env }
      const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
      env[pathKey] = `${directory}${delimiter}${env[pathKey] ?? ''}`
      env.PATHEXT ??= '.COM;.EXE;.BAT;.CMD'

      for (const command of ['dsh-fixture', shim]) {
        const result = await collect(spawnWebLaunch({
          command,
          args: [...WEB_ARGS],
          env: {},
          source: 'test cmd shim',
        }, { env }))
        expect(result.code).toBe(0)
        expect(result.signal).toBeNull()
        expect(result.stdout.trim()).toBe('args:"web" "--host" "127.0.0.1" "--port" "0"')
        expect(result.stderr).toBe('')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
