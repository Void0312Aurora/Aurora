/** Render the deterministic CLI overlay used by the built Extension Host lane. */
export function renderReplayOverlay(options) {
  return [
    '- id: llm-deepseek',
    '  disabled: true',
    '- id: directory-picker',
    '  disabled: true',
    '- insert:',
    '    - id: vscode-directory-picker-browse',
    `      name: ${JSON.stringify(options.directoryPickerModule)}`,
    '    - id: vscode-replay',
    `      name: ${JSON.stringify(options.replayModule)}`,
    '      config:',
    '        file: !!js process.env.DSH_SNAPSHOT_FILE',
    '        paceMs: 5',
    '        providers:',
    '          - id: deepseek-official',
    '            name: DeepSeek',
    '            models:',
    '              - id: deepseek-v4-flash',
    '- id: session-title-llm',
    '  disabled: true',
    '- id: session-persistence-jsonl',
    '  config:',
    '    root: !!js process.env.DSH_VSCODE_SESSIONS_ROOT',
    '    compression: none',
    '',
  ].join('\n')
}
