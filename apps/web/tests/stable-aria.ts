/** Shared stabilization loop for exact textual aria goldens. */

import { setTimeout as delay } from 'node:timers/promises'

export interface StableAriaOptions {
  /** Total time allowed for two consecutive normalized captures to match. */
  timeoutMs?: number
  /** Delay between captures. */
  intervalMs?: number
}

/** Normalize path, identity, clock, and duration volatility in browser aria text. */
export function normalizeAriaSnapshot(snapshot: string, workspaceCwd: string): string {
  // Session headings render the workspace basename rather than its full path,
  // so normalize both POSIX and Windows spellings.
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

/**
 * Read until two consecutive normalized aria snapshots are identical.
 * Callers own the locator and normalization because Web and the VS Code
 * Extension Host have different roots and volatile path tokens.
 */
export async function captureStableAriaSnapshot(
  readSnapshot: () => Promise<string>,
  normalize: (snapshot: string) => string,
  options: StableAriaOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 5_000
  const intervalMs = options.intervalMs ?? 100
  const deadline = Date.now() + timeoutMs
  let previous = normalize(await readSnapshot())
  while (Date.now() < deadline) {
    await delay(intervalMs)
    const current = normalize(await readSnapshot())
    if (current === previous) return current
    previous = current
  }
  throw new Error('aria snapshot did not stabilize')
}
