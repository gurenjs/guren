import {
  ServiceProvider,
  DatabaseOAuthStateStore,
  createGitHubOAuthProviderConfig,
  createOAuthManager,
} from '@guren/core'
import { oauthStates } from '../../../../db/schema.js'

/**
 * Owns the 'oauth' container binding outright — CoreOAuthServiceProvider is
 * deliberately NOT registered, since it would bind a manager with the
 * in-memory state store first. The database-backed store is required on
 * Workers: the authorize redirect and its callback can land on different
 * isolates that share nothing but the database.
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
