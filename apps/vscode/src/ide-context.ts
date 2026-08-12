/**
 * Pure IDE-context sampling and formatting. The VS Code editor state is read
 * by the extension and passed here as a plain snapshot; this module decides
 * what the model sees (a compact "current editor" reading) and whether it
 * changed since the last injection, so the feed can suppress no-op updates —
 * the same shape as the tmux-context plugin's render/suppress split, minus any
 * VS Code or wire coupling.
 */

/** A diagnostic the editor reports for the active file. */
export interface IdeDiagnostic {
  /** Severity as the editor classifies it. */
  severity: 'error' | 'warning'
  /** 1-based line the diagnostic anchors to. */
  line: number
  /** The message text, already trimmed by the caller if needed. */
  message: string
}

/** The editor facts a sample reads; the extension builds this from the VS Code API. */
export interface EditorState {
  /** Workspace-relative path of the active file, or undefined when no editor is active. */
  path?: string
  /** The active language id (e.g. `typescript`), when an editor is active. */
  languageId?: string
  /** The selected text, when the selection is non-empty. */
  selection?: string
  /** 1-based inclusive line range of the selection or cursor window. */
  range?: { start: number; end: number }
  /** A bounded window of the file around the cursor, when there is no selection. */
  window?: string
  /** Bounded diagnostics for the active file. */
  diagnostics: IdeDiagnostic[]
}

/** Bounds for one sample; the extension supplies deployment values. */
export interface SampleLimits {
  /** Max characters of selection/window text carried. */
  maxTextChars: number
  /** Max diagnostics carried. */
  maxDiagnostics: number
}

/**
 * A normalized, bounded snapshot: the `signature` is the change key (a no-op
 * update is one whose signature equals the last injected one), and `text` is
 * the model-facing reading, or undefined when there is nothing to inject.
 */
export interface IdeContextSnapshot {
  signature: string
  text: string | undefined
}

/** Trim a text body to a character bound, marking a cut with an ellipsis note. */
function boundText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n… (truncated)`
}

/**
 * Build a bounded context snapshot from editor state. Returns an
 * empty-signature, no-text snapshot when no editor is active, so the feed can
 * still suppress repeats without injecting anything.
 * @param state - the editor facts sampled from VS Code.
 * @param limits - text and diagnostic bounds.
 * @returns the change signature and the model-facing reading (or undefined).
 */
export function sampleIdeContext(state: EditorState, limits: SampleLimits): IdeContextSnapshot {
  if (state.path === undefined) return { signature: '', text: undefined }
  const diagnostics = state.diagnostics.slice(0, limits.maxDiagnostics)
  const selection = state.selection === undefined ? undefined : boundText(state.selection, limits.maxTextChars)
  const window = state.window === undefined ? undefined : boundText(state.window, limits.maxTextChars)
  const rangeText = state.range === undefined
    ? ''
    : state.range.start === state.range.end ? `:${String(state.range.start)}` : `:${String(state.range.start)}-${String(state.range.end)}`

  const lines: string[] = [`Active file: ${state.path}${rangeText}${state.languageId === undefined ? '' : ` (${state.languageId})`}`]
  if (selection !== undefined) {
    lines.push('', 'Selection:', '```', selection, '```')
  } else if (window !== undefined) {
    lines.push('', 'Around the cursor:', '```', window, '```')
  }
  if (diagnostics.length > 0) {
    lines.push('', 'Diagnostics:')
    for (const diagnostic of diagnostics) {
      lines.push(`- ${diagnostic.severity} at line ${String(diagnostic.line)}: ${diagnostic.message}`)
    }
  }
  const text = `[editor context]\n${lines.join('\n')}`
  // The signature keys change detection: path, range, selection/window body,
  // and the diagnostic set. Two samples with the same signature are a no-op.
  const signature = JSON.stringify({
    path: state.path,
    range: state.range ?? null,
    body: selection ?? window ?? null,
    diagnostics: diagnostics.map(d => `${d.severity}:${String(d.line)}:${d.message}`),
  })
  return { signature, text }
}
