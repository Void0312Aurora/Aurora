/**
 * Managed `dsh web` server for one VS Code window. Resolution, readiness
 * parsing, and HTTP polling come from the shared `@deepseek-ai/dsh-web-launcher`
 * primitive (the desktop shell consumes the same one); this class owns the
 * spawn, the exit observation, and the tree teardown. One window runs at most
 * one server (`--port 0`, so parallel windows never collide); the webview's
 * connection loop reconnects on its own, so callers start the server in the
 * background and never gate the panel on it.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { killProcessTree } from '@deepseek-ai/dsh-process-tree'
import {
  childExited,
  resolveWebLaunch,
  waitForHttpOk,
  waitForReadyLine,
} from '@deepseek-ai/dsh-web-launcher'

/** The single spawn signature this runtime uses (a test seam; the node overload set collapses to this call shape). */
type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

/** One startup generation and the exact child/listeners it owns. */
interface StartAttempt {
  child?: ChildProcess
  detach?: () => void
  cleanup?: Promise<void>
}

/** Facts the runtime needs from the extension host. */
export interface ServerRuntimeOptions {
  /** Extension payload root: anchors the embedded closure and checkout discovery. */
  appDir: string
  /** Working directory for the server (the window's first workspace folder); the harness treats it as the default project root. */
  cwd?: string
  /** Environment the launch resolution reads (DSH_BIN, DSH_PERMISSION_MODE). */
  env: NodeJS.ProcessEnv
  /** Extension-owned Loader tail overlay passed to `dsh web --app-config`. */
  appConfigPath: string
  /** Line sink for launch diagnostics and forwarded server stdout. */
  log: (line: string) => void
  /** Called once when a started server exits (never during {@link ServerRuntime.dispose}). */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
  /** Process spawn; runtime-only test seam. Production uses `node:child_process` spawn. */
  spawn?: SpawnFn
  /** HTTP readiness probe; runtime-only test seam. Production uses global fetch. */
  fetchImpl?: typeof fetch
  /** Tree termination; runtime-only test seam. Production uses `killProcessTree`. */
  killTree?: (pid: number) => Promise<void>
}

/** Lifecycle owner of one managed `dsh web` process. */
export class ServerRuntime {
  private attempt: StartAttempt | undefined
  private urlValue: URL | undefined
  private startTask: Promise<URL> | undefined
  private startAbort: AbortController | undefined
  private disposed = false

  /** @param options - environment facts and lifecycle sinks. */
  constructor(private readonly options: ServerRuntimeOptions) {}

  /** The advertised server origin once readiness completed. */
  get url(): URL | undefined {
    return this.urlValue
  }

  /**
   * True once {@link dispose} ran (set synchronously before the start abort
   * fires, so a caller observing a rejected start sees it without a race).
   * A start that rejects against a disposed runtime is teardown, not failure.
   */
  get isDisposed(): boolean {
    return this.disposed
  }

  /**
   * Start the server and await readiness. Idempotent: concurrent and repeat
   * calls share one attempt; after a server exit the next call starts a fresh
   * process.
   * @returns the advertised loopback origin.
   */
  start(): Promise<URL> {
    if (this.disposed) return Promise.reject(new Error('dsh runtime is disposed'))
    if (this.startTask !== undefined) return this.startTask
    const attempt: StartAttempt = {}
    this.attempt = attempt
    const task = this.performStart(attempt).catch(async (error: unknown) => {
      await this.stopAttempt(attempt)
      // A failed attempt must not poison the next start, but a newer attempt
      // owns its own task and must not be cleared by this generation.
      if (this.startTask === task) this.startTask = undefined
      throw error
    })
    this.startTask = task
    return this.startTask
  }

