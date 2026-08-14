/**
 * Pure IDE-context sampling: no active editor yields an empty no-op snapshot;
 * an active file renders a bounded reading whose signature keys change
 * detection; selection, cursor window, and diagnostics each shape the reading
 * and the signature; and the text/diagnostic bounds clip oversized inputs.
 */

import { describe, expect, it } from 'vitest'
import type { EditorState, SampleLimits } from '../src/ide-context.ts'
import { sampleIdeContext } from '../src/ide-context.ts'

const LIMITS: SampleLimits = { maxTextChars: 100, maxDiagnostics: 3 }

function state(overrides: Partial<EditorState>): EditorState {
  return { diagnostics: [], ...overrides }
}

describe('sampleIdeContext', () => {
  it('returns an empty no-op snapshot when no editor is active', () => {
    expect(sampleIdeContext(state({}), LIMITS)).toEqual({ signature: '', text: undefined })
  })

  it('renders a selection reading and keys its signature on path, range, body', () => {
    const snapshot = sampleIdeContext(state({
      path: 'src/a.ts', languageId: 'typescript', selection: 'const x = 1', range: { start: 3, end: 3 },
    }), LIMITS)
    expect(snapshot.text).toContain('Active file: src/a.ts:3 (typescript)')
    expect(snapshot.text).toContain('Selection:')
    expect(snapshot.text).toContain('const x = 1')
    // A different selection body changes the signature; an identical sample does not.
    const same = sampleIdeContext(state({ path: 'src/a.ts', languageId: 'typescript', selection: 'const x = 1', range: { start: 3, end: 3 } }), LIMITS)
    expect(same.signature).toBe(snapshot.signature)
    const changed = sampleIdeContext(state({ path: 'src/a.ts', languageId: 'typescript', selection: 'const y = 2', range: { start: 3, end: 3 } }), LIMITS)
    expect(changed.signature).not.toBe(snapshot.signature)
  })

  it('renders a multi-line range and the cursor window when there is no selection', () => {
    const snapshot = sampleIdeContext(state({
      path: 'a.ts', range: { start: 10, end: 20 }, window: 'line10\nline11',
    }), LIMITS)
    expect(snapshot.text).toContain('Active file: a.ts:10-20')
    expect(snapshot.text).toContain('Around the cursor:')
    expect(snapshot.text).toContain('line10\nline11')
  })

  it('lists bounded diagnostics and reflects them in the signature', () => {
    const withErr = sampleIdeContext(state({
      path: 'a.ts',
      diagnostics: [
        { severity: 'error', line: 2, message: 'boom' },
        { severity: 'warning', line: 5, message: 'meh' },
      ],
    }), LIMITS)
    expect(withErr.text).toContain('- error at line 2: boom')
    expect(withErr.text).toContain('- warning at line 5: meh')
    const noErr = sampleIdeContext(state({ path: 'a.ts', diagnostics: [] }), LIMITS)
    expect(withErr.signature).not.toBe(noErr.signature)
  })

  it('clips oversized selection text and excess diagnostics to the limits', () => {
    const snapshot = sampleIdeContext(state({
      path: 'a.ts',
      selection: 'x'.repeat(500),
      diagnostics: Array.from({ length: 10 }, (_v, i) => ({ severity: 'error' as const, line: i + 1, message: `d${String(i)}` })),
    }), LIMITS)
    expect(snapshot.text).toContain('… (truncated)')
    expect((snapshot.text?.match(/- error at line/g) ?? []).length).toBe(3)
  })

  it('bounds a single huge diagnostic message', () => {
    const snapshot = sampleIdeContext(state({
      path: 'a.ts',
      diagnostics: [{ severity: 'error', line: 1, message: 'y'.repeat(5000) }],
    }), { maxTextChars: 100, maxDiagnostics: 5, maxDiagnosticChars: 40 })
    const line = snapshot.text?.split('\n').find(l => l.startsWith('- error at line 1'))
    expect(line).toBeDefined()
    // 'y' run is capped at 40 chars plus the inline ellipsis, not 5000.
    expect((line?.match(/y/g) ?? []).length).toBe(40)
    expect(line).toContain('…')
  })

  it('bounds the complete rendered reading to maxTotalChars', () => {
    const snapshot = sampleIdeContext(state({
      path: 'a.ts',
      selection: 'z'.repeat(5000),
      diagnostics: Array.from({ length: 5 }, (_v, i) => ({ severity: 'error' as const, line: i + 1, message: 'm'.repeat(200) })),
    }), { maxTextChars: 5000, maxDiagnostics: 5, maxTotalChars: 500 })
    // The whole value is capped even though each field is within its own limit.
    expect(snapshot.text!.length).toBeLessThanOrEqual(500 + '\n… (truncated)'.length)
    expect(snapshot.text).toContain('… (truncated)')
  })
})
