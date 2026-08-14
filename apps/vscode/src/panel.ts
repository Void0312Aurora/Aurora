/**
 * Webview panel HTML: the document shell and its CSP around the statically
 * built webview bundle. Pure string building with no `vscode` import (the
 * caller resolves the asWebviewUri asset URLs and the CSP source), so it is
 * unit-testable outside the extension host — the vscode-coupled URI joining
 * lives in `extension.ts`, the module the app never unit-tests.
 */

/** Where the built webview assets live, relative to the extension root. */
export const WEBVIEW_DIST = ['dist', 'webview'] as const

/** The already-resolved asset URLs and CSP source the panel serves. */
export interface PanelAssets {
  /** asWebviewUri of the built `webview.js` entry. */
  script: string
  /** asWebviewUri of the built `webview.css`. */
  style: string
  /** The webview's `cspSource` (its own asset origin). */
  cspSource: string
}

/**
 * Build the panel document around the built bundle.
 * @param assets - resolved asset URLs plus the CSP source.
 * @returns the complete HTML document.
 */
export function panelHtml(assets: PanelAssets): string {
  // script-src is pinned to the extension's own asset origin: the bundle is
  // fully static (every plugin ships inside it), so no inline script and no
  // remote script ever executes. style-src additionally allows inline styles
  // (React inline style attributes and vite-injected fallbacks).
  // font-src allows data: because the bundled stylesheet inlines its webfonts
  // as base64 (cssCodeSplit is off, so vite emits one stylesheet with the font
  // payloads in it); without it every glyph falls back to a system face.
  const csp = [
    "default-src 'none'",
    `script-src ${assets.cspSource}`,
    `style-src ${assets.cspSource} 'unsafe-inline'`,
    `font-src ${assets.cspSource} data:`,
    `img-src ${assets.cspSource} data:`,
  ].join('; ')
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="stylesheet" href="${assets.style}" />
<title>DeepSeek Harness</title>
</head>
<body>
<div id="root"></div>
<script type="module" src="${assets.script}"></script>
</body>
</html>`
}
