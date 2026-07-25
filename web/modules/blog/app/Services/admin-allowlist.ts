import { AuthorizationException } from '@guren/core'

/**
 * Single-admin allowlist: when BLOG_ADMIN_GITHUB_ID is set, only that GitHub
 * account may sign in (or have an account created). When unset — local dev
 * before the admin id is known — any GitHub account is accepted.
 */
export function isAllowlistedAdmin(
  profileId: string,
  allowlistedId: string | undefined | null,
): boolean {
  const expected = allowlistedId?.trim()
  if (!expected) return true
  return profileId === expected
}

export function assertAllowlistedAdmin(
  profileId: string,
  allowlistedId: string | undefined | null,
): void {
  if (isAllowlistedAdmin(profileId, allowlistedId)) return
  throw new AuthorizationException('This GitHub account is not allowed to sign in to this blog.')
}
