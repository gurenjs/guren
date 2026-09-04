import { defineMiddleware } from '@guren/core'

/**
 * Redirect a `www.` request to the bare host, permanently. Both hostnames
 * resolve to this worker, so otherwise the site answers on two origins,
 * splitting host-scoped cookies and search ranking. Only a leading `www.` is
 * stripped, so preview and local hostnames keep working.
 */
export const redirectToCanonicalHost = defineMiddleware(async (c, next) => {
  const url = new URL(c.req.url)

  if (!url.hostname.startsWith('www.')) {
    return next()
  }

  url.hostname = url.hostname.slice('www.'.length)

  return c.redirect(url.toString(), 301)
})
