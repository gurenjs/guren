import { Controller } from '@guren/core'
import { DOCS_CACHE_CONTROL } from '../../../../../config/site.js'
import { listPublishedPosts } from '../../Services/published-posts.js'
import { buildRssFeed } from '../../Services/rss.js'

export default class FeedController extends Controller {
  async rss(): Promise<Response> {
    // Built per request rather than memoized: posts are rows the admin UI
    // mutates at runtime, and a module-scope cache would strand a published
    // post outside whichever isolates had already answered a request.
    const xml = buildRssFeed(await listPublishedPosts())

    return this.text(xml, {
      headers: {
        'Content-Type': 'application/rss+xml; charset=utf-8',
        'Cache-Control': DOCS_CACHE_CONTROL,
      },
    })
  }
}
