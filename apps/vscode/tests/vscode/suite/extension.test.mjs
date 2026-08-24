/** Assembled built-extension round trip through the production CLI and webview. */

import assert from 'node:assert/strict'
import { access, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import * as vscode from 'vscode'

async function delay(ms) {
  await new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

async function waitForFile(path, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await access(path)
      return
    } catch {
      await delay(100)
    }
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

function contentText(event) {
  const blocks = event?.data?.content
  if (!Array.isArray(blocks)) return ''
  return blocks.filter(block => block?.type === 'text').map(block => block.text).join('')
}

suite('built DeepSeek Harness extension', () => {
  test('drives a real prompt after exact-session IDE context admission and restarts', async () => {
    const workspace = vscode.workspace.workspaceFolders?.[0]
    assert.ok(workspace)
    const extensionRoot = process.env.DSH_VSCODE_TEST_EXTENSION
    const driverReady = process.env.DSH_VSCODE_DRIVER_READY
    const driverResult = process.env.DSH_VSCODE_DRIVER_RESULT
    const sessionsRoot = process.env.DSH_VSCODE_SESSIONS_ROOT
    assert.ok(extensionRoot)
    assert.ok(driverReady)
    assert.ok(driverResult)
    assert.ok(sessionsRoot)

    const extension = vscode.extensions.all.find(candidate => resolve(candidate.extensionPath) === resolve(extensionRoot))
    assert.ok(extension, `development extension not found at ${extensionRoot}`)
    await extension.activate()
    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(workspace.uri, 'seed.ts'))
    await vscode.window.showTextDocument(document)
    await vscode.commands.executeCommand('dsh.openPanel')
    await writeFile(driverReady, 'ready\n')
    await waitForFile(driverResult)

    const driver = JSON.parse(await readFile(driverResult, 'utf8'))
    assert.equal(typeof driver.snapshot, 'string')
    assert.match(driver.snapshot, /Reply with the single word LIGHTHOUSE and stop\./)
    assert.match(driver.snapshot, /LIGHTHOUSE/)
    assert.match(driver.snapshot, /Describe what you want to build/)

    const logs = await findSessionLogs(sessionsRoot)
    assert.equal(logs.length, 1, `expected one production session log, got ${logs.join(', ')}`)
    const events = (await readFile(logs[0], 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line))
    const contextIndex = events.findIndex(event => (
      event.type === 'user/message'
      && event.data?.source?.kind === 'plugin'
      && event.data.source.plugin === 'ide'
    ))
    const promptIndex = events.findIndex(event => (
      event.type === 'user/message'
      && event.data?.source?.kind === 'user'
      && contentText(event) === driver.prompt
    ))
    const requestIndex = events.findIndex((event, index) => index > promptIndex && event.type === 'request/header')
    assert.ok(contextIndex >= 0, 'production log has no IDE context event')
    assert.ok(contentText(events[contextIndex]).includes('seed.ts'), 'IDE context does not contain the opened seed.ts')
    assert.ok(promptIndex > contextIndex, `prompt index ${promptIndex} must follow context index ${contextIndex}`)
    assert.ok(requestIndex > promptIndex, `request/header index ${requestIndex} must follow prompt index ${promptIndex}`)

    await vscode.commands.executeCommand('dsh.restartServer')
    assert.equal(extension.isActive, true)
  }).timeout(120_000)
})
