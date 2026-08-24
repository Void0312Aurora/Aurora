/** CSP-safe Loader config helpers for the statically composed VS Code webview. */

interface JsExpr {
  __jsExpr: string
}

/** Runtime Loader expressions are outside the static webview composition contract. */
export function evaluate(_ctx: object, expr: string): never {
  throw new Error(`dsh webview: Loader expression evaluation is disabled by CSP: ${expr}`)
}

/** Recurse through ordinary config and fail closed if an expression appears. */
export function interpolate(ctx: object, value: unknown): unknown {
  if (isJsExpr(value)) return evaluate(ctx, value.__jsExpr)
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(item => interpolate(ctx, item))
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolate(ctx, item)]))
}

/** Return true for a serialized Loader JavaScript expression. */
export function isJsExpr(value: unknown): value is JsExpr {
  return value !== null
    && typeof value === 'object'
    && '__jsExpr' in value
    && typeof value.__jsExpr === 'string'
}
