import { describe, expect, it } from 'vitest'
import { verifyRuntimeClosure, type WorkspacePackage } from './verify-runtime-closure.ts'

function workspace(entries: Record<string, WorkspacePackage['manifest']>): ReadonlyMap<string, WorkspacePackage> {
  return new Map(Object.entries(entries).map(([name, manifest]) => [name, { path: `${name}/package.json`, manifest }]))
}

describe('verifyRuntimeClosure', () => {
  it('reports a required peer missing from the deploy root with its dependency chain', () => {
    const result = verifyRuntimeClosure(
      'desktop-closure',
      { '@scope/root': 'workspace:^' },
      workspace({
        '@scope/root': { name: '@scope/root', dependencies: { '@scope/child': 'workspace:^' } },
        '@scope/child': { name: '@scope/child', peerDependencies: { '@scope/peer': 'workspace:^' } },
        '@scope/peer': { name: '@scope/peer' },
      }),
    )

    expect(result.failures).toEqual([
      'desktop-closure -> @scope/root -> @scope/child -> @scope/peer',
    ])
  })

  it('accepts root peers and ignores optional peers', () => {
    const result = verifyRuntimeClosure(
      'desktop-closure',
      {
        '@scope/root': 'workspace:^',
        '@scope/peer': 'workspace:^',
      },
      workspace({
        '@scope/root': {
          name: '@scope/root',
          dependencies: { '@scope/child': 'workspace:^' },
        },
        '@scope/child': {
          name: '@scope/child',
          peerDependencies: {
            '@scope/peer': 'workspace:^',
            '@scope/optional': 'workspace:^',
          },
          peerDependenciesMeta: { '@scope/optional': { optional: true } },
        },
        '@scope/peer': { name: '@scope/peer' },
        '@scope/optional': { name: '@scope/optional' },
      }),
    )

    expect(result.failures).toEqual([])
    expect(result.packageCount).toBe(3)
  })
})
