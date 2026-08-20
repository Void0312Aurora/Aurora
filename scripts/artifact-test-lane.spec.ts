import { describe, expect, it } from 'vitest'
import { ARTIFACT_TEST_FILES } from './artifact-test-inventory.ts'

describe('product artifact test lane', () => {
  it('collects built entries and the assembled VS Code browser acceptance', () => {
    expect(ARTIFACT_TEST_FILES).toEqual([
      'apps/desktop/tests/built-entry.spec.ts',
      'apps/vscode/tests/built-entry.spec.ts',
      'apps/vscode/tests/webview-boot.e2e.ts',
      'apps/vscode/tests/sidebar.snapshot.ts',
    ])
  })
})
