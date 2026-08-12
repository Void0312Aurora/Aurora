/**
 * Pure location/diff resolution: model-facing paths resolve against the
 * session cwd, call-view locations become absolute editor targets with their
 * lines, and diff materials reconstruct whole-file panes from the wire's hunk
 * fragments (disk on the left for an edit, empty for a create).
 */

import { isAbsolute, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools/presentation'
import { diffMaterials, editorTargets, resolvePath } from '../src/locations.ts'

// A host-absolute cwd (resolve/isAbsolute are host-flavored; the test stays
// portable by comparing against node:path's own output rather than a literal).
const CWD = resolve('repo-root')

describe('resolvePath', () => {
  it('resolves a relative model path against the cwd', () => {
    const resolved = resolvePath('src/a.ts', CWD)
    expect(resolved).toBe(resolve(CWD, 'src/a.ts'))
    expect(isAbsolute(resolved)).toBe(true)
  })

  it('passes an absolute model path through', () => {
    const abs = resolve('/etc/x')
    expect(resolvePath(abs, CWD)).toBe(abs)
  })
})

describe('editorTargets', () => {
  it('maps a diff call view locations to absolute targets, preserving lines', () => {
    const view: ToolCallView = {
      card: 'diff',
      title: 'Edit a.ts',
      diffs: [{ path: 'src/a.ts', oldText: 'old', newText: 'new' }],
      locations: [{ path: 'src/a.ts', line: 12 }, { path: 'src/b.ts' }],
    }
    const targets = editorTargets(view, CWD)
    expect(targets).toEqual([
      { path: resolve(CWD, 'src/a.ts'), line: 12 },
      { path: resolve(CWD, 'src/b.ts') },
    ])
  })

  it('returns no targets for a result view (result views carry no locations)', () => {
    const view: ToolResultView = { card: 'diff', diffs: [{ path: 'src/a.ts', oldText: 'o', newText: 'n' }] }
    expect(editorTargets(view, CWD)).toEqual([])
  })

  it('returns no targets for a generic call without locations', () => {
    const view: ToolCallView = { card: 'generic', title: 'noop' }
    expect(editorTargets(view, CWD)).toEqual([])
  })
})

describe('diffMaterials', () => {
  it('uses on-disk text for the left pane of an edit', () => {
    const view: ToolCallView = {
      card: 'diff',
      title: 'Edit a.ts',
      diffs: [{ path: 'src/a.ts', oldText: 'hunk-old', newText: 'result-text' }],
    }
    const materials = diffMaterials(view, CWD, path => (path === resolvePath('src/a.ts', CWD) ? 'whole disk file' : undefined))
    expect(materials).toEqual([{ path: resolvePath('src/a.ts', CWD), before: 'whole disk file', after: 'result-text' }])
  })

  it('falls back to the hunk oldText when the file is unreadable', () => {
    const view: ToolCallView = {
      card: 'diff',
      title: 'Edit a.ts',
      diffs: [{ path: 'src/a.ts', oldText: 'hunk-old', newText: 'result' }],
    }
    const materials = diffMaterials(view, CWD, () => undefined)
    expect(materials[0]?.before).toBe('hunk-old')
  })

  it('leaves the left pane empty for a create/overwrite (null oldText)', () => {
    const view: ToolCallView = {
      card: 'diff',
      title: 'Write new.ts',
      diffs: [{ path: 'new.ts', oldText: null, newText: 'created' }],
    }
    const materials = diffMaterials(view, CWD, () => 'should be ignored')
    expect(materials).toEqual([{ path: resolvePath('new.ts', CWD), before: '', after: 'created' }])
  })

  it('returns nothing for a non-diff view', () => {
    const view: ToolCallView = { card: 'terminal', title: 'ls -la' }
    expect(diffMaterials(view, CWD, () => undefined)).toEqual([])
  })
})
