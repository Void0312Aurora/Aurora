/**
 * Static roster parity: the webview must embed the browser faces declared by
 * the current dsh-base + dsh-web-app patch layers, except for the HMR row,
 * the kernel-owned modules row, and the wide layout replaced by the sidebar
 * shell. This test reads package manifests rather than a retired app config.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const ROSTER_SOURCE = join(REPOSITORY_ROOT, 'apps/vscode/webview/roster.ts')
const PATCH_FILES = [
  join(REPOSITORY_ROOT, 'packages/bundle/base/cordis.patch.yml'),
  join(REPOSITORY_ROOT, 'packages/bundle/web-app/cordis.patch.yml'),
]

interface PackageManifest {
  name?: unknown
  dsh?: unknown
}

interface ClientDeclaration {
  platform?: unknown
}

/** Collect package manifests without relying on an additional YAML/JSON package. */
function collectManifests(dir: string, manifests: Map<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'lib' || entry.name === 'deploy') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectManifests(path, manifests)
      continue
    }
    if (entry.name !== 'package.json') continue
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
    if (typeof manifest.name === 'string') manifests.set(manifest.name, path)
  }
}

/** Read one package's `dsh.client` declaration when it has one. */
function clientDeclaration(path: string): ClientDeclaration | undefined {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
  if (typeof manifest.dsh !== 'object' || manifest.dsh === null) return undefined
  const dsh = manifest.dsh as { client?: unknown }
  if (typeof dsh.client !== 'object' || dsh.client === null) return undefined
  return dsh.client
}

/** Names in the two authoritative bundle patch layers. */
function patchPackageNames(): Set<string> {
  const names = new Set<string>()
  for (const path of PATCH_FILES) {
    const text = readFileSync(path, 'utf8')
    for (const match of text.matchAll(/\bname:\s*['"]?(@deepseek-ai\/[^'"\s]+)['"]?/g)) names.add(match[1]!)
  }
  return names
}

/** Browser package rows explicitly composed by base + web-app. */
function authoritativeBrowserNames(): Set<string> {
  const manifests = new Map<string, string>()
  collectManifests(join(REPOSITORY_ROOT, 'packages'), manifests)
  const names = new Set<string>()
  for (const packageName of patchPackageNames()) {
    const manifestPath = manifests.get(packageName)
    if (manifestPath === undefined) continue
    if (clientDeclaration(manifestPath)?.platform === 'web') names.add(packageName)
  }
  return names
}

/** Package ids in the roster's static object literal. */
function rosterPackageNames(): Set<string> {
  const source = readFileSync(ROSTER_SOURCE, 'utf8')
  return new Set([...source.matchAll(/^\s*'(@deepseek-ai\/[^']+)'\s*:/gm)].map(match => match[1]!))
}

describe('webview static roster', () => {
  it('uses the static module table for every graph row', () => {
    const source = readFileSync(ROSTER_SOURCE, 'utf8')
    expect(source).toContain('url: `static:${id}`')
    expect(source).toContain("rev: 'static'")
    expect(source).toContain('Object.keys(staticPlugins).map')
  })

  it('matches the current base + web-app browser composition', () => {
    const excluded = new Set([
      '@deepseek-ai/dsh-client-hmr',
      '@deepseek-ai/dsh-client-modules',
      '@deepseek-ai/dsh-client-ui-layout',
    ])
    const expected = new Set([...authoritativeBrowserNames()].filter(name => !excluded.has(name)))
    expect(rosterPackageNames()).toEqual(expected)
  })

  it('keeps kernel-owned rows and the wide shell out of the package roster', () => {
    const roster = rosterPackageNames()
    expect(roster).not.toContain('@deepseek-ai/dsh-client-modules')
    expect(roster).not.toContain('@deepseek-ai/dsh-client-hmr')
    expect(roster).not.toContain('@deepseek-ai/dsh-client-ui-layout')
  })

  it('declares the VS Code adapters and sidebar shell', () => {
    const source = readFileSync(ROSTER_SOURCE, 'utf8')
    expect(source).toContain("export const VSCODE_THEME_ID = 'dsh-vscode-theme'")
    expect(source).toContain("export const VSCODE_ROUTES_ID = 'dsh-vscode-routes'")
    expect(source).toContain("export const VSCODE_SHELL_ID = 'dsh-vscode-shell'")
    expect(source).toContain('[VSCODE_THEME_ID]: VscodeTheme')
    expect(source).toContain('[VSCODE_ROUTES_ID]: VscodeRoutes')
    expect(source).toContain('[VSCODE_SHELL_ID]: VscodeShell')
  })
})
