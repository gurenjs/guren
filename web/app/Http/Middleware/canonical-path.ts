import { defineMiddleware } from '@guren/core'

import { docCategoryLanding, normalizeDocCategory } from '../../Services/docs-config.js'
import { docPaths } from '../../../config/site.js'

const FEED_PATH = '/blog/rss.xml'
const FEED_ALIASES = new Set(['/blog/feed', '/feed', '/rss.xml', '/feed.xml'])
// Only the page routes: `/_guren/` and the asset paths have trailing-slash forms of their own.
const PAGE_PREFIXES = ['/docs', '/blog', '/start']

/**
 * Where a GET for `pathname` should be sent instead, or undefined when it is
 * already the canonical form. No route answers a trailing slash, a bare
 * category or a guessed feed URL, so each of these was a 404.
 */
export function canonicalPath(pathname: string): string | undefined {
  let path = pathname
  if (path.length > 1 && path.endsWith('/') && PAGE_PREFIXES.some((prefix) => path.startsWith(`${prefix}/`))) {
    path = path.replace(/\/+$/u, '') || '/'
  }

  if (FEED_ALIASES.has(path)) return FEED_PATH

  const bareCategory = /^\/docs(\/ja)?\/([a-z-]+)$/u.exec(path)
  const category = bareCategory ? normalizeDocCategory(bareCategory[2]) : null
  if (bareCategory && category) {
    const paths = docPaths(category, docCategoryLanding(category))
    return bareCategory[1] ? paths.ja : paths.en
  }

  return path === pathname ? undefined : path
}

export const redirectToCanonicalPath = defineMiddleware(async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next()

  const url = new URL(c.req.url)
  const target = canonicalPath(url.pathname)
  if (!target) return next()

  return c.redirect(`${target}${url.search}`, 301)
})
