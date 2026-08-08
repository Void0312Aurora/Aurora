/**
 * Built Electron lifecycle smoke. The only test hook is a file-triggered quit:
 * every case otherwise resolves and starts the real `dsh web`, waits for HTTP
 * readiness, creates the shipping window and tray, and uses the production
 * process-tree teardown.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { killProcessTree } from '@deepseek-ai/dsh-process-tree'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

const packageDir = fileURLToPath(new URL('..', import.meta.url))
const builtMain = join(packageDir, 'lib', 'types', 'main.js')
const require_ = createRequire(import.meta.url)
const electronPath = require_('electron') as string
const READY_PATTERN = /(?:^|\n)DSH_DESKTOP_READY (\d+)(?:\r?\n|$)/u
const SECOND_INSTANCE_MARKER = 'DSH_DESKTOP_SECOND_INSTANCE'
const testRoot = mkdtempSync(join(tmpdir(), 'dsh-desktop-lifecycle-'))
const userDataDir = join(testRoot, 'electron-user-data')
const dshHome = join(testRoot, 'dsh-home')

interface ElectronSubject {
  child: ChildProcess
  quitFile: string
  output: string
  serverPid?: number
}

const subjects: ElectronSubject[] = []

/** Spawn the compiled Electron package with isolated application and harness state. */
function spawnElectron(): ElectronSubject {
  const parentEnv = { ...process.env }
  delete parentEnv.ELECTRON_RUN_AS_NODE
  delete parentEnv.DSH_BIN
  const quitFile = join(testRoot, `quit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`)
  const options: SpawnOptions = {
    cwd: packageDir,
    env: {
      ...parentEnv,
      DSH_DESKTOP_TEST: '1',
      DSH_DESKTOP_TEST_QUIT_FILE: quitFile,
      DSH_HOME: dshHome,
      DSH_PERMISSION_MODE: 'danger-full-access',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // The failure cleanup uses the same process-group primitive as production;
    // make Electron the group leader so a timed-out smoke cannot leak helpers.
    detached: process.platform !== 'win32',
  }
  const child = spawn(electronPath, [`--user-data-dir=${userDataDir}`, '.'], options)
  const subject: ElectronSubject = { child, quitFile, output: '' }
  subjects.push(subject)
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding('utf8')
    stream?.on('data', (chunk: string) => {
      subject.output += chunk
      const match = READY_PATTERN.exec(subject.output)
      if (match?.[1] !== undefined) subject.serverPid = Number(match[1])
    })
  }
  return subject
}

/** Signal the same app.quit path the tray's Quit item invokes. */
function sendQuit(subject: ElectronSubject): void {
  writeFileSync(subject.quitFile, 'quit')
}

/** Wait until captured process output satisfies a predicate. */
function waitForOutput(
  subject: ElectronSubject,
  predicate: (output: string) => boolean,
  label: string,
  timeoutMs = 90_000,
): Promise<void> {
  if (predicate(subject.output)) return Promise.resolve()
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`electron did not emit ${label} within ${String(timeoutMs)}ms\n${subject.output}`))
    }, timeoutMs)
    const onData = (): void => {
      if (!predicate(subject.output)) return
      cleanup()
      resolvePromise()
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup()
      reject(new Error(`electron exited (code ${String(code)}, signal ${String(signal)}) before ${label}\n${subject.output}`))
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      subject.child.stdout?.off('data', onData)
      subject.child.stderr?.off('data', onData)
      subject.child.off('exit', onExit)
    }
    subject.child.stdout?.on('data', onData)
    subject.child.stderr?.on('data', onData)
    subject.child.once('exit', onExit)
  })
}

/** Wait for a child to exit, retaining output in timeout diagnostics. */
function waitForExit(subject: ElectronSubject, timeoutMs = 30_000): Promise<number | null> {
  if (subject.child.exitCode !== null || subject.child.signalCode !== null) {
    return Promise.resolve(subject.child.exitCode)
  }
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      subject.child.off('exit', onExit)
      reject(new Error(`electron did not exit within ${String(timeoutMs)}ms\n${subject.output}`))
    }, timeoutMs)
    const onExit = (code: number | null): void => {
      clearTimeout(timer)
      resolvePromise(code)
    }
    subject.child.once('exit', onExit)
  })
}

