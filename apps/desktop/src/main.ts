/**
 * dsh-desktop Electron main: single-instance lock, spawn `dsh web` via the
 * launcher, wait for readiness, host the GUI in a standalone window, and keep
 * the server alive in the tray after the window closes. Closing the window
 * hides it (tray residency); quitting via the tray menu terminates the server
 * child and exits.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, Menu, nativeImage, shell, Tray } from 'electron'
import { resolveWebLaunch, waitForHttpOk, waitForReadyLine, childExited } from './launcher.ts'

const APP_ID = 'ai.deepseek.dsh-desktop'
const WINDOW_TITLE = 'DSH Desktop'
const STDERR_TAIL_LIMIT = 4_000
/** `apps/desktop` in dev, the asar root when packaged. */
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let server: ChildProcess | undefined
let serverUrl: URL | undefined
let quitting = false
// A focus request (second launch, tray click) that arrived while the server
// was still booting and no window existed yet; honored once boot completes.
let pendingFocus = false

function iconPath(): string {
  return join(PACKAGE_DIR, 'build', 'icon.png')
}

function trayIconPath(): string {
  return join(PACKAGE_DIR, 'build', 'tray-icon.png')
}

/**
 * Terminate a process and its descendants. On Windows `child.kill()` is
 * `TerminateProcess` of the direct child only, so a tree kill is needed to
 * reach the server's own subprocesses (bash, sandbox helpers).
 * @param pid - the process to terminate.
 */
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
      // taskkill always exists on Windows; the handler only prevents an
      // uncaught 'error' crash if it cannot be started at all.
      .on('error', () => {})
  } else {
    server?.kill()
  }
}

function showWindow(): void {
  if (mainWindow !== undefined) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    return
  }
  if (serverUrl !== undefined) createWindow(serverUrl)
  else pendingFocus = true
}

/**
 * Open a URL in the system browser — but only http(s) links: the GUI must
 * not be able to launch arbitrary programs via `file://` or a custom
 * protocol, and a navigation target that is not a parseable URL is dropped
 * too. `shell.openExternal` is fire-and-forget; its rejection must not
 * become an unhandled rejection in the Electron main process.
 * @param raw - the raw URL from the web contents.
 */
function openExternal(raw: string): void {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    // new URL(string) throws only SyntaxError for unparsable input; ignore.
    console.warn(`[dsh-desktop] ignoring unparsable external URL: ${raw}`)
    return
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    console.warn(`[dsh-desktop] ignoring non-http(s) external URL: ${raw}`)
    return
  }
  void shell.openExternal(raw).catch((error: unknown) => {
    console.error(`[dsh-desktop] failed to open ${raw}: ${error instanceof Error ? error.message : String(error)}`)
  })
}

function createWindow(url: URL): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    title: WINDOW_TITLE,
    show: false,
    autoHideMenuBar: true,
    icon: iconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow = window
  window.once('ready-to-show', () => { window.show() })
  void window.loadURL(url.href).catch((error: unknown) => {
    // The server may have died right after readiness; a failed load must
    // not crash the main process, the window just stays on its error page.
    console.error(`[dsh-desktop] failed to load ${url.href}: ${error instanceof Error ? error.message : String(error)}`)
  })
  window.on('close', (event) => {
    // Tray residency: closing hides the window and keeps the server running.
    if (quitting) return
    event.preventDefault()
    window.hide()
  })
  window.on('closed', () => { if (mainWindow === window) mainWindow = undefined })
  // The GUI is a single-page app; anything that opens a new window or
  // navigates away from the server origin belongs in the system browser.
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    openExternal(target)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, target) => {
    try {
      if (new URL(target).origin === url.origin) return
    } catch {
      // new URL(string) throws only SyntaxError for unparsable input; such a
      // target is not ours and is rejected below.
    }
    event.preventDefault()
    openExternal(target)
  })
}

function createTray(): void {
  const image = nativeImage.createFromPath(trayIconPath())
  const icon = image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 })
  tray = new Tray(icon)
  tray.setToolTip(WINDOW_TITLE)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Window', click: showWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.quit() } },
  ]))
  tray.on('click', showWindow)
}

function fatal(error: Error): void {
  console.error(`[dsh-desktop] ${error.message}`)
  dialog.showErrorBox(WINDOW_TITLE, error.message)
  // app.exit() skips before-quit; kill the server tree here so a boot failure
  // cannot leave an orphaned `dsh web` (the reaper only guards hard kills).
  quitting = true
  if (server?.pid !== undefined) killTree(server.pid)
  app.exit(1)
}

