/** Drive the real built webview through VS Code's remote-debugging endpoint. */

import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'

const PROMPT = 'Reply with the single word LIGHTHOUSE and stop.'

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForFile(path, timeoutMs = 60_000) {
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

async function connect(endpoint) {
  const deadline = Date.now() + 60_000
  let lastError
  while (Date.now() < deadline) {
    try {
      return await chromium.connectOverCDP(endpoint)
    } catch (error) {
      lastError = error
      await delay(200)
    }
  }
  throw new Error(`could not connect to VS Code CDP at ${endpoint}: ${String(lastError)}`)
}

async function findWebviewFrame(browser) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        for (const frame of page.frames()) {
          if (frame.url().startsWith('vscode-webview://') && await frame.locator('[class*="frame"]').count() > 0) {
            return frame
          }
        }
      }
    }
    await delay(100)
  }
  throw new Error('timed out waiting for the built DeepSeek Harness webview frame')
}

function normalizeSnapshot(snapshot, temporary) {
  return snapshot
    .replaceAll(temporary, '{{temporary}}')
    .replaceAll(temporary.replaceAll('\\', '/'), '{{temporary}}')
}

export async function driveWebview(options) {
  await waitForFile(options.ready)
  const browser = await connect(options.endpoint)
  try {
    const frame = await findWebviewFrame(browser)
    await frame.getByRole('button', { name: 'Choose workspace' }).click()
    const dialog = frame.getByRole('dialog', { name: 'Select Workspace Directory' })
    await dialog.waitFor({ timeout: 15_000 })
    await dialog.getByRole('button', { name: 'Edit path' }).click()
    const pathInput = dialog.getByRole('textbox', { name: 'Edit path' })
    const project = join(options.workspace, 'project')
    await pathInput.fill(project)
    await pathInput.press('Enter')
    await dialog.getByRole('button', { name: 'Open', exact: true }).click()

    const composer = frame.locator('textarea:enabled[placeholder="Describe what you want to build"]')
    await composer.waitFor({ timeout: 20_000 })
    await composer.fill(PROMPT)
    await composer.press('Enter')
    await frame.getByText('LIGHTHOUSE', { exact: true }).waitFor({ timeout: 60_000 })
    const snapshot = await frame.locator('[class*="centerCol"]').ariaSnapshot({ timeout: 15_000 })
    await writeFile(options.result, JSON.stringify({ prompt: PROMPT, snapshot: normalizeSnapshot(snapshot, options.temporary) }))
    return browser
  } catch (error) {
    await browser.close().catch(() => undefined)
    throw error
  }
}
