import { defineConfig } from 'vitest/config'
import { ARTIFACT_TEST_FILES } from './scripts/artifact-test-inventory.ts'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

/** Built product smoke and browser lane; product builds happen in test:artifacts. */
export default defineConfig({
  plugins: [standardDecoratorPlugin()],
  test: {
    execArgv: vitestExecArgv,
    include: [...ARTIFACT_TEST_FILES],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})
