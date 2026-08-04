/**
 * dsh-desktop launcher: resolve the `dsh` command, spawn the Web server, and
 * wait for it to report readiness. Pure Node logic with no Electron imports,
 * so the unit suite can exercise it without a window; Electron glue lives in
 * `main.ts`.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Server flags every surface launch passes to `dsh web`. Port 0 requests an OS-assigned port (headless already uses this). */
export const WEB_ARGS = ['web', '--host', '127.0.0.1', '--port', '0'] as const

/** The stdout prefix `dsh web` prints once the server listens. */
export const READY_LINE_PREFIX = 'dsh web: '

/** How to spawn the Web server: executable, argv, extra env, cwd, and the resolution source for diagnostics. */
export interface WebServerLaunch {
  command: string
  args: string[]
  env: Record<string, string>
  cwd?: string
  source: string
}

/** Filesystem and process facts the launcher reads; injectable for tests. */
export interface LaunchEnvironment {
  env: NodeJS.ProcessEnv
  /** Directory containing this package's `lib/` (`apps/desktop` in dev, the asar root when packaged). */
  appDir: string
  /** Whether this is a packaged build (the embedded closure is then the first non-env candidate). */
  isPackaged: boolean
  /** The running executable — Electron's own binary, reused as Node when the embedded closure is selected. */
  execPath: string
  /** Node executable for checkout launches; defaults to `node` on PATH. */
  nodeCommand?: string
  /** Platform for the permission-mode fallback; defaults to the running platform. */
  platform?: NodeJS.Platform
  exists?: (path: string) => boolean
}

/**
 * The harness has no confinement backend on Windows, so its default
 * `workspace-write` permission mode cannot boot there. The shell falls back to
 * `danger-full-access` when the mode is unset, exactly the environment a
 * Windows user must otherwise supply for every `dsh` invocation; an explicit
 * `DSH_PERMISSION_MODE` always wins.
 */
export const WINDOWS_PERMISSION_FALLBACK = 'danger-full-access' as const

/**
 * Resolve how to launch `dsh web`. Order: `DSH_BIN` env → embedded deploy
 * closure (`deploy/node_modules/@deepseek-ai/dsh/lib/bin.js`, run under
 * Electron-as-Node) → this checkout's CLI (built `lib/bin.js` on Node, else
 * the tsx source launch the repo's own `pnpm run dsh` uses) → `dsh` on PATH.
 * @param options - environment facts; `exists` defaults to the real filesystem.
 * @returns the spawn descriptor.
 */
export function resolveWebLaunch(options: LaunchEnvironment): WebServerLaunch {
  const exists = options.exists ?? existsSync
  const platform = options.platform ?? process.platform
  const permissionMode = platform === 'win32' && options.env.DSH_PERMISSION_MODE === undefined
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
      args: [embedded, ...WEB_ARGS],
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
  if (candidate === undefined) return undefined
  try {
    const url = new URL(candidate)
    return url.port === '' ? undefined : url
  } catch {
    return undefined
  }
}

export interface ReadyLineOptions {
  /** How long to wait for the readiness line before failing. */
  timeoutMs?: number
  /** Receives every raw chunk, for logging. */
  onChunk?: (chunk: string) => void
}

/**
 * Wait for the `dsh web` readiness line on the child's stdout. Resolves with
 * the advertised URL; rejects when the stream ends first (the server exited
 * without ever listening) or after {@link ReadyLineOptions.timeoutMs}. The
 * timeout and the line scan race; whichever settles first wins.
 * @param stdout - the child's stdout as an async iterable of string chunks.
 * @param options - timeout and logging hooks.
 * @returns the readiness-line URL.
 */
export function waitForReadyLine(stdout: AsyncIterable<string>, options: ReadyLineOptions = {}): Promise<URL> {
  const timeoutMs = options.timeoutMs ?? 60_000
  const loop = (async (): Promise<URL> => {
    // Chunks split lines arbitrarily; keep the unterminated tail across chunks.
    let buffer = ''
    for await (const chunk of stdout) {
      options.onChunk?.(chunk)
      buffer += chunk
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const url = parseReadyLine(line)
        if (url !== undefined) return url
      }
    }
    // The stream ended: a final line without a trailing newline still counts.
    const url = parseReadyLine(buffer)
    if (url !== undefined) return url
    throw new Error('dsh-desktop: dsh web exited before printing its readiness line')
  })()
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => { reject(new Error(`dsh-desktop: no readiness line from dsh web within ${timeoutMs}ms`)) }, timeoutMs)
  })
  // Only one of the two can win the race; swallow the loser's rejection so it
  // never surfaces as an unhandled rejection.
  void loop.catch(() => {})
  return Promise.race([loop, timeout])
}

export interface HttpOkOptions {
  timeoutMs?: number
  pollIntervalMs?: number
  fetchImpl?: typeof fetch
}

/**
 * Poll the server URL until it answers HTTP 200. Each attempt carries a short
 * abort deadline so a wedged server cannot stall the poll past the overall timeout.
 * @param url - the readiness-line URL.
 * @param options - timeout, poll cadence, and an injectable fetch for tests.
 */
export async function waitForHttpOk(url: URL, options: HttpOkOptions = {}): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 30_000
  const pollIntervalMs = options.pollIntervalMs ?? 250
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = new Error('no attempt made')
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }
  throw new Error(`dsh-desktop: server not reachable at ${url.href} within ${timeoutMs}ms (last error: ${String(lastError)})`)
}
