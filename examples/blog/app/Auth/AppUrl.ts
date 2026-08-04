/**
 * Absolute base URL for links that leave the app (password reset, email
 * verification).
 *
 * Deliberately not derived from the request in production. A request URL is
 * reconstructed from the `Host` header, which any client can forge, so a
 * forged host would make the app mail a genuine single-use token to a link
 * pointing at the attacker's own server. `APP_URL` is the only trustworthy
 * source, and production fails closed rather than falling back to the request.
 */
export function appUrl(request: { url: string }): string {
  const configured = process.env.APP_URL?.trim()

  if (configured) {
    // Parsed rather than concatenated: a malformed APP_URL has to fail here,
    // where every caller hits it, not later inside one particular link build.
    // Dropping any query/fragment and the trailing slash keeps the result
    // safe to append a path to.
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
