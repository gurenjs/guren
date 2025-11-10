import { Route } from '@guren/server'
import DocsController from '../app/Http/Controllers/DocsController.js'
import HomeController from '../app/Http/Controllers/HomeController.js'

Route.get('/', [HomeController, 'index'])

Route.group('/docs', () => {
  Route.get('/', [DocsController, 'index'])
  Route.get('/:category/:slug', [DocsController, 'show'])
})
