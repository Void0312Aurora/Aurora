/**
 * Shared `dsh web` launcher: resolve and spawn the Web server, parse its
 * readiness line, and poll for HTTP readiness. Pure Node logic with no Electron
 * or VS Code imports; shell consumers own lifecycle reporting, window/UI glue,
 * and teardown.
 */

import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import crossSpawn from 'cross-spawn'

/** Server flags every surface launch passes to `dsh web`. Port 0 requests an OS-assigned port (headless already uses this). */
export const WEB_ARGS = ['web', '--host', '127.0.0.1', '--port', '0'] as const

/** The stdout prefix `dsh web` prints once the server listens. */
const READY_LINE_PREFIX = 'dsh web: '

/** How to spawn the Web server: executable, argv, extra env, cwd, and the resolution source for diagnostics. */
export interface WebServerLaunch {
  command: string
  args: string[]
  env: Record<string, string>
  cwd?: string
  source: string
}

/** Process spawn signature shared by shell-host test seams and the compatibility launcher. */
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

/** Host-owned environment and working-directory defaults for one Web server spawn. */
export interface SpawnWebLaunchOptions {
  /** Environment inherited by the server before launch-specific overrides. */
  env: NodeJS.ProcessEnv
  /** Working directory used when the resolved launch does not own one. */
  cwd?: string
  /** Platform selector for process-group behavior; defaults to the running platform. */
  platform?: NodeJS.Platform
}

/** Validated output pipes from a launched Web server. */
export interface WebLaunchPipes {
  stdout: Readable
  stderr: Readable
}

/** Filesystem and process facts the launcher reads; injectable for tests. */
export interface LaunchEnvironment {
  env: NodeJS.ProcessEnv
  /**
   * Directory holding the consuming app's runnable payload. The launcher
   * derives two conventional locations from it: the embedded closure at
   * `<appDir>/deploy/node_modules/@deepseek-ai/dsh/lib/bin.js`, and — for
   * `apps/<name>` dev checkouts — the repository root at `<appDir>/../..`.
   * Packaged consumers whose payload lives outside a checkout simply miss
   * the checkout candidates and fall through to PATH.
   */
  appDir: string
  /**
   * The running executable, reused as Node via `ELECTRON_RUN_AS_NODE` when
   * the embedded closure is selected (Electron in the desktop shell, VS
   * Code's Electron in the extension host).
   */
  execPath: string
  /** Node executable for checkout launches; defaults to `node` on PATH. */
  nodeCommand?: string
  /** Platform for the permission-mode fallback; defaults to the running platform. */
  platform?: NodeJS.Platform
  exists?: (path: string) => boolean
}

/**
 * The harness has no confinement backend on Windows, so its default
 * `workspace-write` permission mode cannot boot there. The launcher falls
 * back to `danger-full-access` when the mode is unset (an explicit empty
 * string counts as unset too), exactly the environment a Windows user must
 * otherwise supply for every `dsh` invocation; an explicit non-empty
 * `DSH_PERMISSION_MODE` always wins.
 */
const WINDOWS_PERMISSION_FALLBACK = 'danger-full-access' as const

/**
 * Resolve how to launch `dsh web`. Order: `DSH_BIN` env → embedded deploy
 * closure (`deploy/node_modules/@deepseek-ai/dsh/lib/bin.js`, run under
 * Electron-as-Node) → the surrounding checkout's CLI (built `lib/bin.js` on
 * Node, else the tsx source launch the repo's own `pnpm run dsh` uses) →
 * `dsh` on PATH.
 * @param options - environment facts; `exists` defaults to the real filesystem.
 * @returns the spawn descriptor.
 */