/**
 * Directory holding this package's runnable payload. In dev that is the
 * package itself; packaged, the embedded closure and the reaper are spawned
 * under Electron-as-Node, which cannot read inside `app.asar`, so they must
 * live in the unpacked tree.
 */
function runDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked') : PACKAGE_DIR
}

async function boot(): Promise<void> {
  const launch = resolveWebLaunch({
    env: process.env,
    appDir: runDir(),
    execPath: process.execPath,
  })
  if (launch.env.DSH_PERMISSION_MODE !== undefined && (process.env.DSH_PERMISSION_MODE === undefined || process.env.DSH_PERMISSION_MODE === '')) {
    console.warn(`[dsh-desktop] Windows has no harness confinement backend; using ${launch.env.DSH_PERMISSION_MODE} permission mode (approval prompts are disabled). Set DSH_PERMISSION_MODE to override.`)
  }
  console.log(`[dsh-desktop] launching dsh web (${launch.source}): ${launch.command} ${launch.args.join(' ')}`)
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: { ...process.env, ...launch.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  server = child
  let ready = false
  let stderrTail = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_LIMIT)
  })
  child.on('error', (error) => {
    // Spawn failure (command not found etc.): no child exists to clean up.
    fatal(new Error(`dsh-desktop: failed to spawn dsh web via ${launch.source}: ${error.message}`))
  })
  child.on('exit', (code, signal) => {
    // Attached immediately so a crash during readiness cannot go unreported;
    // before readiness the readiness wait itself fails (the stream ends), so
    // the boot error path owns the message.
    if (quitting || !ready) return
    void dialog.showMessageBox({
      type: 'error',
      title: WINDOW_TITLE,
      message: 'dsh web exited unexpectedly',
      detail: `code ${String(code)} signal ${String(signal)}\n${stderrTail}`,
    }).finally(() => { app.quit() })
  })
  // Windows has no parent-death notification; the reaper polls this process
  // and tree-kills the server if the main is ever hard-killed (Task Manager,
  // taskkill, a crash), so `dsh web` cannot outlive its window. The reaper
  // stays alive across a graceful quit too: it detects the main's exit and
  // finishes the cleanup even if the quit path's own taskkill races the exit.
  if (process.platform === 'win32') {
    spawn(process.execPath, [join(runDir(), 'lib', 'reaper.js'), String(process.pid), String(child.pid ?? 0)], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'ignore',
      windowsHide: true,
    })
      // The reaper is best-effort: if it cannot start, the graceful quit path
      // still tree-kills the server; only hard-kill cleanup is lost.
      .on('error', () => {})
  }
  // Readable stream: yield strings, and a multibyte character split across
  // chunks is reassembled by the decoder instead of mojibaked.
  child.stdout.setEncoding('utf8')
  let url: URL | undefined
  try {
    url = await waitForReadyLine(child.stdout, {
      onChunk: (chunk) => { process.stdout.write(`[dsh web] ${chunk}`) },
    })
    await waitForHttpOk(url)
    // A 200 on the readiness port is not necessarily ours: if the child
    // exited while the poll ran, some other local server may have answered.
    // Hosting a stranger's process would be a mistake, so fail the boot
    // instead (the catch below owns the fatal dialog).
    if (childExited(child)) {
      throw new Error(`dsh-desktop: dsh web exited (code ${String(child.exitCode)} signal ${String(child.signalCode)}) while its port was verified; not adopting the server`)
    }
    ready = true
    serverUrl = url
  } catch (error) {
    fatal(error instanceof Error ? new Error(`${error.message}\n${stderrTail}`) : new Error(String(error)))
  }
  if (url === undefined) return
  Menu.setApplicationMenu(null)
  createWindow(url)
  createTray()
  // A focus request cached while the server was booting (second launch, tray
  // click) is honored now that the window exists; the request would have been
  // silently lost otherwise. Deliberately after createWindow, so the cached
  // request surfaces this one window instead of spawning a second.
  if (pendingFocus) {
    pendingFocus = false
    showWindow()
  }
}

// Tray residency means the app outlives its window; a second launch must focus
// the existing window instead of starting a second server.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)
  app.setAppUserModelId(APP_ID)
  app.whenReady().then(boot).catch(fatal)
  app.on('before-quit', () => {
    quitting = true
    // The reaper is deliberately left alive: it polls this process, so after
    // the main exits it performs the same tree kill — guaranteeing cleanup
    // even if the taskkill spawned here races the process exit.
    if (server?.pid !== undefined) killTree(server.pid)
  })
  // Tray residency: the app outlives its window by design, so a destroyed
  // window must not trigger Electron's default quit.
  app.on('window-all-closed', () => {})
}
