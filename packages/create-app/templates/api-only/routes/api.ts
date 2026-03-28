import { Router } from '@guren/core'

export function registerApiRoutes(router: Router): void {
  router.get('/health', (c) => c.json({ status: 'ok' }))

  router.prefix('/api/v1').group((api) => {
    api.get('/', (c) => c.json({ message: 'Welcome to the API' }))
  })
}
