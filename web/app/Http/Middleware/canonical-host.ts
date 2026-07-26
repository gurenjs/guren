import { defineMiddleware } from '@guren/core'

/**
 * Redirect a `www.` request to the bare host, permanently.
 *
 * Both hostnames resolve to this worker, so without it the site would answer
 * on two origins — splitting sessions (cookies are host-scoped) and search
 * ranking, and letting the same page be indexed twice.
 *
 * Only the leading `www.` is stripped: any other host reaching the worker is
 * left alone, so preview and local hostnames keep working.
 */
export const redirectToCanonicalHost = defineMiddleware(async (c, next) => {
  const url = new URL(c.req.url)

  if (!url.hostname.startsWith('www.')) {
    return next()
  }

  url.hostname = url.hostname.slice('www.'.length)

  return c.redirect(url.toString(), 301)
})
