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
 * server's detached process group on POSIX). Its escalation timer is what
 * keeps this process alive until the kill lands; once it fires, the event
 * loop drains and the reaper exits on its own.
 *
 * Usage: node reaper.js <mainPid> <serverPid>
 */

// The same lib-relative import src/main.ts uses: the packaged app has no
// node_modules, and this script runs from the unpacked tree (Electron-as-Node
// cannot read inside app.asar), so the primitive ships as plain files under
// lib/process-tree/ — packed and unpacked by electron-builder.
import { killProcessTree } from '../lib/process-tree/index.js'

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
 * until the SIGKILL escalation timer fires), so the reaper cannot exit
 * before the kill lands.
 */
function killServerTree(): Promise<void> {
  return killProcessTree(serverPid, {
    logger: (message) => { console.error(`[dsh-desktop] reaper ${message}`) },
  })
}
