/**
 * Shared open-redirect classification primitives, used by both the
 * redirect-safety middleware and the OAuth `redirectTo` sanitizer. Keep every
 * hardening fix here so the two layers cannot drift.
 */

/** Normalize backslash tricks (e.g. `/\evil.com`) before classifying. */
export function normalizeRedirectTarget(value: string): string {
  return value.replace(/\\/g, '/')
}

/** App-relative paths (`/path`, but not protocol-relative `//host`) are always safe. */
export function isAppRelativePath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//')
}

/** Match a URL's host against an allowlist supporting `*.example.com` wildcards. */
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
