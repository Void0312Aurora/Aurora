/**
 * The webview bundle must actually boot under the panel's own CSP.
 *
 * Unit tests cannot catch this class of failure: they never load the built
 * bundle in a browser, so a bundle that downloads fine and then throws at
 * module top level still passes every one of them while the panel renders
 * blank. This lane serves the real `dist/webview` output through the real
 * {@link panelHtml} document — same Content-Security-Policy the extension
 * ships — and asserts React actually mounted.
 *
 * Two shipped defects are pinned here: a library build leaves
 * `process.env.NODE_ENV` unsubstituted (React's CJS entry throws
 * `process is not defined`), and the vendored loader's `!!js` evaluator builds
 * a `new Function` at module top level (CSP refuses it without 'unsafe-eval').
 */

import type { Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startWebviewBrowser, type WebviewBrowserHarness } from './support/webview-browser.ts'

describe('webview bundle boots under the panel CSP', () => {
  let browser: Browser | undefined
  let harness: WebviewBrowserHarness | undefined
  let origin = ''

  beforeAll(async () => {
    harness = await startWebviewBrowser()
    browser = harness.browser
    origin = harness.origin
  })

  afterAll(async () => {
    await harness?.close()
  })

  it('mounts the GUI and raises no uncaught error', async () => {
    const page = await browser!.newPage()
    const pageErrors: string[] = []
    const cspViolations: string[] = []
    page.on('pageerror', (error) => { pageErrors.push(error.message) })
    page.on('console', (message) => {
      if (message.type() === 'error' && /Content Security Policy/i.test(message.text())) cspViolations.push(message.text())
    })

    await page.goto(origin, { waitUntil: 'load' })
    // React mounts asynchronously; wait for the shell rather than a fixed delay.
    await page.waitForFunction(() => (document.getElementById('root')?.childElementCount ?? 0) > 0, undefined, { timeout: 30_000 })

    const rendered = await page.evaluate(() => ({
      children: document.getElementById('root')?.childElementCount ?? 0,
      htmlLength: document.getElementById('root')?.innerHTML.length ?? 0,
      buttons: document.querySelectorAll('button').length,
    }))
    expect(rendered.children).toBeGreaterThan(0)
    expect(rendered.htmlLength).toBeGreaterThan(1_000)
    expect(rendered.buttons).toBeGreaterThan(0)

    // `process is not defined` and the loader's top-level `new Function` both
    // surface here; Zod's optional JIT probe is a console violation that it
    // recovers from, so only uncaught errors fail the run.
    expect(pageErrors, `uncaught errors in the webview bundle: ${pageErrors.join(' | ')}`).toEqual([])
    await page.close()
  })

  it('renders the incompatible-host state before the client graph starts', async () => {
    const page = await browser!.newPage()
    await page.goto(`${origin}/?protocol=2`, { waitUntil: 'load' })
    const alert = page.getByRole('alert')
    await alert.waitFor()

    expect(await alert.ariaSnapshot()).toMatchInlineSnapshot(`
      "- alert:
        - heading "Incompatible DeepSeek Harness host" [level=1]
        - paragraph: host protocolVersion 2 != client 1
        - paragraph: "Update the VS Code extension and dsh to compatible versions, then run Developer: Reload Window.""
    `)
    expect(await page.locator('[data-route]').count()).toBe(0)
    await page.close()
  })
})
