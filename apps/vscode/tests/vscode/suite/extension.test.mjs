/** Assembled built-extension round trip through the production CLI and webview. */

import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import * as vscode from 'vscode'

async function delay(ms) {
  await new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

async function waitForDriverFile(path, failure, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    try {
      const failed = JSON.parse(await readFile(failure, 'utf8'))
      throw new Error(`VS Code webview driver failed: ${String(failed.message)}\n${String(failed.stack ?? '')}`)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await delay(100)
  }
  throw new Error(`timed out waiting for ${path}`)
}

async function findSessionLogs(root) {
  const found = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && entry.name === 'session.jsonl') found.push(path)
    }
  }
  await visit(root)
  return found
}

async function sessionEventLogs(root) {
  const logs = []
  for (const path of await findSessionLogs(root)) {
    const text = await readFile(path, 'utf8')
    const lines = text.trim().split(/\r?\n/).filter(Boolean)
    const events = []
    for (let index = 0; index < lines.length; index++) {
      try {
        events.push(JSON.parse(lines[index]))
      } catch (error) {
        if (index !== lines.length - 1) throw error
      }
    }
    logs.push(events)
  }
  return logs
}

async function waitForSessionEvents(root, predicate, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const logs = await sessionEventLogs(root)
    if (predicate(logs)) return logs
    await delay(100)
  }
  throw new Error(`timed out waiting for ${message}`)
}

function contentText(event) {
  const blocks = event?.data?.content
  if (!Array.isArray(blocks)) return ''
  return blocks.filter(block => block?.type === 'text').map(block => block.text).join('')
}

function toolResultCount(logs) {
  return logs.flat().filter(event => event.type === 'tool/result').length
}

/**
 * Return the current turn's rich transcript plus composer chrome. A restarted
 * runtime restores the same session, so the root may also contain earlier
 * turns and cumulative stats; compare the stable last-turn projection instead
 * of treating that retained history as a rendering failure.
 */
function lastRichTurnSnapshot(snapshot, prompt) {
  const marker = `- text: ${prompt} {{clock}}`
  const promptStart = snapshot.lastIndexOf(marker)
  if (promptStart < 0) throw new Error('rich webview snapshot omitted the current user prompt')
  const start = snapshot.indexOf('- button "Think ', promptStart)
  if (start < 0) throw new Error('rich webview snapshot omitted the current assistant/tool flow')
  return snapshot.slice(start).replace(
    /- text: \d+ turns · \d+ steps Tool call \{\{duration\}\} Cache hit \d+% Input [\d.]+K tok · Output [\d.]+ tok/g,
    '- text: {{turn-stats}}',
  )
}

async function waitForNativeQuestionAnswer(sessionsRoot, expectedResults) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const logs = await sessionEventLogs(sessionsRoot)
    if (toolResultCount(logs) >= expectedResults) return
    // Quick Pick opens with the first option selected. Use the workbench's
    // normal accept command so the pinned VS Code build dispatches
    // QuickPick.onDidAccept instead of treating a pointer event as hide-only.
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem').catch(() => undefined)
    await delay(100)
  }
  await waitForSessionEvents(
    sessionsRoot,
    logs => toolResultCount(logs) >= expectedResults,
    `native question answer ${String(expectedResults)}`,
  )
}

function assertPromptAdmission(logs, prompt) {
  const promptLocations = []
  for (const events of logs) {
    for (let index = 0; index < events.length; index++) {
      const event = events[index]
      if (event.type !== 'user/message' || event.data?.source?.kind !== 'user' || contentText(event) !== prompt) continue
      promptLocations.push({ events, index })
    }
  }
  assert.ok(promptLocations.length >= 2, `expected two bridged prompts, got ${String(promptLocations.length)}`)
  for (const { events, index: promptIndex } of promptLocations) {
    const contextIndex = events.findLastIndex((event, index) => (
      index < promptIndex
      && event.type === 'user/message'
      && event.data?.source?.kind === 'plugin'
      && event.data.source.plugin === 'ide'
    ))
    const requestIndex = events.findIndex((event, index) => index > promptIndex && event.type === 'request/header')
    assert.ok(contextIndex >= 0, 'production log has no IDE context event before a prompt')
    assert.ok(contentText(events[contextIndex]).includes('seed.ts'), 'IDE context does not contain the opened seed.ts')
    assert.ok(requestIndex > promptIndex, `request/header index ${String(requestIndex)} must follow prompt index ${String(promptIndex)}`)
  }
}

