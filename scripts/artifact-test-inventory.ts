/** Artifact-plane tests that run only after the desktop and VS Code products build. */
export const ARTIFACT_TEST_FILES = [
  'apps/desktop/tests/built-entry.spec.ts',
  'apps/vscode/tests/built-entry.spec.ts',
  'apps/vscode/tests/webview-boot.e2e.ts',
  'apps/vscode/tests/sidebar.snapshot.ts',
] as const
