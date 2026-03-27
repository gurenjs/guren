import { Router } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'

export function registerWebRoutes(router: Router): void {
  router.get('/', [HomeController, 'index'])
}
