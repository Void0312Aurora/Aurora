/** Shared browser ARIA stabilization and text-golden handling for app tests. */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/** Browser-locator face required by the shared ARIA stabilizer. */
export interface AriaSnapshotLocator {
  /** Capture the current accessibility tree for this locator. */
  ariaSnapshot(): Promise<string>
}

/** Normalize path, identity, clock, and duration volatility in browser aria text. */
export function normalizeAriaSnapshot(snapshot: string, workspaceCwd: string): string {
  const base = workspaceCwd.split(/[\\/]/).pop()!
  return snapshot
    .split(workspaceCwd).join('{{cwd}}')
    .split(workspaceCwd.replaceAll('\\', '/')).join('{{cwd}}')
    .split(base).join('{{workspace}}')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{{uuid}}')
    .replace(
      /~\d+(?:y(?: \d+mo)?|mo(?: \d+d)?)|\b(?:\d+d(?: \d+h(?: \d+m \d+s)?)?|\d+h \d+m \d+s|\d+m \d+s|\d+(?:\.\d+)?s|\d+(?:\.\d+)?ms)\b/g,
      duration => duration.startsWith('~') ? duration : '{{duration}}',
    )
    .replace(
      /约\d+(?:年(?:\d+个月)?|个月(?:\d+天)?)|\d+(?:天(?:\d+小时(?:\d+分\d+秒)?)?|小时\d+分\d+秒|分\d+秒|(?:\.\d+)?秒)/g,
      duration => duration.startsWith('约') ? duration : '{{duration}}',
    )
    .replace(/\d{4}年\d{1,2}月\d{1,2}日 \d{2}:\d{2}/g, '{{clock}}')
    .replace(/\d{1,2}月\d{1,2}日 \d{2}:\d{2}/g, '{{clock}}')
    .replace(/(?<!\d)\d{1,2}:\d{2}:\d{2}(?:\.\d+)?(?:\s*[AP]M)?(?!\d)/gi, '{{clock}}')
    .replace(/(?<!\d)\d{2}:\d{2}(?!\d)/g, '{{clock}}')
}

/** Options for comparing or refreshing one normalized text golden. */
export interface TextGoldenOptions {
  /** Committed golden path. */
  path: string
  /** Normalized snapshot text. */
  actual: string
  /** Whether this run may rewrite the golden. */
  refresh: boolean
  /** Recovery instruction when replay finds no golden. */
  missingMessage: string
}

/**
 * Capture a locator's ARIA tree after two consecutive normalized readings
 * agree.
 * @param locator - browser locator owning the snapshot root.
 * @param normalize - application-specific volatility normalization.
 * @returns the stable normalized snapshot.
 */
export async function captureStableAria(
  locator: AriaSnapshotLocator,
  normalize: (snapshot: string) => string,
): Promise<string> {
  const deadline = Date.now() + 5_000
  let previous = normalize(await locator.ariaSnapshot())
  while (Date.now() < deadline) {
    await delay(100)
    const current = normalize(await locator.ariaSnapshot())
    if (current === previous) return current
    previous = current
  }
  throw new Error('aria snapshot did not stabilize')
}

/**
 * Compare one canonical newline-terminated golden, or rewrite it in refresh
 * mode.
 * @param options - golden path, normalized text, mode, and recovery message.
 */
export async function compareOrRefreshTextGolden(options: TextGoldenOptions): Promise<void> {
  const payload = `${options.actual.trimEnd()}\n`
  if (options.refresh) {
    await mkdir(dirname(options.path), { recursive: true })
    await writeFile(options.path, payload)
    return
  }
  if (!existsSync(options.path)) throw new Error(options.missingMessage)
  assert.equal(payload, await readFile(options.path, 'utf8'))
}
