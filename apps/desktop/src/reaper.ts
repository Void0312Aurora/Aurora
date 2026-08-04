/**
 * Windows orphan reaper for the dsh-desktop server child. Windows has no
 * parent-death notification, so a hard-killed Electron main (Task Manager,
 * `taskkill`, a crash) would leave `dsh web` and its tree running forever.
 * This script polls the main process's PID and, when it is gone, tree-kills
 * the server child and exits. Runs under Electron-as-Node; its only inputs
 * are the two PIDs on argv.
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
    spawn('taskkill', ['/T', '/F', '/PID', String(serverPid)], { stdio: 'ignore', windowsHide: true })
      // taskkill always exists on Windows; the handler only prevents an
      // uncaught 'error' crash if it cannot be started at all.
      .on('error', () => {})
    process.exit(0)
  }
}, POLL_INTERVAL_MS)
