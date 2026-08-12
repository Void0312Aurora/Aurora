/**
 * Browser stand-in for `node:module` (same contract as the apps/web stub).
 * `createRequire` is unreachable in the configured loader path and fails loud
 * if that assumption changes.
 */

/** Throwing stand-in for node:module's createRequire (never reached in the webview boot). */
export const createRequire = (): never => {
  throw new Error('node:module is not available in the webview')
}

/** Erased type peer for the vendored loader's type-only LoadHookContext import. */
export type LoadHookContext = never