suite('built DeepSeek Harness extension', () => {
  test('drives native questions through two ready server generations', async () => {
    const workspace = vscode.workspace.workspaceFolders?.[0]
    assert.ok(workspace)
    const extensionRoot = process.env.DSH_VSCODE_TEST_EXTENSION
    const driverReady = process.env.DSH_VSCODE_DRIVER_READY
    const driverMilestone = process.env.DSH_VSCODE_DRIVER_MILESTONE
    const driverResult = process.env.DSH_VSCODE_DRIVER_RESULT
    const driverFailure = process.env.DSH_VSCODE_DRIVER_FAILURE
    const restartReady = process.env.DSH_VSCODE_RESTART_READY
    const restartMilestone = process.env.DSH_VSCODE_RESTART_MILESTONE
    const restartResult = process.env.DSH_VSCODE_RESTART_RESULT
    const sessionsRoot = process.env.DSH_VSCODE_SESSIONS_ROOT
    const snapshotPath = process.env.DSH_VSCODE_TEST_SNAPSHOT
    const webviewSnapshotPath = process.env.DSH_VSCODE_TEST_WEBVIEW_SNAPSHOT
    const personalMarker = process.env.DSH_VSCODE_PERSONAL_MARKER
    assert.ok(extensionRoot)
    assert.ok(driverReady)
    assert.ok(driverMilestone)
    assert.ok(driverResult)
    assert.ok(driverFailure)
    assert.ok(restartReady)
    assert.ok(restartMilestone)
    assert.ok(restartResult)
    assert.ok(sessionsRoot)
    assert.ok(snapshotPath)
    assert.ok(webviewSnapshotPath)
    assert.ok(personalMarker)

    const extension = vscode.extensions.all.find(candidate => resolve(candidate.extensionPath) === resolve(extensionRoot))
    assert.ok(extension, `development extension not found at ${extensionRoot}`)
    await extension.activate()
    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(workspace.uri, 'seed.ts'))
    await vscode.window.showTextDocument(document)
    await vscode.commands.executeCommand('dsh.openPanel')
    await writeFile(driverReady, 'ready\n')

    const expectedSnapshot = await readFile(snapshotPath, 'utf8')
    const expectedWebviewSnapshot = await readFile(webviewSnapshotPath, 'utf8')
    const firstMilestone = await waitForDriverFile(driverMilestone, driverFailure)
    assert.equal(`${String(firstMilestone.snapshot)}\n`, expectedSnapshot)
    assert.equal(firstMilestone.workspacePicker, 'browse-dialog')
    assert.equal(await readFile(personalMarker, 'utf8'), 'personal overlay active\n')
    await waitForNativeQuestionAnswer(sessionsRoot, 1)
    const firstResult = await waitForDriverFile(driverResult, driverFailure)
    assert.equal(firstResult.final, "Great, let's move forward. BANANA!")
    assert.equal(`${String(firstResult.snapshot)}\n`, expectedWebviewSnapshot)

    await vscode.commands.executeCommand('dsh.restartServer')
    await writeFile(restartReady, 'ready\n')
    const replacementMilestone = await waitForDriverFile(restartMilestone, driverFailure)
    assert.equal(`${String(replacementMilestone.snapshot)}\n`, expectedSnapshot)
    await waitForNativeQuestionAnswer(sessionsRoot, 2)
    const replacementResult = await waitForDriverFile(restartResult, driverFailure)
    assert.equal(replacementResult.final, "Great, let's move forward. BANANA!")
    assert.equal(
      lastRichTurnSnapshot(String(replacementResult.snapshot), firstMilestone.prompt),
      lastRichTurnSnapshot(String(firstResult.snapshot), firstMilestone.prompt),
    )

    const logs = await waitForSessionEvents(
      sessionsRoot,
      eventLogs => eventLogs.flat().filter(event => (
        event.type === 'user/message'
        && event.data?.source?.kind === 'user'
        && contentText(event) === firstMilestone.prompt
      )).length >= 2,
      'the replacement bridged prompt',
    )
    assertPromptAdmission(logs, firstMilestone.prompt)
    assert.equal(extension.isActive, true)
  }).timeout(240_000)
})
