/**
 * Static roster/boot-graph shape: every roster id gets a boot entry, the two
 * kernel-owned ids (modules, app-shell) stay out, and the graph matches the
 * `dshClient` rows of the composed web config minus dev-only hmr. This is the
 * guard that keeps the webview's static bundle in sync with the shipped web
 * surface as plugins are added.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { staticBootGraph, staticPlugins, VSCODE_THEME_ID } from '../webview/roster.ts'

const WEB_CONFIG = fileURLToPath(new URL('../../cli/config/web.cordis.yml', import.meta.url))

/**
 * The client plugin names the shipped web surface composes. Extracted by
 * text (every `name: '@deepseek-ai/dsh-client-*'` row) to avoid a YAML
 * dependency; the parity assertion below only needs the browser-plugin names.
 */
function webClientPluginNames(): string[] {
  const text = readFileSync(WEB_CONFIG, 'utf8')
  const names = [...text.matchAll(/name:\s*'(@deepseek-ai\/dsh-client-[^']+)'/g)].map(match => match[1]!)
  return [...new Set(names)]
}

describe('webview static roster', () => {
  it('emits one boot entry per static plugin with placeholder transport fields', () => {
    const graph = staticBootGraph()
    const ids = graph.entries.map(entry => entry.id)
    expect(new Set(ids)).toEqual(new Set(Object.keys(staticPlugins)))
    // Every url is a non-fetchable placeholder (statics resolve without fetch).
    expect(graph.entries.every(entry => entry.url.startsWith('static:'))).toBe(true)
    expect(graph.rev).toBe('static')
  })

  it('never bundles the kernel-owned modules or app-shell ids', () => {
    expect(staticPlugins).not.toHaveProperty('@deepseek-ai/dsh-client-modules')
    expect(Object.keys(staticPlugins).some(id => id.includes('app-shell'))).toBe(false)
  })

  it('carries the VS Code theme adapter as a webview-own module', () => {
    expect(staticPlugins).toHaveProperty(VSCODE_THEME_ID)
    const theme = staticPlugins[VSCODE_THEME_ID] as { apply?: unknown; inject?: unknown }
    expect(theme.apply).toBeTypeOf('function')
    expect(theme.inject).toEqual(['theme'])
  })

  it('bundles every browser plugin the shipped web config composes (minus dev-only hmr)', () => {
    // hmr is dev-only (disabled in web.cordis.yml) and modules is kernel-owned;
    // neither is a roster plugin. Every other composed client name must bundle.
    const excluded = new Set(['@deepseek-ai/dsh-client-hmr', '@deepseek-ai/dsh-client-modules'])
    const web = webClientPluginNames().filter(name => !excluded.has(name))
    expect(web.length).toBeGreaterThan(0)
    for (const id of web) {
      expect(staticPlugins, `web config composes ${id} but the webview roster omits it`).toHaveProperty(id)
    }
  })
})
