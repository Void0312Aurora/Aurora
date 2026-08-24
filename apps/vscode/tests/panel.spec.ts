/**
 * Panel HTML/CSP shape: the document serves exactly the two resolved static
 * assets and locks script execution to the extension's own asset origin (the
 * bundle is fully static, so no inline or remote script runs). Pure string
 * building — no vscode module load.
 */

import { describe, expect, it } from 'vitest'
import { panelHtml } from '../src/panel.ts'

describe('panelHtml', () => {
  const html = panelHtml({
    script: 'https://asset/dist/webview/webview.js',
    style: 'https://asset/dist/webview/webview.css',
    cspSource: 'vscode-webview://fake',
  })

  it('serves exactly the resolved webview script and stylesheet', () => {
    expect(html).toContain('src="https://asset/dist/webview/webview.js"')
    expect(html).toContain('href="https://asset/dist/webview/webview.css"')
    expect(html).toContain('<div id="root"></div>')
    expect(html).toContain('type="module"')
  })

  it('pins script-src to the extension asset origin with no inline allowance', () => {
    const csp = /content="([^"]*)"/.exec(html)?.[1] ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain('script-src vscode-webview://fake')
    // Scripts must not carry 'unsafe-inline'; the static bundle needs none.
    expect(/script-src[^;]*unsafe-inline/.test(csp)).toBe(false)
    // Inline style attributes (React) do need the style allowance.
    expect(csp).toContain("style-src vscode-webview://fake 'unsafe-inline'")
    expect(csp).toContain('font-src vscode-webview://fake data:')
  })
})
