/**
 * Orphan reaper for the dsh-desktop server child. No OS delivers a
 * parent-death notification, so a hard-killed Electron main (Task Manager,
 * `taskkill`, a crash) would leave `dsh web` and its tree running forever on
 * any platform. This script polls the main process's PID and, when it is
 * gone, tree-kills the server child and exits. Runs under Electron-as-Node;
 * its only inputs are the two PIDs on argv.
 *
 * The tree kill is delegated to the `@deepseek-ai/dsh-process-tree` primitive
 * (taskkill /T /F on Windows; SIGTERM with SIGKILL escalation against the
 * server's detached process group on POSIX). Its Promise keeps this process
 * alive through taskkill completion on Windows or verified process-group
 * quiescence on POSIX; the reaper then exits when the event loop drains.
 *
 * Usage: node reaper.js <mainPid> <serverPid>
 */

import { killProcessTree } from '@deepseek-ai/dsh-process-tree'

const mainPid = Number(process.argv[2])
const serverPid = Number(process.argv[3])
if (!Number.isInteger(mainPid) || !Number.isInteger(serverPid) || mainPid <= 0 || serverPid <= 0) {
  throw new Error(`dsh-desktop reaper: expected <mainPid> <serverPid>, got ${process.argv.slice(2).join(' ')}`)
}

const POLL_INTERVAL_MS = 1_000

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
    void killServerTree()
    return
  }
}, POLL_INTERVAL_MS)

/**
 * Tree-kill the server child once the main is gone, via the shared
 * `@deepseek-ai/dsh-process-tree` primitive — the same kill `main.ts`'s
 * killTree performs, with the reaper's log prefix. The returned Promise
 * keeps this process alive (on Windows: until taskkill exits; on POSIX:
 * until the process group is absent), so the reaper cannot exit before its
 * platform completion boundary.
 */
function killServerTree(): Promise<void> {
  return killProcessTree(serverPid, {
    logger: (message) => { console.error(`[dsh-desktop] reaper ${message}`) },
  })
}
