import { Router } from '@guren/core'
import { docsSearchRateLimit } from '../app/Http/Middleware/docs-search-rate-limit.js'
import DocsController from '../app/Http/Controllers/DocsController.js'
import DocsSearchController, { DocSearchQuerySchema } from '../app/Http/Controllers/DocsSearchController.js'
import HomeController from '../app/Http/Controllers/HomeController.js'
import MetaController from '../app/Http/Controllers/MetaController.js'

export function registerWebRoutes(router: Router): void {
  router.get('/', [HomeController, 'index'])

  // Machine-facing endpoints: crawlers and LLM agents.
  router.get('/sitemap.xml', [MetaController, 'sitemap'])
  router.get('/llms.txt', [MetaController, 'llms'])
  router.get('/llms-full.txt', [MetaController, 'llmsFull'])

  router.group('/docs', (docs) => {
    docs.get('/', [DocsController, 'index'])
    // Two segments, so it cannot collide with the three-segment doc pages
    // below. Locale is a query parameter rather than a path prefix — the
    // search box is one endpoint serving both /docs and /docs/ja.
    docs.get(
      '/search',
      {
        name: 'docs.search',
        query: DocSearchQuerySchema,
        middlewares: [docsSearchRateLimit],
      },
      [DocsSearchController, 'search'],
    )
    docs.get('/ja', [DocsController, 'indexJa'])
    docs.get('/ja/:category/:slug', [DocsController, 'showJa'])
    docs.get('/:category/:slug', [DocsController, 'show'])
  })
}

export default registerWebRoutes
