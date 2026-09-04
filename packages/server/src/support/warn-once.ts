const warned = new Set<string>()

/**
 * Warn the first time a key is seen in this process: loud enough to be read
 * once, quiet enough not to drown a request log.
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
