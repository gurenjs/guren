import { requireGuest, type Router } from '@guren/core'
import OAuthController from '../app/Http/Controllers/OAuthController.js'

// Split from routes/index.ts so this module's own route graph has more than
// one file — `guren check`'s module-wiring scan otherwise never walks past
// a single-file registrar (see modules/auth/index.ts's comment).
export function registerOAuthRoutes(router: Router): void {
  router
    .get('/auth/:provider', { name: 'oauth.redirect' }, [OAuthController, 'redirectToProvider'])
    .middleware(requireGuest({ redirectTo: '/dashboard' }))

  // Public: the provider redirects here directly, before any session exists.
  router.get('/auth/:provider/callback', { name: 'oauth.callback' }, [OAuthController, 'callback'])
}
