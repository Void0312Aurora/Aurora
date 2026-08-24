/** Launch the built extension in an isolated VS Code Extension Development Host. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runTests } from '@vscode/test-electron'
import { driveWebview } from './drive-webview.mjs'

const testRoot = fileURLToPath(new URL('.', import.meta.url))
const extensionDevelopmentPath = resolve(testRoot, '..', '..')
const extensionTestsPath = join(testRoot, 'suite', 'index.mjs')
const repoRoot = resolve(extensionDevelopmentPath, '..', '..')
const cliBin = join(repoRoot, 'apps', 'cli', 'lib', 'bin.js')
const replayModule = join(repoRoot, 'packages', 'support', 'llm-replay', 'lib', 'index.js')
const replayFixture = join(testRoot, 'session.jsonl')
const temporary = await mkdtemp(join(tmpdir(), 'dsh-vscode-electron-'))
const workspace = join(temporary, 'workspace')
const home = join(temporary, 'home')
const sessions = join(temporary, 'sessions')
const driverReady = join(temporary, 'driver-ready')
const driverResult = join(temporary, 'driver-result.json')

function probeFreePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        probe.close(() => { reject(new Error('CDP port probe returned no address')) })
        return
      }
      probe.close(() => { resolvePort(address.port) })
    })
  })
}

await mkdir(join(workspace, 'project'), { recursive: true })
await mkdir(home, { recursive: true })
await mkdir(sessions, { recursive: true })
await writeFile(join(workspace, 'seed.ts'), 'export const assembled = true\n')
// DSH_BIN receives the normal `web --host ...` argv. Point it at Node: Node
// consumes the first `web` as this bootstrap's script path, so restore the
// command word before loading the real built CLI.
await writeFile(join(workspace, 'web'), `process.argv.splice(2, 0, 'web'); import(${JSON.stringify(pathToFileURL(cliBin).href)}).catch(error => { console.error(error); process.exitCode = 1 })\n`)
await writeFile(join(home, 'config.yaml'), [
  '- id: llm-deepseek',
  '  disabled: true',
  '- insert:',
  '    - id: vscode-replay',
  '      name: !!js process.env.DSH_VSCODE_REPLAY_MODULE',
  '      config:',
  '        file: !!js process.env.DSH_SNAPSHOT_FILE',
  '        paceMs: 5',
  '        providers:',
  '          - id: deepseek-official',
  '            name: DeepSeek',
  '            models:',
  '              - id: deepseek-v4-flash',
  '- id: session-title-llm',
  '  disabled: true',
  '- id: session-persistence-jsonl',
  '  config:',
  '    root: !!js process.env.DSH_VSCODE_SESSIONS_ROOT',
  '    compression: none',
  '',
].join('\n'))

const cdpPort = await probeFreePort()
const driverTask = driveWebview({
  endpoint: `http://127.0.0.1:${cdpPort}`,
  ready: driverReady,
  result: driverResult,
  temporary,
  workspace,
})

try {
  const extensionHost = runTests({
    ...(process.env.DSH_VSCODE_EXECUTABLE === undefined
      ? { version: '1.125.0' }
      : { vscodeExecutablePath: process.env.DSH_VSCODE_EXECUTABLE }),
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [workspace, '--disable-extensions', `--remote-debugging-port=${cdpPort}`],
    extensionTestsEnv: {
      // The harness launcher uses Electron-as-Node for embedded closures, but
      // the test host itself must boot as Electron even when the caller has
      // this variable set.
      ELECTRON_RUN_AS_NODE: undefined,
      DSH_BIN: process.execPath,
      DSH_HOME: home,
      DSH_PERMISSION_MODE: 'danger-full-access',
      DSH_SNAPSHOT_FILE: replayFixture,
      DSH_TELEMETRY_DISABLED: '1',
      DSH_VSCODE_DRIVER_READY: driverReady,
      DSH_VSCODE_DRIVER_RESULT: driverResult,
      DSH_VSCODE_TEST_EXTENSION: extensionDevelopmentPath,
      DSH_VSCODE_REPLAY_MODULE: replayModule,
      DSH_VSCODE_SESSIONS_ROOT: sessions,
    },
  })
  const outcomes = await Promise.allSettled([extensionHost, driverTask])
  const driverOutcome = outcomes[1]
  if (driverOutcome?.status === 'fulfilled') {
    // connectOverCDP's close terminates the remote browser, so keep the
    // connection alive until the Extension Host has finished its restart
    // assertion and only then close the test process.
    await driverOutcome.value.close().catch(() => undefined)
  }
  const failed = outcomes.find(outcome => outcome.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
} catch (error) {
  try {
    console.error(`VS Code webview driver result:\n${await readFile(driverResult, 'utf8')}`)
  } catch {
    console.error('VS Code webview driver emitted no result')
  }
  throw error
} finally {
  await rm(temporary, { recursive: true, force: true })
}
