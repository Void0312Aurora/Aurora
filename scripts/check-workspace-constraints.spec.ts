import { describe, expect, it } from 'vitest'
import { checkSupportRuntimeDependencyEdges, type WorkspaceManifest } from './check-workspace-constraints.ts'

function subject(dir: string, manifest: WorkspaceManifest['manifest']): WorkspaceManifest {
  return { dir, manifest }
}

describe('support runtime dependency boundary', () => {
  const support = subject('packages/support/test-helper', { name: '@deepseek-ai/dsh-test-helper' })

  it.each(['dependencies', 'optionalDependencies', 'peerDependencies'] as const)(
    'rejects product %s edges into support',
    (field) => {
      const consumer = subject('packages/core/consumer', {
        name: '@deepseek-ai/dsh-consumer',
        [field]: { '@deepseek-ai/dsh-test-helper': 'workspace:^' },
      })

      expect(checkSupportRuntimeDependencyEdges([support, consumer])).toEqual([
        `packages/core/consumer/package.json: ${field} must not target support package @deepseek-ai/dsh-test-helper`,
      ])
    },
  )

  it('allows the explicit invariants peer and development-only dependencies', () => {
    const invariants = subject('packages/support/invariants', { name: '@deepseek-ai/dsh-invariants' })
    const consumer = subject('apps/desktop', {
      dependencies: { '@deepseek-ai/dsh-test-helper': 'workspace:^' },
      devDependencies: { '@deepseek-ai/dsh-test-helper': 'workspace:^' },
      peerDependencies: { '@deepseek-ai/dsh-invariants': 'workspace:^' },
    })

    expect(checkSupportRuntimeDependencyEdges([support, invariants, consumer])).toEqual([
      'apps/desktop/package.json: dependencies must not target support package @deepseek-ai/dsh-test-helper',
    ])
  })

  it('allows support infrastructure to compose other support packages', () => {
    const consumer = subject('packages/support/consumer', {
      dependencies: { '@deepseek-ai/dsh-test-helper': 'workspace:^' },
    })

    expect(checkSupportRuntimeDependencyEdges([support, consumer])).toEqual([])
  })
})
