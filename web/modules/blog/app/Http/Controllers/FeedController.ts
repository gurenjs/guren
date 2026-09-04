import { Controller } from '@guren/core'
import { DOCS_CACHE_CONTROL } from '../../../../../config/site.js'
import { listPublishedPosts } from '../../Services/published-posts.js'
import { buildRssFeed } from '../../Services/rss.js'

export default class FeedController extends Controller {
  async rss(): Promise<Response> {
    // Per request rather than memoized: the admin UI mutates these rows, and a
    // module-scope cache would strand a published post outside warm isolates.
    const xml = buildRssFeed(await listPublishedPosts())

    return this.text(xml, {
      headers: {
        'Content-Type': 'application/rss+xml; charset=utf-8',
        'Cache-Control': DOCS_CACHE_CONTROL,
      },
    })
  }
}
