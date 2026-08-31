/** Map explicit host facts to a supported vsce target. */
export function vsixTarget(
  platform: NodeJS.Platform,
  arch: string,
  libc?: 'glibc' | 'musl',
): string

/** Detect the current host and return its supported vsce target. */
export function hostVsixTarget(): string