/** Probe whether a PID is still owned by a process. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (process.platform === 'win32' && code === 'EINVAL') return false
    return true
  }
}

/** Wait until a PID is absent, retaining a precise timeout diagnostic. */
async function waitForPidExit(pid: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (pidAlive(pid)) {
    if (Date.now() >= deadline) {
      throw new Error(`pid ${String(pid)} remained live after ${String(timeoutMs)}ms`)
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/** Resolve why the host cannot run a GUI smoke, or undefined when it can. */
function skipReason(): string | undefined {
  if (process.env.DSH_DESKTOP_SKIP_E2E === '1') return 'DSH_DESKTOP_SKIP_E2E=1'
  if (!existsSync(builtMain)) return 'desktop build output is absent'
  if (process.platform === 'linux' && process.env.DISPLAY === undefined && process.env.WAYLAND_DISPLAY === undefined) {
    return 'Linux display server is absent'
  }
  return undefined
}

const reason = skipReason()
const itLifecycle = reason === undefined ? it : it.skip

describe('Electron lifecycle', () => {
  afterEach(async () => {
    for (const subject of subjects.splice(0)) {
      if (subject.child.pid !== undefined && subject.child.exitCode === null && subject.child.signalCode === null) {
        await killProcessTree(subject.child.pid, { graceMs: 0 })
      }
      if (subject.serverPid !== undefined && pidAlive(subject.serverPid)) {
        await killProcessTree(subject.serverPid, { graceMs: 0 })
      }
      rmSync(subject.quitFile, { force: true })
    }
  })

  afterAll(() => { rmSync(testRoot, { recursive: true, force: true }) })

  itLifecycle('boots real dsh web and reaches process-tree quiescence before Electron exits', { timeout: 125_000 }, async () => {
    const subject = spawnElectron()
    await waitForOutput(subject, output => READY_PATTERN.test(output), 'DSH_DESKTOP_READY')

    const serverPid = subject.serverPid
    expect(serverPid, subject.output).toBeTypeOf('number')
    expect(pidAlive(serverPid!), 'the reported dsh web pid must be live at readiness').toBe(true)

    sendQuit(subject)
    expect(await waitForExit(subject)).toBe(0)
    expect(pidAlive(serverPid!), 'dsh web must be gone when Electron reports exit').toBe(false)
  })

  itLifecycle('keeps the first instance alive and delivers its second-instance event', { timeout: 125_000 }, async () => {
    const first = spawnElectron()
    await waitForOutput(first, output => READY_PATTERN.test(output), 'DSH_DESKTOP_READY')

    const second = spawnElectron()
    expect(await waitForExit(second)).toBe(0)
    await waitForOutput(first, output => output.includes(SECOND_INSTANCE_MARKER), SECOND_INSTANCE_MARKER, 15_000)
    expect(first.child.exitCode, `first instance exited unexpectedly\n${first.output}`).toBeNull()

    sendQuit(first)
    expect(await waitForExit(first)).toBe(0)
  })

  itLifecycle('reaps real dsh web after the Electron main is hard-killed', { timeout: 125_000 }, async () => {
    const subject = spawnElectron()
    await waitForOutput(subject, output => READY_PATTERN.test(output), 'DSH_DESKTOP_READY')

    const serverPid = subject.serverPid
    expect(serverPid, subject.output).toBeTypeOf('number')
    expect(pidAlive(serverPid!), 'the reported dsh web pid must be live at readiness').toBe(true)

    // POSIX kills Electron's entire terminal-facing group, reproducing the
    // Ctrl+C/crash boundary the detached reaper must survive. Windows has no
    // negative-PID group signal, so terminate only the Electron main there.
    const electronPid = subject.child.pid
    if (electronPid === undefined) throw new Error('Electron main did not report a pid')
    if (process.platform === 'win32') {
      expect(subject.child.kill('SIGKILL')).toBe(true)
    } else {
      process.kill(-electronPid, 'SIGKILL')
    }
    await waitForExit(subject)
    await waitForPidExit(serverPid!)
    expect(pidAlive(serverPid!), 'the reaper must remove dsh web after a hard kill').toBe(false)
  })
})
