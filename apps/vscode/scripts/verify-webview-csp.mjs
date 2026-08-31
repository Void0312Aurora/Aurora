/** Reject JavaScript constructs that require `unsafe-eval` in the built webview. */

import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const output = resolve(import.meta.dirname, '..', 'dist', 'webview')
const files = (await readdir(output)).filter(file => file.endsWith('.js'))
if (files.length === 0) throw new Error(`built webview has no JavaScript artifacts in ${output}`)

const violations = []
for (const file of files) {
  const text = await readFile(resolve(output, file), 'utf8')
  if (/\bnew\s+Function\s*\(/.test(text)) violations.push(`${file}: Function constructor`)
}

if (violations.length > 0) {
  throw new Error(`built webview violates the strict CSP:\n${violations.join('\n')}`)
}
console.log(`verify-webview-csp: ${String(files.length)} JavaScript artifacts passed`)
