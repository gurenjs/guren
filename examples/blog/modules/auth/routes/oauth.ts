import { requireGuest, type Router } from '@guren/core'
import OAuthController from '../app/Http/Controllers/OAuthController.js'

// Split from routes/index.ts so this module has a routes/ directory rather
// than a single routes.ts file: discoverModuleRoutesFiles() (packages/cli/
// src/discovery.ts) only scans the directory shape, so a single-file module
// — including the one `make:module` itself scaffolds — is invisible to
// `guren check`'s module route-registrar-wiring check.
export function registerOAuthRoutes(router: Router): void {
  router
    .get('/auth/:provider', { name: 'oauth.redirect' }, [OAuthController, 'redirectToProvider'])
    .middleware(requireGuest({ redirectTo: '/dashboard' }))

  // Public: the provider redirects here directly, before any session exists.
  router.get('/auth/:provider/callback', { name: 'oauth.callback' }, [OAuthController, 'callback'])
}
