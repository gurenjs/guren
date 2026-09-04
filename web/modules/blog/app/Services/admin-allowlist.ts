import { AuthorizationException } from '@guren/core'

/**
 * Single-admin allowlist: `BLOG_ADMIN_GITHUB_ID` names the only GitHub account
 * that may sign in. Unset means "nobody" in production, since an env var missed
 * during deployment must not hand post management to whoever signs in first;
 * local development accepts any account.
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
