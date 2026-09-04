import {
  ServiceProvider,
  DatabaseOAuthStateStore,
  createGitHubOAuthProviderConfig,
  createOAuthManager,
} from '@guren/core'
import { oauthStates } from '../../../../db/schema.js'

/**
 * Owns the 'oauth' binding outright: CoreOAuthServiceProvider is deliberately
 * not registered, since it would bind the in-memory state store first. Workers
 * needs the database-backed one — the authorize redirect and its callback can
 * land on different isolates.
 */
export default class OAuthProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('oauth', () => {
      const oauth = createOAuthManager({
        stateStore: new DatabaseOAuthStateStore(oauthStates),
      })

      const clientId = process.env.OAUTH_GITHUB_CLIENT_ID
      const clientSecret = process.env.OAUTH_GITHUB_CLIENT_SECRET
      const redirectUri = process.env.OAUTH_GITHUB_REDIRECT_URI
      if (clientId && clientSecret && redirectUri) {
        oauth.registerProvider('github', createGitHubOAuthProviderConfig({
          clientId,
          clientSecret,
          redirectUri,
        }))
      }

      return oauth
    })
  }
}
