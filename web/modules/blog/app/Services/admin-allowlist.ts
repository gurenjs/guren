import { AuthorizationException } from '@guren/core'

/**
 * Single-admin allowlist. `BLOG_ADMIN_GITHUB_ID` names the only GitHub
 * account that may sign in (or have an account created).
 *
 * Unset means "nobody" in production: an env var missed during deployment
 * must never hand post management to whoever signs in first. Local
 * development, where the id often isn't known yet, accepts any account.
 */
export function isAllowlistedAdmin(
  profileId: string,
  allowlistedId: string | undefined | null,
  isProduction: boolean = process.env.NODE_ENV === 'production',
): boolean {
  const expected = allowlistedId?.trim()
  if (!expected) return !isProduction
  return profileId === expected
}

export function assertAllowlistedAdmin(
  profileId: string,
  allowlistedId: string | undefined | null,
  isProduction: boolean = process.env.NODE_ENV === 'production',
): void {
  if (isAllowlistedAdmin(profileId, allowlistedId, isProduction)) return
  throw new AuthorizationException('This GitHub account is not allowed to sign in to this blog.')
}
