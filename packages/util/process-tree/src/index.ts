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
 *   then SIGKILL after a grace period (default 5000 ms), followed by a
 *   liveness wait that confirms the group is gone when signalling and probes
 *   succeed.
 *
 * The grace and liveness timers stay referenced, so calling this from a
 * detached short-lived process (like the desktop's orphan reaper) keeps that
 * process alive until the group reaches quiescence.
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

/** Poll cadence while waiting for a POSIX process group to disappear. */
const TREE_EXIT_POLL_MS = 15

/** Referenced delay used by grace and quiescence polling. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

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
   * `taskkill /T /F /PID <pid>` and resolving when it exits.
   * (taskkill normally exists on Windows; a spawn failure is reported through
   * `logger` and contained.)
   */
  readonly taskkill?: (pid: number) => Promise<void>
  /**
   * POSIX signal implementation; defaults to `process.kill`. Called with the
   * NEGATED group-leader pid (`-pid`), exactly as a detached process-group
   * kill needs.
   */
  readonly signal?: (pid: number, sig: NodeJS.Signals) => void
  /** SIGTERM → SIGKILL escalation delay in milliseconds; defaults to 5000. */
  readonly graceMs?: number
  /**
   * POSIX group-liveness probe; receives the positive group-leader pid and
   * defaults to `process.kill(-pid, 0)`. Primarily injectable for tests.
   */
  readonly treeAlive?: (pid: number) => boolean
  /** Liveness-poll cadence in milliseconds; defaults to 15. */
  readonly pollMs?: number
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

/** Whether the detached POSIX process group still exists. */
function posixTreeAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if (isEsrch(error)) return false
    // EPERM still proves that the group exists; the caller may not signal it.
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true
    throw error
  }
}

/**
 * Wait until a POSIX process group disappears, optionally stopping at a
 * deadline so the caller can escalate from SIGTERM to SIGKILL.
 */
async function waitForTreeExit(
  pid: number,
  treeAlive: (pid: number) => boolean,
  pollMs: number,
  timeoutMs?: number,
): Promise<boolean> {
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs
  while (treeAlive(pid)) {
    if (deadline !== undefined && Date.now() >= deadline) return false
    const remaining = deadline === undefined ? pollMs : Math.min(pollMs, Math.max(1, deadline - Date.now()))
    await sleep(remaining)
  }
  return true
}

/** Default Windows implementation: spawns taskkill and settles when it exits or fails to start. */
function taskkillTree(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
      .on('error', reject)
      .on('close', () => { resolve() })
  })
}

/**
 * Terminate a process and its descendants. Windows resolves after taskkill
 * exits. POSIX SIGTERMs the process group, escalates to SIGKILL after
 * `graceMs` (default 5000), and on the successful signal/probe path resolves
 * only after the group is observed absent. Delivery and probe failures are
 * logged and resolve best-effort; a non-positive pid is a no-op (a negated
 * zero or negative pid would signal the caller's own process group or every
 * owned process).
 * @param pid - the tree root's process id.
 * @param options - platform, kill/log/timer injection, and the escalation grace.
 */
export async function killProcessTree(pid: number, options: KillProcessTreeOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform
  if (pid <= 0) return
  const logger = options.logger ?? defaultLogger
  if (platform === 'win32') {
    try {
      await (options.taskkill ?? taskkillTree)(pid)
    } catch (error) {
      logger(`taskkill failed for pid ${pid}: ${String(error)}`)
    }
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
  const treeAlive = options.treeAlive ?? posixTreeAlive
  const pollMs = options.pollMs ?? TREE_EXIT_POLL_MS
  try {
    if (await waitForTreeExit(pid, treeAlive, pollMs, options.graceMs ?? SIGKILL_GRACE_MS)) return
  } catch (error) {
    logger(`liveness probe failed for pid ${pid}: ${String(error)}`)
    return
  }
  try {
    signal(-pid, 'SIGKILL')
  } catch (error) {
    // ESRCH: the group exited after the grace-period probe, nothing left to force.
    if (!isEsrch(error)) logger(`SIGKILL failed for pid ${pid}: ${String(error)}`)
    return
  }
  try {
    await waitForTreeExit(pid, treeAlive, pollMs)
  } catch (error) {
    logger(`liveness probe failed for pid ${pid}: ${String(error)}`)
  }
}
