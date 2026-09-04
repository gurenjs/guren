/**
 * Open-redirect classification shared by the redirect-safety middleware and the
 * OAuth `redirectTo` sanitizer. Every hardening fix belongs here so the two
 * layers cannot drift.
 */

/** Defuses backslash tricks such as `/\evil.com`. */
export function normalizeRedirectTarget(value: string): string {
  return value.replace(/\\/g, '/')
}

export function isAppRelativePath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//')
}

export function hostMatchesAllowlist(target: URL, allowedHosts: readonly string[]): boolean {
  const hostname = target.hostname.toLowerCase()
  const host = target.host.toLowerCase()

  for (const allowed of allowedHosts) {
    if (allowed.startsWith('*.')) {
      const suffix = allowed.slice(1).toLowerCase()
      if (hostname.endsWith(suffix) && hostname.length > suffix.length) {
        return true
      }
    } else if (host === allowed.toLowerCase()) {
      return true
    }
  }

  return false
}