export function resolveWebLaunch(options: LaunchEnvironment): WebServerLaunch {
  const exists = options.exists ?? existsSync
  const platform = options.platform ?? process.platform
  // An empty DSH_PERMISSION_MODE is treated exactly like an unset one, the
  // same convention DSH_BIN uses below: an explicitly blank value must not
  // bypass the Windows fallback.
  const permissionMode = platform === 'win32' && (options.env.DSH_PERMISSION_MODE === undefined || options.env.DSH_PERMISSION_MODE === '')
    ? { DSH_PERMISSION_MODE: WINDOWS_PERMISSION_FALLBACK }
    : {}
  const dshBin = options.env.DSH_BIN
  if (dshBin !== undefined && dshBin !== '') {
    return { command: dshBin, args: [...WEB_ARGS], env: permissionMode, source: 'DSH_BIN' }
  }
  const embedded = join(options.appDir, 'deploy', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (exists(embedded)) {
    return {
      command: options.execPath,
      // The harness's HMR service needs Node internals; under Electron-as-Node
      // the node-addon-require-builtin fallback does not work (Electron's V8
      // lacks the embedder symbol), so the real flag is required here.
      args: ['--expose-internals', embedded, ...WEB_ARGS],
      env: { ELECTRON_RUN_AS_NODE: '1', ...permissionMode },
      source: 'embedded closure',
    }
  }
  const repoRoot = join(options.appDir, '..', '..')
  const builtBin = join(repoRoot, 'apps', 'cli', 'lib', 'bin.js')
  if (exists(builtBin)) {
    return { command: options.nodeCommand ?? 'node', args: [builtBin, ...WEB_ARGS], env: permissionMode, source: 'checkout lib' }
  }
  const sourceBin = join(repoRoot, 'apps', 'cli', 'src', 'bin.ts')
  if (exists(sourceBin)) {
    return {
      command: options.nodeCommand ?? 'node',
      // The same launch the root `pnpm run dsh` script uses; cwd is the repo root so tsx resolves there.
      args: ['--import', 'tsx/esm', sourceBin, ...WEB_ARGS],
      env: permissionMode,
      cwd: repoRoot,
      source: 'checkout source',
    }
  }
  return { command: 'dsh', args: [...WEB_ARGS], env: permissionMode, source: 'PATH' }
}

/**
 * Spawn a resolved Web launch through the Windows-shim-compatible process
 * boundary. The helper owns the stdio, environment, working-directory, and
 * process-group contract shared by shell hosts; callers own readiness,
 * failure reporting, and teardown.
 * @param launch - resolved executable, arguments, and launch-specific facts.
 * @param options - host environment and working-directory defaults.
 * @param spawn - injectable process primitive; production uses `cross-spawn`.
 * @returns the live child. Call `requireWebLaunchPipes` before consuming its output.
 */
export function spawnWebLaunch(
  launch: WebServerLaunch,
  options: SpawnWebLaunchOptions,
  spawn: SpawnFn = crossSpawn,
): ChildProcess {
  return spawn(launch.command, launch.args, {
    cwd: launch.cwd ?? options.cwd,
    env: { ...options.env, ...launch.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // POSIX children lead a process group; Windows cleanup uses taskkill /T.
    detached: (options.platform ?? process.platform) !== 'win32',
  })
}

/**
 * Require the output pipes requested by `spawnWebLaunch`. A lifecycle owner
 * records the child before calling this function so it can terminate a live
 * process when an injected or platform spawn implementation violates the
 * stdio requirement.
 * @param child - launched child whose stdout and stderr must both be piped.
 * @returns the validated output streams.
 */
export function requireWebLaunchPipes(child: ChildProcess): WebLaunchPipes {
  const { stdout, stderr } = child
  if (stdout === null || stderr === null) {
    throw new Error('dsh web spawned without its stdout/stderr pipes')
  }
  return { stdout, stderr }
}

/**
 * Extract the server URL from one readiness line — `dsh web: http://127.0.0.1:PORT`
 * with an optional LAN note — or undefined for any other line. The URL must
 * carry an explicit port: the readiness line always does, and a port-less
 * fragment (`http://127`) is how a line split across stdout chunks looks mid-way.
 * @param line - one complete line of child stdout, without its trailing newline.
 * @returns the advertised URL, or undefined when the line is not a readiness line.
 */
export function parseReadyLine(line: string): URL | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith(READY_LINE_PREFIX)) return undefined
  const candidate = trimmed.slice(READY_LINE_PREFIX.length).split(' ')[0]
  /* v8 ignore next -- noUncheckedIndexedAccess guard: split always yields at least one element */
  if (candidate === undefined) return undefined
  try {
    const url = new URL(candidate)
    return url.port === '' ? undefined : url
  } catch {
    // new URL(string) throws only SyntaxError for unparsable input; any such
    // line is not a readiness line.
    return undefined
  }
}

/** Timeout and logging hooks for {@link waitForReadyLine}. */
export interface ReadyLineOptions {
  /** How long to wait for the readiness line before failing. */
  timeoutMs?: number
  /** Receives every raw chunk; thrown errors are reported and do not stop draining. */
  onChunk?: (chunk: string) => void
}

/**
 * Wait for the `dsh web` readiness line on the child's stdout. Resolves with
 * the advertised URL; rejects when the stream ends first (the server exited
 * without ever listening) or after {@link ReadyLineOptions.timeoutMs}.
 *
 * The scan never breaks out of the consumption loop: for-await over a Node
 * stream destroys it on early return, and the live server keeps writing
 * stdout after readiness (a destroyed pipe kills it with EPIPE). Once the
 * line is found the loop keeps draining the stream — `onChunk` keeps
 * forwarding — but stops scanning. On the timeout path the iterator is
 * returned so the loop cannot leak.
 * @param stdout - the child's stdout as an async iterable of string chunks.
 * @param options - timeout and logging hooks.
 * @returns the readiness-line URL.
 */
