import { type BroadcastManager, getRequestContainer, Router } from '@guren/core'

export function registerBroadcastingRoutes(router: Router): void {
  // BroadcastProvider binds the manager on each app's container, so it is resolved per request.
  router.get('/broadcasting/socket', (c, next) =>
    getRequestContainer(c).make<BroadcastManager>('broadcast').webSocketMiddleware()(c, next),
  ).name('broadcasting.socket')
}
