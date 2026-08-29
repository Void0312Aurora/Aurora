/** Drive the real built webview through VS Code's remote-debugging endpoint. */

import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { captureStableAriaSnapshot, normalizeAriaSnapshot } from '../../../web/tests/stable-aria.ts'

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
  return normalizeAriaSnapshot(snapshot, temporary)
    .replaceAll('{{cwd}}', '{{temporary}}')
}

async function captureStableSnapshot(locator, temporary) {
  return captureStableAriaSnapshot(
    () => locator.ariaSnapshot({ timeout: 15_000 }),
    snapshot => normalizeSnapshot(snapshot, temporary),
  )
}

async function ensureWorkspace(frame, workspace) {
  // The same composer changes its localized placeholder when workspace
  // creation promotes the blank hero into an active session. Bind to the
  // control's stable role/state instead of one transient copy string.
  const composer = frame.locator('textarea:enabled').first()
  const choose = frame.getByRole('button', { name: 'Choose workspace' })
  const surfaceDeadline = Date.now() + 10_000
  while (Date.now() < surfaceDeadline) {
    if (await composer.isVisible().catch(() => false)) return { composer, workspacePicker: 'existing' }
    if (await choose.isVisible().catch(() => false)) break
    await delay(100)
  }
  if (await composer.isVisible().catch(() => false)) return { composer, workspacePicker: 'existing' }
  await choose.waitFor({ timeout: 30_000 })
  const dialog = frame.getByRole('dialog', { name: 'Select Workspace Directory' })
  const serverStarting = dialog.getByText('dsh web is not running yet', { exact: true })
  const workspaceDeadline = Date.now() + 75_000
  while (Date.now() < workspaceDeadline) {
    // This is fixture setup, not the interaction under test. A narrow host can
    // place sidebar chrome over the empty-state trigger; a forced coordinate
    // click still lands on that covering element. Invoke the structurally
    // located control itself and reserve ordinary user-action clicks for the
    // native question under test.
    await choose.evaluate(element => element.click())
    if (!await dialog.isVisible().catch(() => false)) {
      const addWorkspace = frame.getByText('Add workspace…', { exact: true })
      await addWorkspace.waitFor({ timeout: 15_000 })
      // The workspace list is rebuilt when the initial session catalog lands;
      // dispatch the structurally located action so a detached list row cannot
      // make the fixture setup fail between Playwright's actionability checks.
      await addWorkspace.evaluate(element => element.click())
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
        return { composer, workspacePicker: 'browse-dialog' }
      }
      if (await serverStarting.isVisible().catch(() => false)) break
      await delay(100)
    }
    if (!await dialog.isVisible().catch(() => false)) {
      await composer.waitFor({ timeout: 20_000 })
      return { composer, workspacePicker: 'browse-dialog' }
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
  const { composer, workspacePicker } = await ensureWorkspace(frame, options.workspace)
  await composer.fill(PROMPT)
  await composer.press('Enter')
  const question = await findNativeQuestion(browser)
  const snapshot = await captureStableSnapshot(question, options.temporary)
  await writeFile(options.milestone, JSON.stringify({ prompt: PROMPT, snapshot, workspacePicker }))
  // Answer through the same visible Quick Pick that produced the milestone.
  // The first option is selected when this picker opens. Submit through the
  // native Quick Pick input so the pinned VS Code build dispatches
  // QuickPick.onDidAccept instead of treating a pointer activation as hide-only.
  const answer = question.getByRole('option', { name: 'Yes', exact: true })
  await question.getByRole('textbox').press('Enter')
  // Keep a visible-control fallback for builds that do not accept the default
  // selection from the input; this remains an ordinary native UI interaction.
  if (await question.isVisible().catch(() => false)) {
    await answer.click()
    if (await question.isVisible().catch(() => false)) await question.press('Enter')
  }
  // The chat keeps virtualized copies of prior content mounted but hidden.
  // Scope completion to the visible markdown paragraph instead of relying on
  // DOM order, which differs between the pinned CI VS Code and local builds.
  await frame.locator('p:visible').filter({ hasText: FINAL }).waitFor({ timeout: 60_000 })
  const richSnapshot = await captureStableSnapshot(frame.locator('#root').first(), options.temporary)
  await writeFile(options.result, JSON.stringify({ final: FINAL, snapshot: richSnapshot }))
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
