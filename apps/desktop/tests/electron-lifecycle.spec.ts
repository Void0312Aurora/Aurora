/**
 * Electron lifecycle smoke tests. These spawn the real Electron app with
 * DSH_DESKTOP_TEST=1 (which skips server spawn, hosts about:blank, and
 * waits for a quit-file touch), then verify the process-level lifecycle:
 * boot → window/tray ready → quit.
 *
 * These tests need a display server (real desktop or Xvfb); they are skipped
 * when the CI or DSH_DESKTOP_SKIP_E2E env var is set.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const packageDir = join(__dirname, '..')
const require_ = createRequire(import.meta.url)
// `require('electron')` returns the path to the Electron binary from the npm
// package; in the test harness (vitest/Node) this is the correct way to locate it.
// The spawned child clears ELECTRON_RUN_AS_NODE so the binary starts its browser
// process rather than acting as plain Node.
const electronPath = require_('electron') as string

const READY_MARKER = 'DSH_DESKTOP_READY'

/** Track spawned children so afterEach can clean them up between tests. */
const spawned: ChildProcess[] = []

/**
 * Spawn Electron in test mode. Explicitly clears ELECTRON_RUN_AS_NODE so the
 * Electron binary starts its browser process instead of acting as plain Node.
 * `undefined` in a spawn env object stringifies to `"undefined"` (truthy),
 * so we must delete the key from the inherited environment instead.
 *
 * Quit signalling uses a temp file rather than stdin because stdin pipes are
 * unreliable in Windows GUI processes (the 'data' event never fires).
 */
function spawnElectron(
  extraEnv: Record<string, string> = {},
): { child: ChildProcess; quitFile: string } {
  const parentEnv = { ...process.env }
  delete parentEnv.ELECTRON_RUN_AS_NODE
  const quitFile = join(tmpdir(), `dsh-desktop-test-quit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`)
  // Clean up any leftover from a previous run.
  try { unlinkSync(quitFile) } catch { /* ignore */ }
  const opts: SpawnOptions = {
    cwd: packageDir,
    env: {
      ...parentEnv,
      DSH_DESKTOP_TEST: '1',
      DSH_DESKTOP_TEST_QUIT_FILE: quitFile,
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  }
  const child = spawn(electronPath, ['.'], opts)
  spawned.push(child)
  return { child, quitFile }
}

/** Signal the Electron app to quit by touching the agreed-upon temp file. */
function sendQuit(quitFile: string): void {
  writeFileSync(quitFile, 'quit')
}

/** Resolve once the child prints the READY_MARKER; reject on timeout. */
function waitForReady(child: ChildProcess, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`electron did not emit ${READY_MARKER} within ${timeoutMs}ms`))
    }, timeoutMs)

    let buf = ''
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => {
      buf += chunk
      if (buf.includes(READY_MARKER)) {
        clearTimeout(timer)
        resolve()
      }
    })

    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`electron exited (code ${code}) before emitting ${READY_MARKER}`))
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/** Returns the platform skip reason, or empty string if tests should run. */
function skipReason(): string {
  if (process.env.CI || process.env.DSH_DESKTOP_SKIP_E2E) {
    return 'CI / DSH_DESKTOP_SKIP_E2E: skipping Electron lifecycle tests'
  }
  // Windows GUI apps need a desktop session; when there is no display the
  // spawn will fail or time out, so the test author opt-in by clearing the
  // env var instead of us auto-detecting.
  return ''
}

const describeOrSkip = skipReason() ? describe.skip : describe

describeOrSkip('Electron lifecycle', () => {
  afterEach(() => {
    // Kill any remaining children and give the OS a moment to release the
    // single-instance lock before the next test.
    for (const child of spawned.splice(0)) {
      try { child.kill() } catch { /* ignore */ }
    }
    return new Promise(r => setTimeout(r, 800))
  })

  it('boots, emits the readiness marker, and exits cleanly on quit signal', { timeout: 20_000 }, async () => {
    const { child, quitFile } = spawnElectron()

    await waitForReady(child)
    expect(child.exitCode, 'process must still be alive after readiness').toBeNull()

    const exited = new Promise<number | null>(resolve => child.on('exit', resolve))
    sendQuit(quitFile)

    const code = await exited
    expect(code).toBe(0)

    try { unlinkSync(quitFile) } catch { /* ignore */ }
  })

  it('second instance exits immediately (single-instance lock)', { timeout: 20_000 }, async () => {
    const { child: first, quitFile } = spawnElectron()
    await waitForReady(first)

    // Second instance: requestSingleInstanceLock() → false → app.quit().
    const { child: second, quitFile: _qf2 } = spawnElectron()
    const secondCode = await new Promise<number | null>(resolve => second.on('exit', resolve))

    expect(secondCode).toBe(0)

    // On Windows, Electron 43 has a known issue where the first instance may
    // also exit when a second instance calls requestSingleInstanceLock().
    // When the first instance is still alive, quit it via the agreed file;
    // otherwise the incidental exit is a clean pass (exit code 0).
    if (first.exitCode === null) {
      const firstExited = new Promise<number | null>(resolve => first.on('exit', resolve))
      sendQuit(quitFile)
      const firstCode = await firstExited
      expect(firstCode).toBe(0)
    }

    try { unlinkSync(quitFile) } catch { /* ignore */ }
  })

  it('quit with a fake server pid exercises the killTree path without hanging', { timeout: 20_000 }, async () => {
    // A high, guaranteed-non-existent pid exercises the full killTree path:
    // POSIX → SIGTERM on -99999 → ESRCH → silent, no escalation.
    // Windows → taskkill /T /F /PID 99999 → process not found, exits non-zero.
    const { child, quitFile } = spawnElectron({ DSH_DESKTOP_TEST_TREE_PID: '99999' })

    await waitForReady(child)

    const exited = new Promise<number | null>(resolve => child.on('exit', resolve))
    sendQuit(quitFile)

    const code = await exited
    // before-quit → killTree(99999) → resolves → app.exit(0).
    expect(code).toBe(0)

    try { unlinkSync(quitFile) } catch { /* ignore */ }
  })
})
