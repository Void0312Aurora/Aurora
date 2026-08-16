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
  /** Max characters of a single diagnostic message (a lone LSP diagnostic can be huge). */
  maxDiagnosticChars?: number
  /** Max characters of the whole rendered reading, applied last to the complete output. */
  maxTotalChars?: number
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

/** Default caps applied when the deployment omits them; keep the reading well inside a model turn. */
const DEFAULT_MAX_DIAGNOSTIC_CHARS = 300
const DEFAULT_MAX_TOTAL_CHARS = 12000

/** Trim a text body to a character bound, marking a cut with an ellipsis note. */
function boundText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n… (truncated)`
}

/** Trim a single-line value (a diagnostic message) to a bound with an inline ellipsis. */
function boundLine(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…`
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
  const maxDiagnosticChars = limits.maxDiagnosticChars ?? DEFAULT_MAX_DIAGNOSTIC_CHARS
  const maxTotalChars = limits.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS
  const diagnostics = state.diagnostics.slice(0, limits.maxDiagnostics)
    .map(diagnostic => ({ ...diagnostic, message: boundLine(diagnostic.message, maxDiagnosticChars) }))
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
  // The complete result gets the final bound: wrappers, the header, diagnostics
  // and body together can outrun the per-field caps (20 near-limit diagnostics,
  // a long path), and the repo rule is to bound the whole emitted value.
  const text = boundText(`[editor context]\n${lines.join('\n')}`, maxTotalChars)
  // The signature keys change detection on the emitted text: two samples that
  // render identically (after every bound) are a no-op.
  const signature = text
  return { signature, text }
}
