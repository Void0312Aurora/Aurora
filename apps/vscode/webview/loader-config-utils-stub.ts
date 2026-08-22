/**
 * Browser stand-in for the vendored loader's `config/utils.ts`.
 *
 * The real module builds its `!!js` expression evaluator with `new Function`
 * at module top level, which the panel's CSP refuses (`script-src` without
 * `'unsafe-eval'`) — the throw happens while the bundle is still loading, so
 * nothing renders. The webview never evaluates such expressions: it boots from
 * a static plugin roster and a static boot graph, not from a `cordis.yml`, so
 * no configuration reaching it can carry a `!!js` node. Only `evaluate`
 * changes shape; it now fails loud instead of existing, and the surrounding
 * interpolation keeps the upstream behavior for ordinary values.
 */

import { valueMap } from 'cosmokit'

/**
 * Refuse expression evaluation. Reaching this means a `!!js` node arrived in
 * webview configuration, which the static boot graph cannot produce.
 * @param _ctx - the loader scope the upstream evaluator would bind.
 * @param expr - the expression source, echoed for diagnosis.
 * @returns never; always throws.
 */
export const evaluate = (_ctx: object, expr: string): never => {
  throw new Error(`dsh webview: cordis !!js expressions are unavailable under the panel CSP (expression: ${expr})`)
}

/**
 * Recursively replace YAML `!js` expression nodes with evaluated values.
 * @param ctx - the loader scope passed to {@link evaluate}.
 * @param value - the configuration value to walk.
 * @returns the value with expression nodes resolved.
 */
export function interpolate(ctx: object, value: any): any {
  if (isJsExpr(value)) {
    return evaluate(ctx, value.__jsExpr)
  } else if (!value || typeof value !== 'object') {
    return value
  } else if (Array.isArray(value)) {
    return value.map(item => interpolate(ctx, item))
  } else {
    return valueMap(value, item => interpolate(ctx, item))
  }
}

/**
 * Return true when a value is a serialized loader JavaScript expression.
 * @param value - the candidate value.
 * @returns whether it carries the `__jsExpr` marker.
 */
export function isJsExpr(value: any): value is JsExpr {
  return value instanceof Object && '__jsExpr' in value
}

/** Serialized JavaScript expression produced by the include YAML tag. */
export interface JsExpr {
  __jsExpr: string
}
