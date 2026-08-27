import { Router } from '@guren/core'
import OAuthController from '../app/Http/Controllers/Auth/OAuthController.js'

export function registerOAuthRoutes(router: Router): void {
  router.get('/auth/:provider', [OAuthController, 'redirectToProvider']).name('oauth.redirect')
  router.get('/auth/:provider/callback', [OAuthController, 'callback']).name('oauth.callback')
}

export default registerOAuthRoutes
