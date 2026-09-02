import { Controller } from '@guren/core'
import { z } from 'zod'

import {
  docSearchService,
  SearchIndexUnavailableError,
  type DocSearchResult,
} from '../../Services/DocSearchService.js'

/**
 * Longest query accepted. Every term is ANDed, so a longer one narrows rather
 * than widens; the cap is there to bound the work a single request can ask of
 * FTS5, not to constrain the reader.
 */
const MAX_QUERY_LENGTH = 64

export const DocSearchQuerySchema = z.object({
  q: z.string().min(1).max(MAX_QUERY_LENGTH),
  locale: z.enum(['en', 'ja']).default('en'),
})

/**
 * The index only changes when a deploy rebuilds it, so a repeated query is
 * safe to serve from cache for a short window. This is the browser's cache
 * only: the Worker runs on every request, and nothing here or in
 * wrangler.jsonc puts the response in Cloudflare's cache, so two readers
 * asking the same thing are still two D1 reads.
 */
const SEARCH_CACHE_CONTROL = 'public, max-age=60'

export interface DocSearchResponse {
  query: string
  locale: 'en' | 'ja'
  results: DocSearchResult[]
}

/**
 * `GET /docs/search` — JSON rather than an Inertia page, so a keystroke costs
 * a query and not a server-rendered React tree.
 */
export default class DocsSearchController extends Controller {
  async search(): Promise<Response> {
    const { q, locale } = this.validateQuery(DocSearchQuerySchema)

    try {
      const results = await docSearchService.search(q, locale)
      return this.json<DocSearchResponse>(
        { query: q, locale, results },
        { headers: { 'Cache-Control': SEARCH_CACHE_CONTROL } },
      )
    } catch (error) {
      if (error instanceof SearchIndexUnavailableError) {
        // The error's own text names the build commands and the artifact path
        // that fix this. That belongs in a log, where whoever deploys will
        // read it — not in a response to whoever happened to search. Returning
        // it also walked around the sanitizing the framework's exception
        // handler does in production.
        console.error(error.message)
        // Not cached: the next deploy is expected to fix it.
        return this.json({ error: 'Search is not available on this deployment.' }, {
          status: error.statusCode,
        })
      }
      throw error
    }
  }
}
