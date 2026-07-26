import { type Router, requireAuthenticated } from '@guren/server'
import WidgetController from './app/Http/Controllers/WidgetController.js'

export function registerWidgetRoutes(baseRouter: Router): void {
  const router = baseRouter.aliasMiddleware(
    'widgets.auth',
    requireAuthenticated({ redirectTo: '/login' }),
  )

  router.get('/widgets', [WidgetController, 'index']).name('widgets.index')
}
