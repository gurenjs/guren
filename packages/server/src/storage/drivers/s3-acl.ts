/**
 * The ACL half of the S3 driver, kept out of the driver so it can be tested
 * without the optional `@aws-sdk/client-s3` peer installed: these functions
 * decide what goes into a command, which is exactly the part that was wrong
 * for every S3-compatible endpoint without ACL support.
 */

export type Visibility = 'public' | 'private'

/** The canned ACL S3 uses for each visibility. */
export function cannedAcl(visibility: Visibility): string {
  return visibility === 'public' ? 'public-read' : 'private'
}

/**
 * The `ACL` field for a `PutObject` input, or nothing when the endpoint has
 * no ACLs. Returned as a spreadable object so the caller never sends an
 * explicit `ACL: undefined`, which some S3 implementations reject outright
 * rather than treat as absent.
 */
export function putAclFields(acl: boolean, visibility: Visibility): { ACL?: string } {
  return acl ? { ACL: cannedAcl(visibility) } : {}
}

/**
 * Guard for a per-object visibility an ACL-less endpoint cannot honour.
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
