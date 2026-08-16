/**
 * Keyless assembled snapshot for the shipped sidebar webview. The production
 * bundle boots under its real CSP, selects the repository FixtureApiClient,
 * and renders the narrow shell plus resident interaction and tool-card state.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Locator, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startWebviewBrowser, type WebviewBrowserHarness } from './support/webview-browser.ts'

const EXPECTED = fileURLToPath(new URL('./snapshots/sidebar/sidebar.expected.md', import.meta.url))
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'

function normalize(snapshot: string): string {
  return snapshot
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{{uuid}}')
    .replace(/\b\d+(?:\.\d+)?(?:ms|s)\b/g, '{{duration}}')
    .replace(/(?<!\d)\d{2}:\d{2}(?!\d)/g, '{{clock}}')
}

async function stableAria(locator: Locator): Promise<string> {
  let previous = normalize(await locator.ariaSnapshot())
  await expect.poll(async () => {
    const current = normalize(await locator.ariaSnapshot())
    const stable = current === previous
    previous = current
    return stable
  }, { timeout: 5_000, message: 'sidebar aria snapshot did not stabilize' }).toBe(true)
  return previous
}

async function route(page: Page, destination: 'chat' | 'sessions'): Promise<void> {
  await page.evaluate((route) => {
    window.postMessage({ type: 'dsh-route', route }, '*')
  }, destination)
  await expect.poll(() => page.locator('[data-route]').getAttribute('data-route')).toBe(destination)
}

async function compareOrRefresh(actual: string): Promise<void> {
  const payload = `${actual.trimEnd()}\n`
  if (refreshing) {
    await mkdir(dirname(EXPECTED), { recursive: true })
    await writeFile(EXPECTED, payload)
    return
  }
  if (!existsSync(EXPECTED)) {
    throw new Error(`missing golden ${EXPECTED}; run DSH_SNAPSHOT=refresh pnpm run test:web:built to generate it`)
  }
  expect(payload).toBe(await readFile(EXPECTED, 'utf8'))
}

describe('assembled VS Code sidebar snapshot', () => {
  let harness: WebviewBrowserHarness | undefined

  beforeAll(async () => {
    harness = await startWebviewBrowser()
  })

  afterAll(async () => {
    await harness?.close()
  })

  it('renders sessions, native interaction counterparts, and tool cards at sidebar width', async () => {
    const page = await harness!.browser.newPage({
      viewport: { width: 259, height: 900 },
      locale: 'en-US',
    })
    const pageErrors: string[] = []
    page.on('pageerror', (error) => { pageErrors.push(error.message) })
    await page.goto(`${harness!.origin}/?fixture`, { waitUntil: 'load' })
    await page.locator('[data-route]').waitFor()
    const welcome = page.getByRole('dialog', { name: 'Internal Testing Notice' })
    if (await welcome.count() > 0) {
      await welcome.getByRole('button', { name: 'Continue' }).click()
      await welcome.waitFor({ state: 'detached' })
    }

    await route(page, 'sessions')
    const frame = page.locator('[data-route]')
    const sessions = await stableAria(frame)
    const tree = page.getByRole('tree', { name: 'Sessions' })
    await tree.getByRole('treeitem', { name: /Fixture 历史会话/u }).click()
    await route(page, 'chat')

    const question = page.locator('[data-question-key]')
    const bash = page.locator('[data-sample="bash"]').first()
    const webSearch = page.locator('[data-tool="web_search"]').first()
    await question.waitFor()
    await bash.waitFor()
    await webSearch.waitFor()
    const questionSnapshot = await stableAria(question)
    await question.getByRole('button', { name: 'Dismiss all questions' }).click()
    await question.waitFor({ state: 'detached' })
    const approval = page.locator('[data-approval-key]')
    await approval.waitFor()

    const layout = await page.locator('[data-route]').evaluate((root) => {
      const rootRect = root.getBoundingClientRect()
      const label = (element: HTMLElement): string =>
        element.getAttribute('data-tool') ?? element.getAttribute('data-sample') ?? element.tagName
      const visible = [...root.querySelectorAll<HTMLElement>('*')]
        .filter(element => element.getClientRects().length > 0)
      const outside = visible.filter((element) => {
        const rect = element.getBoundingClientRect()
        return rect.left < rootRect.left - 1 || rect.right > rootRect.right + 1
      })
      return {
        uncontainedOutside: outside
          .filter((element) => {
            for (let ancestor = element.parentElement; ancestor !== null && ancestor !== root; ancestor = ancestor.parentElement) {
              const overflow = getComputedStyle(ancestor).overflowX
              if (overflow === 'auto' || overflow === 'scroll' || overflow === 'hidden' || overflow === 'clip') return false
            }
            return true
          })
          .map(label),
        rootScrolls: root.scrollWidth > root.clientWidth + 1,
        scrollers: visible
          .filter((element) => {
            const overflow = getComputedStyle(element).overflowX
            return (overflow === 'auto' || overflow === 'scroll') && element.scrollWidth > element.clientWidth + 1
          })
          .map(label),
      }
    })

    await compareOrRefresh([
      '# VS Code sidebar fixture',
      '',
      'viewport: 259x900',
      `uncontained-outside-elements: ${String(layout.uncontainedOutside.length)}`,
      `root-horizontal-scroll: ${String(layout.rootScrolls)}`,
      `horizontal-scrollers: ${String(layout.scrollers.length)}`,
      '',
      '## Sessions route',
      sessions,
      '',
      '## Question',
      questionSnapshot,
      '',
      '## Approval',
      await stableAria(approval),
      '',
      '## Bash tool row',
      await stableAria(bash),
      '',
      '## Web search tool row',
      await stableAria(webSearch),
    ].join('\n'))

    expect(layout.uncontainedOutside).toEqual([])
    expect(layout.rootScrolls).toBe(false)
    expect(pageErrors, `uncaught errors in fixture sidebar: ${pageErrors.join(' | ')}`).toEqual([])
    await page.close()
  })
})
