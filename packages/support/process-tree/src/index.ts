/**
 * Zero-dependency process-tree termination primitive. One `killProcessTree(pid)`
 * call terminates a process and its descendants with platform-correct
 * semantics:
 *
 * - Windows: `taskkill /T /F` — `child.kill()` is `TerminateProcess` of the
 *   direct child only, so reaching the tree needs taskkill's recursive walk;
 *   `/F` is immediate, matching the desktop shell's semantics (no
 *   graceful-then-force escalation exists on Windows here).
 * - POSIX: the target must be a detached process-group leader (the caller
 *   spawns it detached); a negated pid signals the whole group. SIGTERM first,
 *   then SIGKILL after a grace period (default 5000 ms), so a tree that
 *   ignores the graceful signal cannot outlive its parent.
 *
 * The escalation timer is a plain `setTimeout`, so calling this from a
 * detached short-lived process (like the desktop's orphan reaper) keeps that
 * process alive until the grace period elapses and the force kill lands.
 *
 * Failure semantics mirror the desktop shell's original implementation:
 * ESRCH (the group is already gone) is the desired outcome and stays silent;
 * any other error is reported through `logger` and never thrown.
 *
 * @module @deepseek-ai/dsh-process-tree
 */

import { spawn } from 'node:child_process'

/** Default SIGTERM → SIGKILL escalation delay. */
const SIGKILL_GRACE_MS = 5_000

/**
 * Options controlling one process-tree kill. Every knob is injectable, so the
 * platform decisions are unit-testable without killing real processes.
 */
export interface KillProcessTreeOptions {
  /**
   * Platform to dispatch on; defaults to `process.platform`. `win32` uses
   * `taskkill /T /F`; any other platform uses process-group signalling.
   */
  readonly platform?: NodeJS.Platform
  /**
   * Windows tree-kill implementation; defaults to spawning
   * `taskkill /T /F /PID <pid>` with stdio ignored and a spawn-error guard
   * (taskkill always exists on Windows; the guard only prevents an uncaught
   * 'error' crash if it cannot be started at all).
   */
  readonly taskkill?: (pid: number) => void
  /**
   * POSIX signal implementation; defaults to `process.kill`. Called with the
   * NEGATED group-leader pid (`-pid`), exactly as a detached process-group
   * kill needs.
   */
  readonly signal?: (pid: number, sig: NodeJS.Signals) => void
  /** SIGTERM → SIGKILL escalation delay in milliseconds; defaults to 5000. */
  readonly graceMs?: number
  /**
   * Non-ESRCH failure reporter; defaults to `console.error`. Messages are
   * ready to prefix (`SIGTERM failed for pid <pid>: <error>`), so callers keep
   * their own log ownership.
   */
  readonly logger?: (message: string) => void
}

/** Whether the delivered failure is ESRCH — the group is already gone, the desired outcome. */
function isEsrch(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ESRCH'
}

/** Default non-ESRCH failure reporter. */
function defaultLogger(message: string): void {
  console.error(message)
}

/** Default Windows implementation: recursive force kill of the tree, fire-and-forget. */
function taskkillTree(pid: number): void {
  // taskkill always exists on Windows; the handler only prevents an uncaught
  // 'error' crash if it cannot be started at all.
  /* v8 ignore next -- firing requires taskkill itself to be unlaunchable, which no CI lane can stage */
  spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
    .on('error', () => {})
}

/**
 * Terminate a process and its descendants. Windows kills the tree immediately
 * via taskkill; POSIX SIGTERMs the process group and escalates to SIGKILL
 * after `graceMs` (default 5000). Never throws: failures are logged and
 * contained, and a non-positive pid is a no-op (a negated zero or negative
 * pid would signal the caller's own process group or every owned process).
 * @param pid - the tree root's process id.
 * @param options - platform, kill/log/timer injection, and the escalation grace.
 */
export function killProcessTree(pid: number, options: KillProcessTreeOptions = {}): void {
  const platform = options.platform ?? process.platform
  if (pid <= 0) return
  const logger = options.logger ?? defaultLogger
  if (platform === 'win32') {
    (options.taskkill ?? taskkillTree)(pid)
    return
  }
  // An arrow wrapper keeps `this` binding: `process.kill` is a method, and an
  // unbound reference would lose it when invoked through the interface.
  const signal = options.signal ?? ((pid, sig) => process.kill(pid, sig))
  try {
    // The tree root is spawned detached, so a negated PID signals the whole
    // process group in one call.
    signal(-pid, 'SIGTERM')
  } catch (error) {
    // ESRCH means the group is already gone — the desired outcome.
    if (!isEsrch(error)) logger(`SIGTERM failed for pid ${pid}: ${String(error)}`)
    return
  }
  // SIGTERM gets a grace period; the group must not outlive its parent. The
  // timer itself keeps the caller's process alive until the escalation lands,
  // which a detached reaper process relies on.
  setTimeout(() => {
    try {
      signal(-pid, 'SIGKILL')
    } catch (error) {
      // ESRCH: the group exited after SIGTERM, nothing left to force.
      if (!isEsrch(error)) logger(`SIGKILL failed for pid ${pid}: ${String(error)}`)
    }
  }, options.graceMs ?? SIGKILL_GRACE_MS)
}
