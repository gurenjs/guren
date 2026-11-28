import { Router } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'

export function registerWebRoutes(router: Router): void {
  router.get('/', [HomeController, 'index']).name('home')

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
