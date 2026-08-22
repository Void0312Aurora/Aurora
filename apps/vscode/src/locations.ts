/**
 * Pure resolution of a tool view's model-facing paths into editor targets and
 * consistent two-pane diff materials. The wire carries model-facing paths
 * (relative to the session cwd), edit hunks, and whole content only for file
 * creation. This module owns path resolution and preserves those wire
 * materials so the vscode-coupled command glue stays thin.
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

/**
 * A two-pane diff comparison, both panes drawn from the same wire material so
 * they stay consistent: for an edit both are the hunk fragments the wire
 * carried (3-line context), for a create the whole new file against an empty
 * left. This deliberately does NOT reconstruct whole files from disk — mixing
 * a disk whole-file left pane with a hunk-fragment right pane produces a
 * nonsensical diff. A true whole-file view would apply the hunk to disk, which
 * this defers to the (not-yet-wired) editor-diff trigger.
 */
export interface DiffMaterial {
  /** Absolute path of the changed file. */
  path: string
  /** Left pane: the prior hunk fragment, or empty for a create/overwrite. */
  before: string
  /** Right pane: the resulting hunk fragment (or whole file for a create). */
  after: string
  /** Whether the panes are hunk fragments (an edit) rather than whole files (a create). */
  kind: 'hunk' | 'whole-file'
}

/** Diffs carried by either view shape (both the call and result diff cards carry `diffs`). */
function viewDiffs(view: ToolCallView | ToolResultView): FileDiff[] {
  return view.card === 'diff' ? view.diffs : []
}

/**
 * Extract consistent two-pane diff materials from a view's diffs. Both panes
 * come from the same wire source: an edit compares `oldText`↔`newText` (hunk
 * fragments), a create (`oldText === null`) compares an empty left against the
 * whole new file. Paths resolve against the session cwd.
 * @param view - the tool view carrying diffs.
 * @param cwd - session cwd for path resolution.
 * @returns one material per diff, in file order.
 */
export function diffMaterials(view: ToolCallView | ToolResultView, cwd: string): DiffMaterial[] {
  return viewDiffs(view).map((diff) => {
    const path = resolvePath(diff.path, cwd)
    if (diff.oldText === null) {
      // Create/overwrite: no prior content on the wire, so an empty left pane
      // against the whole new file.
      return { path, before: '', after: diff.newText, kind: 'whole-file' as const }
    }
    return { path, before: diff.oldText, after: diff.newText, kind: 'hunk' as const }
  })
}
