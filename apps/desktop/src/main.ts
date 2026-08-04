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
import { resolveWebLaunch, waitForHttpOk, waitForReadyLine } from './launcher.ts'

const APP_ID = 'ai.deepseek.dsh-desktop'
const WINDOW_TITLE = 'DSH Desktop'
const STDERR_TAIL_LIMIT = 4_000
/** `apps/desktop` in dev, the asar root when packaged. */
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let server: ChildProcess | undefined
let reaper: ChildProcess | undefined
let serverUrl: URL | undefined
let quitting = false

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
  void window.loadURL(url.href)
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
    void shell.openExternal(target)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin === url.origin) return
    event.preventDefault()
    void shell.openExternal(target)
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
  app.exit(1)
}

async function boot(): Promise<void> {
  const launch = resolveWebLaunch({
    env: process.env,
    appDir: PACKAGE_DIR,
    isPackaged: app.isPackaged,
    execPath: process.execPath,
  })
  if (launch.env.DSH_PERMISSION_MODE !== undefined && process.env.DSH_PERMISSION_MODE === undefined) {
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
  // Windows has no parent-death notification; the reaper polls this process
  // and tree-kills the server if the main is ever hard-killed (Task Manager,
  // taskkill, a crash), so `dsh web` cannot outlive its window.
  if (process.platform === 'win32') {
    reaper = spawn(process.execPath, [join(PACKAGE_DIR, 'lib', 'reaper.js'), String(process.pid), String(child.pid ?? 0)], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'ignore',
      windowsHide: true,
    })
  }
  let stderrTail = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_LIMIT)
  })
  child.on('error', (error) => {
    // Spawn failure (command not found etc.): no child exists to clean up.
    fatal(new Error(`dsh-desktop: failed to spawn dsh web via ${launch.source}: ${error.message}`))
  })
  const url = await waitForReadyLine(child.stdout, {
    onChunk: (chunk) => { process.stdout.write(`[dsh web] ${chunk}`) },
  })
  await waitForHttpOk(url)
  serverUrl = url
  Menu.setApplicationMenu(null)
  createWindow(url)
  createTray()
  child.on('exit', (code, signal) => {
    if (quitting) return
    void dialog.showMessageBox({
      type: 'error',
      title: WINDOW_TITLE,
      message: 'dsh web exited unexpectedly',
      detail: `code ${String(code)} signal ${String(signal)}\n${stderrTail}`,
    }).finally(() => { app.quit() })
  })
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
    reaper?.kill()
    if (server?.pid !== undefined) killTree(server.pid)
  })
  // Tray residency: the app outlives its window by design, so a destroyed
  // window must not trigger Electron's default quit.
  app.on('window-all-closed', () => {})
}
