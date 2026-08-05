/**
 * Orphan reaper for the dsh-desktop server child. No OS delivers a
 * parent-death notification, so a hard-killed Electron main (Task Manager,
 * `taskkill`, a crash) would leave `dsh web` and its tree running forever on
 * any platform. This script polls the main process's PID and, when it is
 * gone, tree-kills the server child and exits. Runs under Electron-as-Node;
 * its only inputs are the two PIDs on argv.
 *
 * Tree kill is platform-specific: Windows uses `taskkill /T /F`; POSIX sends
 * SIGTERM to the server's process group (the server is spawned detached, so a
 * negated PID reaches the whole tree) and escalates to SIGKILL after a grace
 * period.
 *
 * Usage: node reaper.js <mainPid> <serverPid>
 */

import { spawn } from 'node:child_process'

const mainPid = Number(process.argv[2])
const serverPid = Number(process.argv[3])
if (!Number.isInteger(mainPid) || !Number.isInteger(serverPid) || mainPid <= 0 || serverPid <= 0) {
  throw new Error(`dsh-desktop reaper: expected <mainPid> <serverPid>, got ${process.argv.slice(2).join(' ')}`)
}

const POLL_INTERVAL_MS = 1_000
/** The main process's killTree gives SIGTERM a five-second grace before SIGKILL; match it. */
const SIGKILL_GRACE_MS = 5_000

// The interval must keep this process alive — that is its whole job.
const timer = setInterval(() => {
  try {
    // Signal 0 probes liveness without sending anything; it throws once the
    // main process is gone (or becomes unowned).
    process.kill(mainPid, 0)
  } catch {
    // process.kill(pid, 0) throws only when the main is gone or unowned —
    // either way the server must not outlive it.
    clearInterval(timer)
    killServerTree()
    return
  }
}, POLL_INTERVAL_MS)

/**
 * Tree-kill the server child once the main is gone. Windows: taskkill /T /F
 * reaches the server's own subprocesses. POSIX: the server is detached, so a
 * negated PID signals its whole process group — SIGTERM first, SIGKILL after
 * a grace period (the same pattern src/main.ts's killTree uses). The timeout
 * below keeps this process alive for the escalation, then exits.
 */
function killServerTree(): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/T', '/F', '/PID', String(serverPid)], { stdio: 'ignore', windowsHide: true })
      // taskkill always exists on Windows; the handler only prevents an
      // uncaught 'error' crash if it cannot be started at all.
      .on('error', () => {})
    process.exit(0)
  }
  try {
    process.kill(-serverPid, 'SIGTERM')
  } catch (error) {
    // ESRCH means the group is already gone — the desired outcome.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      console.error(`[dsh-desktop] reaper SIGTERM failed for pid ${serverPid}: ${String(error)}`)
    }
    process.exit(0)
    return
  }
  // SIGTERM gets a grace period; the group must not outlive the main.
  setTimeout(() => {
    try {
      process.kill(-serverPid, 'SIGKILL')
    } catch (error) {
      // ESRCH: the group exited after SIGTERM, nothing left to force.
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        console.error(`[dsh-desktop] reaper SIGKILL failed for pid ${serverPid}: ${String(error)}`)
      }
    }
    process.exit(0)
  }, SIGKILL_GRACE_MS)
}
