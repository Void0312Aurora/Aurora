/** Launch the built extension in an isolated VS Code Extension Development Host. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runTests } from '@vscode/test-electron'
import { parseLoaderConfig, validateLoaderMetadata } from '../../../../scripts/cordis-loader-metadata.mjs'
import {
  WELCOME_NOTICE_ACK_FIELD, WELCOME_NOTICE_SETTINGS_NAMESPACE, WELCOME_NOTICE_VERSION,
} from '../../../../packages/client/ui-settings-general/src/onboarding-copy.ts'
import { renderReplayOverlay } from './config.mjs'
import { driveWebview } from './drive-webview.mjs'

const testRoot = fileURLToPath(new URL('.', import.meta.url))
const extensionDevelopmentPath = resolve(testRoot, '..', '..')
const extensionTestsPath = join(testRoot, 'suite', 'index.mjs')
const repoRoot = resolve(extensionDevelopmentPath, '..', '..')
const cliBin = join(repoRoot, 'apps', 'cli', 'lib', 'bin.js')
const replayModule = join(repoRoot, 'packages', 'support', 'llm-replay', 'lib', 'index.js')
const directoryPickerModule = join(repoRoot, 'packages', 'host', 'directory-picker-browse', 'lib', 'index.js')
const replayFixture = join(repoRoot, 'apps', 'web', 'tests', 'snapshots', 'steering', 'session.jsonl')
const expectedSnapshot = join(testRoot, 'extension.expected.md')
const temporary = await mkdtemp(join(tmpdir(), 'dsh-vscode-electron-'))
const workspace = join(temporary, 'workspace')
const home = join(temporary, 'home')
const sessions = join(temporary, 'sessions')
const testConfig = join(temporary, 'vscode-test.cordis.yml')
const driverReady = join(temporary, 'driver-ready')
const driverMilestone = join(temporary, 'driver-milestone.json')
const driverResult = join(temporary, 'driver-result.json')
const driverFailure = join(temporary, 'driver-failure.json')
const restartReady = join(temporary, 'restart-ready')
const restartMilestone = join(temporary, 'restart-milestone.json')
const restartResult = join(temporary, 'restart-result.json')

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
// This scenario validates the assembled extension, native question surface,
// and runtime replacement. Keep the product onboarding state out of that path
// just as ordinary web E2E worlds do; its dedicated tests leave this pending.
await writeFile(join(home, 'settings.yaml'), [
  `${WELCOME_NOTICE_SETTINGS_NAMESPACE}:`,
  `  ${WELCOME_NOTICE_ACK_FIELD}: ${JSON.stringify(WELCOME_NOTICE_VERSION)}`,
  '',
].join('\n'))
// DSH_BIN receives the normal `web --host ...` argv. Point it at Node: Node
// consumes the first `web` as this bootstrap's script path, so restore the
// command word before loading the real built CLI.
await writeFile(join(workspace, 'web'), `process.argv.splice(2, 0, 'web'); import(${JSON.stringify(pathToFileURL(cliBin).href)}).catch(error => { console.error(error); process.exitCode = 1 })\n`)
const overlay = renderReplayOverlay({
  directoryPickerModule: pathToFileURL(directoryPickerModule).href,
  replayModule: pathToFileURL(replayModule).href,
})
const overlayErrors = validateLoaderMetadata(parseLoaderConfig(overlay), 'generated-vscode-overlay')
if (overlayErrors.length > 0) {
  throw new Error(`invalid generated VS Code Loader overlay:\n${overlayErrors.join('\n')}`)
}
await writeFile(testConfig, overlay)

const cdpPort = await probeFreePort()
const driverTask = driveWebview({
  endpoint: `http://127.0.0.1:${cdpPort}`,
  ready: driverReady,
  milestone: driverMilestone,
  result: driverResult,
  restartReady,
  restartMilestone,
  restartResult,
  temporary,
  workspace,
}).catch(async (error) => {
  await writeFile(driverFailure, JSON.stringify({
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  }))
  throw error
})

try {
  const extensionHost = runTests({
    ...(process.env.DSH_VSCODE_EXECUTABLE === undefined
      ? { version: '1.125.0' }
      : { vscodeExecutablePath: process.env.DSH_VSCODE_EXECUTABLE }),
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [workspace, '--disable-extensions', '--locale=en', `--remote-debugging-port=${cdpPort}`],
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
      DSH_VSCODE_DRIVER_MILESTONE: driverMilestone,
      DSH_VSCODE_DRIVER_RESULT: driverResult,
      DSH_VSCODE_DRIVER_FAILURE: driverFailure,
      DSH_VSCODE_RESTART_READY: restartReady,
      DSH_VSCODE_RESTART_MILESTONE: restartMilestone,
      DSH_VSCODE_RESTART_RESULT: restartResult,
      DSH_VSCODE_TEST_EXTENSION: extensionDevelopmentPath,
      DSH_VSCODE_TEST_CONFIG: testConfig,
      DSH_VSCODE_TEST_RUNTIME_TRACE: '1',
      DSH_VSCODE_TEST_SNAPSHOT: expectedSnapshot,
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
  if (driverOutcome?.status === 'rejected') throw driverOutcome.reason
  const failed = outcomes.find(outcome => outcome.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
} catch (error) {
  for (const [label, path] of [
    ['failure', driverFailure],
    ['first milestone', driverMilestone],
    ['first result', driverResult],
    ['restart milestone', restartMilestone],
    ['restart result', restartResult],
  ]) {
    try {
      console.error(`VS Code webview driver ${label}:\n${await readFile(path, 'utf8')}`)
    } catch {
      console.error(`VS Code webview driver emitted no ${label}`)
    }
  }
  throw error
} finally {
  await rm(temporary, { recursive: true, force: true })
}