  private async performStart(attempt: StartAttempt): Promise<URL> {
    const { options } = this
    // One controller per attempt: dispose() aborts it so the readiness poll
    // (up to 30s) stops at once instead of running out against a server we are
    // already tearing down.
    const startAbort = new AbortController()
    this.startAbort = startAbort
    const launch = resolveWebLaunch({
      env: options.env,
      appDir: options.appDir,
      execPath: process.execPath,
    })
    if (launch.env.DSH_PERMISSION_MODE !== undefined && (options.env.DSH_PERMISSION_MODE === undefined || options.env.DSH_PERMISSION_MODE === '')) {
      options.log(`Windows has no harness confinement backend; using ${launch.env.DSH_PERMISSION_MODE} permission mode (approval prompts are disabled). Set DSH_PERMISSION_MODE to override.`)
    }
    const args = [...launch.args, '--app-config', options.appConfigPath]
    options.log(`launching dsh web (${launch.source}): ${launch.command} ${args.join(' ')}`)
    const spawn: SpawnFn = options.spawn ?? nodeSpawn
    const child = spawn(launch.command, args, {
      // The tsx checkout branch needs the repo root; every other branch runs
      // in the window's workspace folder so the harness adopts it as the
      // default project root.
      cwd: launch.cwd ?? options.cwd,
      env: { ...options.env, ...launch.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // POSIX: a detached child leads its own process group so the tree kill
      // reaches every descendant; Windows tree-kills via taskkill /T instead.
      detached: process.platform !== 'win32',
    })
    attempt.child = child
    // stdio ['ignore','pipe','pipe'] gives stdout/stderr pipes, but the generic
    // spawn signature still types them nullable; guard once before use.
    if (child.stdout === null || child.stderr === null) {
      throw new Error('dsh web spawned without its stdout/stderr pipes')
    }
    const { stdout, stderr } = child
    stderr.setEncoding('utf8')
    const onStderr = (chunk: string): void => { options.log(`[dsh web:err] ${chunk.trimEnd()}`) }
    stderr.on('data', onStderr)
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (this.attempt !== attempt) return
      attempt.detach?.()
      this.attempt = undefined
      this.urlValue = undefined
      this.startTask = undefined
      if (this.disposed) return
      options.log(`dsh web exited (code ${String(code)} signal ${String(signal)})`)
      options.onExit?.(code, signal)
    }
    child.on('exit', onExit)
    let rejectSpawn: ((error: Error) => void) | undefined
    const onError = (error: Error): void => {
      rejectSpawn?.(new Error(`failed to spawn dsh web via ${launch.source}: ${error.message}`))
    }
    child.on('error', onError)
    attempt.detach = () => {
      stderr.off('data', onStderr)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    const spawnFailure = new Promise<never>((_resolve, reject) => {
      rejectSpawn = reject
    })
    stdout.setEncoding('utf8')
    const url = await Promise.race([
      waitForReadyLine(stdout, {
        onChunk: (chunk) => { options.log(`[dsh web] ${chunk.trimEnd()}`) },
      }),
      spawnFailure,
    ])
    await waitForHttpOk(url, {
      signal: startAbort.signal,
      ...options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
    })
    // A 200 on the advertised port is not necessarily ours: if the child died
    // while the poll ran, some other local server may have answered. Adopting
    // a stranger's process would be wrong, so fail the start instead.
    if (childExited(child)) {
      throw new Error(`dsh web exited (code ${String(child.exitCode)} signal ${String(child.signalCode)}) while its port was verified; not adopting the server`)
    }
    // The runtime may have been disposed or replaced while readiness crossed
    // awaits. Never publish a URL for a generation that no longer owns state.
    if (this.disposed || this.attempt !== attempt) {
      throw new Error('dsh web startup was superseded by teardown')
    }
    this.urlValue = url
    options.log(`dsh web ready at ${url.href}`)
    return url
  }

  /** Stop one exact generation once; detach callbacks before killing it. */
  private stopAttempt(attempt: StartAttempt): Promise<void> {
    attempt.cleanup ??= (async () => {
      attempt.detach?.()
      const child = attempt.child
      if (this.attempt === attempt) {
        this.urlValue = undefined
      }
      try {
        if (child?.pid !== undefined && !childExited(child)) {
          const killTree = this.options.killTree
            ?? ((pid: number) => killProcessTree(pid, { logger: (message) => { this.options.log(`killTree ${message}`) } }))
          await killTree(child.pid)
        }
      } finally {
        // Keep the generation discoverable while its process tree is still
        // draining so every concurrent disposer shares this cleanup promise.
        if (this.attempt === attempt) {
          this.attempt = undefined
          this.urlValue = undefined
        }
      }
    })()
    return attempt.cleanup
  }

  /** Terminate the server tree and refuse further starts. Idempotent. */
  async dispose(): Promise<void> {
    this.disposed = true
    // Cancel an in-flight readiness poll so it does not run out its deadline.
    this.startAbort?.abort()
    const attempt = this.attempt
    this.urlValue = undefined
    this.startTask = undefined
    if (attempt !== undefined) await this.stopAttempt(attempt)
  }
}
