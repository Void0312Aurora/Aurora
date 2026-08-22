/** Launch the built extension in an isolated VS Code Extension Development Host. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runTests } from '@vscode/test-electron'

const testRoot = fileURLToPath(new URL('.', import.meta.url))
const extensionDevelopmentPath = resolve(testRoot, '..', '..')
const extensionTestsPath = join(testRoot, 'suite', 'index.mjs')
const fixtureServer = join(testRoot, 'fixture-dsh.mjs')
const temporary = await mkdtemp(join(tmpdir(), 'dsh-vscode-electron-'))
const workspace = join(temporary, 'workspace')
const eventLog = join(temporary, 'events.jsonl')
const snapshot = join(testRoot, 'extension.expected.md')

await mkdir(workspace)
await writeFile(join(workspace, 'seed.ts'), 'export const assembled = true\n')
// DSH_BIN receives the normal `web --host ...` argv. Point it at Node and
// provide the expected `web` entry in the test workspace; this avoids shell
// wrappers and exercises the same argv/cwd path on every platform.
await writeFile(join(workspace, 'web'), `import(${JSON.stringify(pathToFileURL(fixtureServer).href)}).catch(error => { console.error(error); process.exitCode = 1 })\n`)

try {
  await runTests({
    ...(process.env.DSH_VSCODE_EXECUTABLE === undefined
      ? { version: '1.125.0' }
      : { vscodeExecutablePath: process.env.DSH_VSCODE_EXECUTABLE }),
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [workspace, '--disable-extensions'],
    extensionTestsEnv: {
      // The harness launcher uses Electron-as-Node for embedded closures, but
      // the test host itself must boot as Electron even when the caller has
      // this variable set.
      ELECTRON_RUN_AS_NODE: undefined,
      DSH_BIN: process.execPath,
      DSH_PERMISSION_MODE: 'danger-full-access',
      DSH_VSCODE_TEST_EXTENSION: extensionDevelopmentPath,
      DSH_VSCODE_TEST_LOG: eventLog,
      DSH_VSCODE_TEST_SNAPSHOT: snapshot,
    },
  })
} catch (error) {
  try {
    console.error(`VS Code fixture event log:\n${await readFile(eventLog, 'utf8')}`)
  } catch {
    console.error('VS Code fixture emitted no event log')
  }
  throw error
} finally {
  await rm(temporary, { recursive: true, force: true })
}
