import { Router } from '@guren/core'

export function registerApiRoutes(router: Router): void {
  router.get('/health', (c) => c.json({ status: 'ok' }))

  router.group('/api/v1', (api) => {
    api.get('/', (c) => c.json({ message: 'Welcome to the API' }))
  })
}
