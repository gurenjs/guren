/**
 * Kept out of the driver so it can be tested without the optional
 * `@aws-sdk/client-s3` peer installed: these functions decide what goes into a
 * command, the part that was wrong for every endpoint without ACL support.
 */

export type Visibility = 'public' | 'private'

export function cannedAcl(visibility: Visibility): string {
  return visibility === 'public' ? 'public-read' : 'private'
}

/**
 * Spreadable so the caller never sends an explicit `ACL: undefined`, which some
 * S3 implementations reject outright rather than treat as absent.
 */
export function putAclFields(acl: boolean, visibility: Visibility): { ACL?: string } {
  return acl ? { ACL: cannedAcl(visibility) } : {}
}

/**
 * Throws rather than silently dropping the request: a `setVisibility(path,
 * 'private')` that does nothing on a public bucket is a leak that looks like
 * success.
 */
export function assertVisibilitySupported(
  acl: boolean,
  diskVisibility: Visibility,
  requested: Visibility | undefined,
  operation: string,
): void {
  if (acl || !requested || requested === diskVisibility) {
    return
  }
  throw new Error(
    `S3Driver.${operation}: cannot make an object ${requested} on a ${diskVisibility} disk configured with acl: false. ` +
      'This endpoint does not implement S3 object ACLs, so visibility is a property of the bucket. ' +
      'Declare it with the driver\'s "visibility" option, or serve restricted files through your own route.',
  )
}
