const warned = new Set<string>()

/**
 * Emit a warning the first time a given key is seen in this process.
 *
 * Deprecation warnings have to be loud enough to be read once and quiet
 * enough not to drown a request log, which is the same shape the OAuth
 * warnings settled on (`auth/oauth/index.ts`) — this is that pattern with a
 * key, so several call sites can share it.
 */
export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) {
    return
  }
  warned.add(key)
  console.warn(message)
}

/** Test seam: forget what has already been warned about. */
export function resetWarnOnce(): void {
  warned.clear()
}
