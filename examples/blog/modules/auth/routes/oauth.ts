import type { Router } from '@guren/core'
import OAuthController from '../app/Http/Controllers/OAuthController.js'

// Kept apart from index.ts so `guren check` has a module route file to prove
// the registrar reaches; the entry file itself is never a candidate.
export function registerOAuthRoutes(router: Router<'auth.guest'>): void {
  router
    .get('/auth/:provider', { name: 'oauth.redirect' }, [OAuthController, 'redirectToProvider'])
    .middleware('auth.guest')

  // Public: the provider redirects here directly, before any session exists.
  router.get('/auth/:provider/callback', { name: 'oauth.callback' }, [OAuthController, 'callback'])
}
