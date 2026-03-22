import { Router } from '@guren/core'
import DocsController from '../app/Http/Controllers/DocsController.js'
import HomeController from '../app/Http/Controllers/HomeController.js'

export function registerWebRoutes(router: Router): void {
  router.get('/', [HomeController, 'index'])

  router.group('/docs', (docs) => {
    docs.get('/', [DocsController, 'index'])
    docs.get('/ja', [DocsController, 'indexJa'])
    docs.get('/ja/:category/:slug', [DocsController, 'showJa'])
    docs.get('/:category/:slug', [DocsController, 'show'])
  })
}

export default registerWebRoutes
