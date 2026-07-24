import { ServiceProvider, type OAuthManager, createGitHubOAuthProviderConfig, createGoogleOAuthProviderConfig } from '@guren/core'

export default class OAuthProvider extends ServiceProvider {
  register(): void {
    const oauth = this.container.make<OAuthManager>('oauth')

    const githubClientId = process.env.OAUTH_GITHUB_CLIENT_ID
    const githubClientSecret = process.env.OAUTH_GITHUB_CLIENT_SECRET
    const githubRedirectUri = process.env.OAUTH_GITHUB_REDIRECT_URI
    if (githubClientId && githubClientSecret && githubRedirectUri) {
      oauth.registerProvider('github', createGitHubOAuthProviderConfig({
        clientId: githubClientId,
        clientSecret: githubClientSecret,
        redirectUri: githubRedirectUri,
      }))
    }

    const googleClientId = process.env.OAUTH_GOOGLE_CLIENT_ID
    const googleClientSecret = process.env.OAUTH_GOOGLE_CLIENT_SECRET
    const googleRedirectUri = process.env.OAUTH_GOOGLE_REDIRECT_URI
    if (googleClientId && googleClientSecret && googleRedirectUri) {
      oauth.registerProvider('google', createGoogleOAuthProviderConfig({
        clientId: googleClientId,
        clientSecret: googleClientSecret,
        redirectUri: googleRedirectUri,
      }))
    }
  }
}
