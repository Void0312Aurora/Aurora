/** Drive the real built webview through VS Code's remote-debugging endpoint. */

import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'

const PROMPT = 'Use the ask_user_question tool to ask me exactly one question with id "checkpoint", question "Ready to continue?", header "Checkpoint", and options labeled "Yes" and "No". After I answer, reply with one short sentence acknowledging my answer and stop.'
const FINAL = "Great, let's move forward. BANANA!"

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
          if (
            !frame.url().startsWith('vscode-file://')
            && await frame.locator('#root').count().catch(() => 0) > 0
          ) return frame
        }
      }
    }
    await delay(100)
  }
  throw new Error('timed out waiting for the built DeepSeek Harness webview frame')
}

async function findNativeQuestion(browser) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        for (const frame of page.frames()) {
          const question = frame.locator('.quick-input-widget').filter({ hasText: 'Ready to continue?' })
          if (await question.isVisible().catch(() => false)) return question
        }
      }
    }
    await delay(100)
  }
  throw new Error('timed out waiting for the native VS Code question control')
}

function observeBrowser(browser, messages) {
  const watched = new WeakSet()
  const watch = (page) => {
    if (watched.has(page)) return
    watched.add(page)
    page.on('console', message => { messages.push(`console:${message.type()}: ${message.text()}`) })
    page.on('pageerror', error => { messages.push(`pageerror: ${error.stack ?? error.message}`) })
    page.on('requestfailed', request => {
      messages.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`)
    })
  }
  for (const context of browser.contexts()) {
    for (const page of context.pages()) watch(page)
    context.on('page', watch)
  }
}

async function browserDiagnostic(browser, messages) {
  const frames = []
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      for (const frame of page.frames()) {
        let body = ''
        let html = ''
        try {
          body = (await frame.locator('body').innerText({ timeout: 500 })).slice(0, 500)
        } catch {}
        try {
          html = (await frame.locator('body').innerHTML({ timeout: 500 })).slice(0, 1_000)
        } catch {}
        frames.push({ url: frame.url(), body, html })
      }
    }
  }
  return JSON.stringify({ frames, messages })
}

function normalizeSnapshot(snapshot, temporary) {
  return snapshot
    .replaceAll(temporary, '{{temporary}}')
    .replaceAll(temporary.replaceAll('\\', '/'), '{{temporary}}')
}

async function captureStableSnapshot(locator, temporary) {
  const deadline = Date.now() + 5_000
  let previous = normalizeSnapshot(await locator.ariaSnapshot({ timeout: 15_000 }), temporary)
  while (Date.now() < deadline) {
    await delay(100)
    const current = normalizeSnapshot(await locator.ariaSnapshot({ timeout: 15_000 }), temporary)
    if (current === previous) return current
    previous = current
  }
  throw new Error('aria snapshot did not stabilize')
}

async function dismissOnboarding(frame) {
  const onboarding = frame.getByRole('button', { name: /^(Continue|继续)$/ })
  if (await onboarding.isVisible().catch(() => false)) await onboarding.click()
}

async function ensureWorkspace(frame, workspace) {
  const onboarding = frame.getByRole('button', { name: /^(Continue|继续)$/ })
  // The same composer changes its localized placeholder when workspace
  // creation promotes the blank hero into an active session. Bind to the
  // control's stable role/state instead of one transient copy string.
  const composer = frame.locator('textarea:enabled').first()
  const choose = frame.getByRole('button', { name: 'Choose workspace' })
  const surfaceDeadline = Date.now() + 10_000
  while (Date.now() < surfaceDeadline) {
    if (await onboarding.isVisible().catch(() => false)) {
      await onboarding.click()
      break
    }
    if (await composer.isVisible().catch(() => false)) return composer
    if (await choose.isVisible().catch(() => false)) break
    await delay(100)
  }
  if (await composer.isVisible().catch(() => false)) return composer
  await choose.waitFor({ timeout: 30_000 })
  const dialog = frame.getByRole('dialog', { name: 'Select Workspace Directory' })
  const serverStarting = dialog.getByText('dsh web is not running yet', { exact: true })
  const workspaceDeadline = Date.now() + 75_000
  while (Date.now() < workspaceDeadline) {
    await choose.click()
    if (!await dialog.isVisible().catch(() => false)) {
      const addWorkspace = frame.getByText('Add workspace…', { exact: true })
      await addWorkspace.waitFor({ timeout: 15_000 })
      await addWorkspace.click()
    }
    await dialog.waitFor({ timeout: 15_000 })
    if (await serverStarting.isVisible().catch(() => false)) {
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await delay(250)
      continue
    }
    await dialog.getByRole('button', { name: 'Edit path' }).click()
    const pathInput = dialog.getByRole('textbox', { name: 'Edit path' })
    await pathInput.fill(join(workspace, 'project'))
    await pathInput.press('Enter')
    const open = dialog.getByRole('button', { name: 'Open', exact: true })
    let openClicked = false
    while (Date.now() < workspaceDeadline) {
      await dismissOnboarding(frame)
      if (await serverStarting.isVisible().catch(() => false)) break
      if (await open.isEnabled().catch(() => false)) {
        await open.click()
        openClicked = true
        break
      }
      await delay(100)
    }
    const actionDeadline = Math.min(workspaceDeadline, Date.now() + 20_000)
    while (openClicked && Date.now() < actionDeadline) {
      if (!await dialog.isVisible().catch(() => false)) {
        await composer.waitFor({ timeout: 20_000 })
        return composer
      }
      if (await serverStarting.isVisible().catch(() => false)) break
      await delay(100)
    }
    if (!await dialog.isVisible().catch(() => false)) {
      await composer.waitFor({ timeout: 20_000 })
      return composer
    }
    if (!await serverStarting.isVisible().catch(() => false)) {
      throw new Error('workspace Open action did not complete')
    }
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await delay(250)
  }
  throw new Error('workspace selection did not become ready before its deadline')
}

async function driveQuestionRound(browser, frame, options) {
  const composer = await ensureWorkspace(frame, options.workspace)
  await composer.fill(PROMPT)
  await composer.press('Enter')
  const question = await findNativeQuestion(browser)
  const snapshot = await captureStableSnapshot(question, options.temporary)
  await writeFile(options.milestone, JSON.stringify({ prompt: PROMPT, snapshot }))
  await frame.getByText(FINAL, { exact: true }).waitFor({ timeout: 60_000 })
  await writeFile(options.result, JSON.stringify({ final: FINAL }))
}

export async function driveWebview(options) {
  let stage = 'connect-cdp'
  const browser = await connect(options.endpoint)
  const messages = []
  observeBrowser(browser, messages)
  try {
    stage = 'wait-ready'
    await waitForFile(options.ready)
    stage = 'find-webview'
    const frame = await findWebviewFrame(browser)
    stage = 'initial-question-round'
    await driveQuestionRound(browser, frame, {
      workspace: options.workspace,
      temporary: options.temporary,
      milestone: options.milestone,
      result: options.result,
    })
    stage = 'wait-restart'
    await waitForFile(options.restartReady)
    stage = 'replacement-question-round'
    await driveQuestionRound(browser, frame, {
      workspace: options.workspace,
      temporary: options.temporary,
      milestone: options.restartMilestone,
      result: options.restartResult,
    })
    return browser
  } catch (error) {
    const diagnostic = await browserDiagnostic(browser, messages).catch(() => 'unavailable')
    await browser.close().catch(() => undefined)
    throw new Error(
      `VS Code webview driver failed during ${stage}: ${error instanceof Error ? error.message : String(error)}; frames=${diagnostic}`,
      { cause: error },
    )
  }
}
