/**
 * Managed `dsh web` server for one VS Code window. Resolution, readiness
 * parsing, and HTTP polling come from the shared `@deepseek-ai/dsh-web-launcher`
 * primitive (the desktop shell consumes the same one); this class owns the
 * spawn, the exit observation, and the tree teardown. One window runs at most
 * one server (`--port 0`, so parallel windows never collide); the webview's
 * connection loop reconnects on its own, so callers start the server in the
 * background and never gate the panel on it.
 */

import type { ChildProcess } from 'node:child_process'
import { killProcessTree } from '@deepseek-ai/dsh-process-tree'
import {
  childExited,
  resolveWebLaunch,
  spawnWebLaunch,
  type SpawnFn,
  waitForHttpOk,
  waitForReadyLine,
} from '@deepseek-ai/dsh-web-launcher'

/** Facts the runtime needs from the extension host. */
export interface ServerRuntimeOptions {
  /** Extension payload root: anchors the embedded closure and checkout discovery. */
  appDir: string
  /** Working directory for the server (the window's first workspace folder); the harness treats it as the default project root. */
  cwd?: string
  /** Environment the launch resolution reads (DSH_BIN, DSH_PERMISSION_MODE). */
  env: NodeJS.ProcessEnv
  /** Line sink for launch diagnostics and forwarded server stdout. */
  log: (line: string) => void
  /** Called once when a started server exits (never during {@link ServerRuntime.dispose}). */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
  /** Process spawn; runtime-only test seam. Production uses the shared compatibility launcher. */
  spawn?: SpawnFn
  /** HTTP readiness probe; runtime-only test seam. Production uses global fetch. */
  fetchImpl?: typeof fetch
  /** Tree termination; runtime-only test seam. Production uses `killProcessTree`. */
  killTree?: (pid: number) => Promise<void>
}

/** Lifecycle owner of one managed `dsh web` process. */
export class ServerRuntime {
  private child: ChildProcess | undefined
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
    this.startTask ??= this.performStart().catch((error: unknown) => {
      // A failed attempt must not poison the next start.
      this.startTask = undefined
      throw error
    })
    return this.startTask
  }

  private async performStart(): Promise<URL> {
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
    options.log(`launching dsh web (${launch.source}): ${launch.command} ${launch.args.join(' ')}`)
    const child = spawnWebLaunch(launch, {
      // The tsx checkout branch owns its repo-root cwd; every other branch
      // uses the window's workspace folder as the default project root.
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: options.env,
    }, options.spawn)
    this.child = child
    const { stdout, stderr } = child
    stderr.setEncoding('utf8')
    stderr.on('data', (chunk: string) => { options.log(`[dsh web:err] ${chunk.trimEnd()}`) })
    child.on('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = undefined
      this.urlValue = undefined
      this.startTask = undefined
      if (this.disposed) return
      options.log(`dsh web exited (code ${String(code)} signal ${String(signal)})`)
      options.onExit?.(code, signal)
    })
    const spawnFailure = new Promise<never>((_resolve, reject) => {
      child.on('error', (error) => { reject(new Error(`failed to spawn dsh web via ${launch.source}: ${error.message}`)) })
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
    this.urlValue = url
    options.log(`dsh web ready at ${url.href}`)
    return url
  }

  /** Terminate the server tree and refuse further starts. Idempotent. */
  async dispose(): Promise<void> {
    this.disposed = true
    // Cancel an in-flight readiness poll so it does not run out its deadline.
    this.startAbort?.abort()
    const child = this.child
    this.child = undefined
    this.urlValue = undefined
    this.startTask = undefined
    if (child?.pid !== undefined && !childExited(child)) {
      const killTree = this.options.killTree
        ?? ((pid: number) => killProcessTree(pid, { logger: (message) => { this.options.log(`killTree ${message}`) } }))
      await killTree(child.pid)
    }
  }
}
