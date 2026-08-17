/** Assembled built-extension lifecycle, context, and native-approval smoke. */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import * as vscode from 'vscode'

async function events() {
  const path = process.env.DSH_VSCODE_TEST_LOG
  if (path === undefined) throw new Error('DSH_VSCODE_TEST_LOG is required')
  try {
    return (await readFile(path, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const value = await events()
    if (predicate(value)) return value
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`timed out waiting for ${message}`)
}

suite('built DeepSeek Harness extension', () => {
  test('activates the panel, injects existing editor context, answers natively, and restarts', async () => {
    const workspace = vscode.workspace.workspaceFolders?.[0]
    assert.ok(workspace)
    const extensionRoot = process.env.DSH_VSCODE_TEST_EXTENSION
    assert.ok(extensionRoot)
    const extension = vscode.extensions.all.find(candidate => resolve(candidate.extensionPath) === resolve(extensionRoot))
    assert.ok(extension, `development extension not found at ${extensionRoot}`)
    await extension.activate()
    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(workspace.uri, 'seed.ts'))
    await vscode.window.showTextDocument(document)

    await vscode.commands.executeCommand('dsh.openPanel')
    await waitFor(log => log.some(event => event.type === 'context-injected'), 'the existing editor context injection')
    await waitFor(log => log.some(event => event.type === 'mux-stream-opened'), 'the native approval stream')

    for (let attempt = 0; attempt < 20; attempt++) {
      await vscode.commands.executeCommand('workbench.action.focusQuickOpen')
      await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext')
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem')
      const log = await events()
      if (log.some(event => event.type === 'approval-response')) break
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
    }
    const beforeRestart = await waitFor(log => log.some(event => event.type === 'approval-response'), 'the native approval response')
    await vscode.commands.executeCommand('dsh.restartServer')
    const finalLog = await waitFor(log => log.filter(event => event.type === 'server-started').length >= 2, 'the replacement server generation')

    assert.equal(extension?.isActive, true)
    const context = beforeRestart.find(event => event.type === 'context-injected')
    const approval = beforeRestart.find(event => event.type === 'approval-response')
    const text = context?.payload?.content?.[0]?.text
    const actual = [
      '# VS Code built-extension smoke',
      '',
      `extension-active: ${String(extension?.isActive)}`,
      `server-generations: ${String(finalLog.filter(event => event.type === 'server-started').length)}`,
      `context-session: ${String(context?.payload?.sessionId)}`,
      `context-has-seed-file: ${String(typeof text === 'string' && text.includes('seed.ts'))}`,
      `context-has-source: ${String(typeof text === 'string' && text.includes('export const assembled = true'))}`,
      `approval-session: ${String(approval?.value?.sessionId)}`,
      `approval-outcome: ${String(approval?.value?.outcome)}`,
      '',
    ].join('\n')
    const snapshotPath = process.env.DSH_VSCODE_TEST_SNAPSHOT
    assert.ok(snapshotPath)
    assert.equal(actual, await readFile(snapshotPath, 'utf8'))
  })
})
