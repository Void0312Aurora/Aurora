import { describe, expect, it } from 'vitest'
import { checkWorkspace } from './check-workspace-constraints.ts'

describe('workspace package policy', () => {
  it.each([
    ['apps/desktop', '@deepseek-ai/dsh-desktop'],
    ['apps/vscode', 'dsh-vscode'],
  ])('treats %s as an installer-owned private product', (dir, name) => {
    expect(checkWorkspace({
      dir,
      manifest: {
        name,
        private: true,
        version: '0.1.0-rc.5',
      },
    })).toEqual([])
  })

  it('requires publish metadata for the public process utility', () => {
    expect(checkWorkspace({
      dir: 'packages/util/process-tree',
      manifest: {
        name: '@deepseek-ai/dsh-process-tree',
        version: '0.1.0-rc.5',
        type: 'module',
        main: 'lib/index.js',
        types: 'lib/types/index.d.ts',
        files: ['lib/index.js', 'lib/invariant.js', 'lib/types/**/*.d.ts'],
        publishConfig: { access: 'public' },
        repository: {
          type: 'git',
          url: 'git+https://github.com/deepseek-ai/deepseek-harness.git',
          directory: 'packages/util/process-tree',
        },
        peerDependencies: { '@deepseek-ai/cordis': 'workspace:^' },
        devDependencies: { '@deepseek-ai/cordis': 'workspace:^' },
        exports: {
          '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
          './invariant': { types: './lib/types/invariant.d.ts', default: './lib/invariant.js' },
        },
      },
    })).toEqual([])
  })
})
