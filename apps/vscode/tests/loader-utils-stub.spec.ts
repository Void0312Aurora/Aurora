/** The webview keeps ordinary Loader config but rejects runtime expressions without eval. */

import { describe, expect, it } from 'vitest'
import { evaluate, interpolate, isJsExpr } from '../webview/loader-utils-stub.ts'

describe('webview Loader config helpers', () => {
  it('recurses through plain static config', () => {
    expect(interpolate({}, { rows: [{ enabled: true }], label: 'static' })).toEqual({
      rows: [{ enabled: true }],
      label: 'static',
    })
  })

  it('fails closed instead of evaluating a Loader expression', () => {
    const expression = { __jsExpr: 'globalThis.secret' }
    expect(isJsExpr(expression)).toBe(true)
    expect(isJsExpr({ __jsExpr: 1 })).toBe(false)
    expect(() => evaluate({}, expression.__jsExpr))
      .toThrow('Loader expression evaluation is disabled by CSP')
    expect(() => interpolate({}, { value: expression }))
      .toThrow('Loader expression evaluation is disabled by CSP')
  })
})
