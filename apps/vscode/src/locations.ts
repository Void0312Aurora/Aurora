/**
 * Pure resolution of a tool view's model-facing paths into editor targets and
 * whole-file diff materials. The wire carries model-facing paths (relative to
 * the session cwd) and result-side diffs as 3-line-context hunks, never whole
 * files; the editor needs absolute paths and, for a native two-pane diff, the
 * full before/after text. This module owns the path math and the hunk→whole
 * reconstruction so the vscode-coupled command glue stays thin and untested.
 */

import { isAbsolute, resolve } from 'node:path'
import type { FileDiff, FileLocation, GenericCallView, DiffCallView, ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools/presentation'

/** An editor jump target: an absolute filesystem path and an optional 1-based line. */
export interface EditorTarget {
  /** Absolute path resolved against the session cwd. */
  path: string
  /** 1-based line to focus, when the location carried one. */
  line?: number
}

/** Resolve one model-facing path against the session cwd (absolute paths pass through). */
export function resolvePath(modelPath: string, cwd: string): string {
  return isAbsolute(modelPath) ? modelPath : resolve(cwd, modelPath)
}

/** Locations carried by a call view (only the generic and diff CALL cards carry them; result views do not). */
function viewLocations(view: ToolCallView | ToolResultView): FileLocation[] {
  if (view.card !== 'generic' && view.card !== 'diff') return []
  // A 'diff' card is a call or result view; only the call view has locations.
  return (view as GenericCallView | DiffCallView).locations ?? []
}

/**
 * Map a tool view's follow-along locations to absolute editor targets.
 * @param view - the host-computed call or result view.
 * @param cwd - the session working directory the model paths are relative to.
 * @returns absolute jump targets in the view's order (empty when none).
 */
export function editorTargets(view: ToolCallView | ToolResultView, cwd: string): EditorTarget[] {
  return viewLocations(view).map(location => ({
    path: resolvePath(location.path, cwd),
    ...location.line === undefined ? {} : { line: location.line },
  }))
}

/** A native two-pane diff: absolute path plus the resolved before/after text. */
export interface DiffMaterial {
  /** Absolute path of the changed file. */
  path: string
  /** Left pane: prior whole-file content, or empty for a new file. */
  before: string
  /** Right pane: resulting whole-file content. */
  after: string
}

/** Diffs carried by either view shape (both the call and result diff cards carry `diffs`). */
function viewDiffs(view: ToolCallView | ToolResultView): FileDiff[] {
  return view.card === 'diff' ? view.diffs : []
}

/**
 * Reconstruct whole-file diff materials from a view's diffs. The wire's
 * `oldText`/`newText` are hunk fragments (3-line context) for an edit, or the
 * whole file when there is no before-image (a create). Whole-file two-pane
 * fidelity needs the current on-disk text: {@link readFile} supplies it, and
 * this composes the panes — the model-facing `oldText` (or disk) on the left,
 * `newText` (or disk) on the right. A `null` `oldText` means create/overwrite,
 * so the left pane is empty.
 * @param view - the tool view carrying diffs.
 * @param cwd - session cwd for path resolution.
 * @param readFile - reads current on-disk text; returns undefined when absent.
 * @returns one material per diff, in file order.
 */
export function diffMaterials(
  view: ToolCallView | ToolResultView,
  cwd: string,
  readFile: (path: string) => string | undefined,
): DiffMaterial[] {
  return viewDiffs(view).map((diff) => {
    const path = resolvePath(diff.path, cwd)
    const disk = readFile(path)
    // oldText null = create/overwrite (no prior content); otherwise the disk
    // text is the truthful left pane, falling back to the hunk's oldText when
    // the file is unreadable. newText is the model's resulting text.
    const before = diff.oldText === null ? '' : disk ?? diff.oldText
    const after = diff.newText
    return { path, before, after }
  })
}
