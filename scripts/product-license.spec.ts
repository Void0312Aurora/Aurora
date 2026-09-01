import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const repositoryLicense = readFileSync(resolve(root, 'LICENSE'), 'utf8')

describe('private product licenses', () => {
  it.each([
    'apps/desktop',
    'apps/desktop/closure',
    'apps/vscode',
    'apps/vscode/closure',
  ])('%s declares the repository MIT license', (directory) => {
    const manifest = JSON.parse(readFileSync(resolve(root, directory, 'package.json'), 'utf8')) as {
      license?: string
    }
    expect(manifest.license).toBe('MIT')
  })

  it.each(['apps/desktop', 'apps/vscode'])('%s ships the repository MIT license text', (directory) => {
    expect(readFileSync(resolve(root, directory, 'LICENSE'), 'utf8')).toBe(repositoryLicense)
  })

  it('includes the desktop license in the electron-builder payload', () => {
    const config = readFileSync(resolve(root, 'apps/desktop/electron-builder.yml'), 'utf8')
    expect(config).toMatch(/^\s+- LICENSE$/mu)
  })

  it('does not exclude the VS Code license from the VSIX', () => {
    const ignore = readFileSync(resolve(root, 'apps/vscode/.vscodeignore'), 'utf8')
    expect(ignore.split(/\r?\n/u)).not.toContain('LICENSE')
  })

  it('allows the Electron packaging dependency to install its runtime', () => {
    const workspace: unknown = yaml.load(readFileSync(resolve(root, 'pnpm-workspace.yaml'), 'utf8'))
    if (typeof workspace !== 'object' || workspace === null || Array.isArray(workspace)) {
      throw new TypeError('pnpm-workspace.yaml must contain a mapping')
    }
    const allowBuilds = (workspace as { allowBuilds?: unknown }).allowBuilds

    expect(allowBuilds).toMatchObject({ electron: true })
  })
})
