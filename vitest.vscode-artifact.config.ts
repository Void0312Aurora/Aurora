import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { vitestExecArgv } from './vitest.shared.ts'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] })],
  test: {
    name: 'vscode-artifact',
    execArgv: vitestExecArgv,
    pool: 'forks',
    setupFiles: ['./scripts/test-invariants.ts'],
    include: ['apps/vscode/tests/built-entry.spec.ts'],
    maxWorkers: 1,
  },
})
