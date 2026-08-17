/** Shared browser ARIA stabilization and text-golden handling for app tests. */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { expect } from 'vitest'

/** Browser-locator face required by the shared ARIA stabilizer. */
export interface AriaSnapshotLocator {
  /** Capture the current accessibility tree for this locator. */
  ariaSnapshot(): Promise<string>
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
  let previous = normalize(await locator.ariaSnapshot())
  await expect.poll(async () => {
    const current = normalize(await locator.ariaSnapshot())
    const stable = current === previous
    previous = current
    return stable
  }, { timeout: 5_000, message: 'aria snapshot did not stabilize' }).toBe(true)
  return previous
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
  expect(payload).toBe(await readFile(options.path, 'utf8'))
}
