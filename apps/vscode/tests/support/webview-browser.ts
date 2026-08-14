/**
 * Browser harness for the shipped VS Code webview document. It serves the
 * built assets through {@link panelHtml}, including its production CSP, and
 * launches either Playwright's Chromium or the explicitly supplied local one.
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { panelHtml, WEBVIEW_DIST } from '../../src/panel.ts'

/** Built webview directory consumed by this artifact-plane harness. */
const WEBVIEW_BUILD = fileURLToPath(new URL(`../../${WEBVIEW_DIST.join('/')}/`, import.meta.url))

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.woff2': 'font/woff2',
}

/** A running browser plus the local origin serving the production document. */
export interface WebviewBrowserHarness {
  browser: Browser
  origin: string
  close(): Promise<void>
}

function listen(): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      void (async () => {
        const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        if (pathname === '/' || pathname === '/index.html') {
          const html = panelHtml({
            script: `${origin}/webview.js`,
            style: `${origin}/webview.css`,
            cspSource: origin,
          }).replace(
            '<div id="root"></div>',
            `<script src="${origin}/vscode-api-stub.js"></script>\n<div id="root"></div>`,
          )
          response.writeHead(200, { 'content-type': 'text/html' })
          response.end(html)
          return
        }
        if (pathname === '/vscode-api-stub.js') {
          response.writeHead(200, { 'content-type': 'text/javascript' })
          response.end('window.acquireVsCodeApi = () => ({ postMessage() {}, getState() { return undefined }, setState() {} })')
          return
        }
        const relative = pathname.slice(1)
        if (relative === '' || relative.split('/').includes('..')) {
          response.writeHead(404)
          response.end()
          return
        }
        try {
          const body = await readFile(join(WEBVIEW_BUILD, relative))
          response.writeHead(200, { 'content-type': CONTENT_TYPES[extname(relative)] ?? 'application/octet-stream' })
          response.end(body)
        } catch {
          response.writeHead(404)
          response.end()
        }
      })()
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })
    })
  })
}

/**
 * Start the production-document browser harness.
 * @returns the running browser, its local origin, and an awaited disposer.
 */
export async function startWebviewBrowser(): Promise<WebviewBrowserHarness> {
  if (!existsSync(join(WEBVIEW_BUILD, 'webview.js'))) {
    throw new Error(
      `built webview bundle missing at ${WEBVIEW_BUILD}; run \`pnpm --filter dsh-vscode run build:webview\` first`,
    )
  }
  const { server, origin } = await listen()
  const executablePath = process.env.DSH_CHROMIUM_PATH
  const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
  return {
    browser,
    origin,
    async close() {
      const failures: unknown[] = []
      await browser.close().catch((error: unknown) => { failures.push(error) })
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      }).catch((error: unknown) => { failures.push(error) })
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'webview browser teardown failed')
    },
  }
}