export function waitForReadyLine(stdout: AsyncIterable<string>, options: ReadyLineOptions = {}): Promise<URL> {
  const timeoutMs = options.timeoutMs ?? 60_000
  return new Promise<URL>((resolve, reject) => {
    const iterator = stdout[Symbol.asyncIterator]()
    let resolved = false
    const timer = setTimeout(() => {
      // Giving up on the stream: stop the consumption loop. Node streams are
      // also destroyed here — the timeout means we are done with this server,
      // and an open pipe would otherwise keep the loop alive forever.
      void iterator.return?.()
      const destroyable = stdout as AsyncIterable<string> & { destroy?: () => void }
      destroyable.destroy?.()
      reject(new Error(`dsh-web-launcher: no readiness line from dsh web within ${timeoutMs}ms`))
    }, timeoutMs)
    void (async () => {
      try {
        // Chunks split lines arbitrarily; keep the unterminated tail across chunks.
        let buffer = ''
        while (true) {
          const result = await iterator.next()
          if (result.done) break
          const chunk = result.value
          try {
            options.onChunk?.(chunk)
          } catch (error) {
            console.error('dsh-web-launcher: onChunk callback failed:', error)
          }
          if (resolved) continue
          buffer += chunk
          const lines = buffer.split(/\r?\n/)
          /* v8 ignore next -- noUncheckedIndexedAccess guard: split always yields at least one element to pop */
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            const url = parseReadyLine(line)
            if (url !== undefined) {
              resolved = true
              clearTimeout(timer)
              resolve(url)
            }
          }
        }
        if (resolved) return
        // The stream ended: a final line without a trailing newline still counts.
        const url = parseReadyLine(buffer)
        if (url !== undefined) {
          resolved = true
          clearTimeout(timer)
          resolve(url)
          return
        }
        clearTimeout(timer)
        reject(new Error('dsh-web-launcher: dsh web exited before printing its readiness line'))
      } catch (error) {
        if (resolved) return
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })()
  })
}

/** Deadline, cadence, and fetch injection for {@link waitForHttpOk}. */
export interface HttpOkOptions {
  timeoutMs?: number
  pollIntervalMs?: number
  fetchImpl?: typeof fetch
  /**
   * External cancellation (a caller disposing mid-start). When it aborts, the
   * poll stops immediately and rejects, instead of running out its remaining
   * deadline against a server the caller is already tearing down.
   */
  signal?: AbortSignal
}

/**
 * Poll the server URL until it answers HTTP 200. Each attempt carries a short
 * abort deadline so a wedged server cannot stall the poll past the overall
 * timeout; an external `signal` cancels the whole poll at once.
 * @param url - the readiness-line URL.
 * @param options - timeout, poll cadence, an injectable fetch, and an external abort.
 */
export async function waitForHttpOk(url: URL, options: HttpOkOptions = {}): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 30_000
  const pollIntervalMs = options.pollIntervalMs ?? 250
  const external = options.signal
  // A function read, not an inline `external?.aborted` comparison: the flag is
  // mutated externally between the top-of-loop check and the catch arm, which
  // static control-flow narrowing would otherwise treat as always-false.
  const aborted = (): boolean => external !== undefined && external.aborted
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = new Error('no attempt made')
  while (true) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    if (aborted()) throw new Error(`dsh-web-launcher: readiness poll for ${url.href} was aborted`)
    try {
      // Each attempt aborts on its own 2s deadline or the external signal, whichever first.
      const attemptSignal = external === undefined
        ? AbortSignal.timeout(Math.min(2_000, remaining))
        : AbortSignal.any([AbortSignal.timeout(Math.min(2_000, remaining)), external])
      const response = await fetchImpl(url, { signal: attemptSignal })
      if (response.ok) return
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      if (aborted()) throw new Error(`dsh-web-launcher: readiness poll for ${url.href} was aborted`)
      lastError = error
    }
    const sleepMs = Math.min(pollIntervalMs, deadline - Date.now())
    if (sleepMs > 0) await new Promise(resolve => setTimeout(resolve, sleepMs))
  }
  throw new Error(`dsh-web-launcher: server not reachable at ${url.href} within ${timeoutMs}ms (last error: ${String(lastError)})`)
}

/**
 * Whether a spawned child process has already exited. `exitCode` and
 * `signalCode` stay null until the child exits, so either becoming non-null
 * means the process is gone (a clean exit sets the code, a signal death sets
 * the signal). A child that never spawned (spawn error) reports neither, which
 * this returns as not-exited; callers treat the spawn-error event separately.
 * @param child - the child process to probe.
 * @returns true once the child has exited by code or signal.
 */
export function childExited(child: Pick<ChildProcess, 'exitCode' | 'signalCode'>): boolean {
  return child.exitCode !== null || child.signalCode !== null
}
