/**
 * Absolute base URL for links that leave the app (password reset, email
 * verification). Never derived from the request in production: a request URL is
 * reconstructed from the forgeable `Host` header, so a forged host would mail a
 * genuine single-use token to a link at the attacker's own server. Production
 * fails closed rather than falling back to the request.
 */
export function appUrl(request: { url: string }): string {
  const configured = process.env.APP_URL?.trim()

  if (configured) {
    // Parsed rather than concatenated, so a malformed APP_URL fails here, where
    // every caller hits it. Dropping query/fragment and the trailing slash
    // keeps the result safe to append a path to.
    const parsed = new URL(configured)
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'APP_URL is not set. Set it to the public base URL of this app (for example ' +
        'https://example.com): links sent by email must not be derived from the request host.',
    )
  }

  return new URL(request.url).origin
}
