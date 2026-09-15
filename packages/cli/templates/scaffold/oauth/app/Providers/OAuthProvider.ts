import { createOAuthManager, DatabaseOAuthStateStore, ServiceProvider, createGitHubOAuthProviderConfig, createGoogleOAuthProviderConfig, createDiscordOAuthProviderConfig } from '@guren/core'
import { oauthStates } from '../../db/schema.js'

export default class OAuthProvider extends ServiceProvider {
  register(): void {
    // The authorize redirect and its callback may reach different processes, so
    // the state tying them together lives in the database, not in memory.
    const oauth = createOAuthManager({ stateStore: new DatabaseOAuthStateStore(oauthStates) })
    this.container.instance('oauth', oauth)

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

    const discordClientId = process.env.OAUTH_DISCORD_CLIENT_ID
    const discordClientSecret = process.env.OAUTH_DISCORD_CLIENT_SECRET
    const discordRedirectUri = process.env.OAUTH_DISCORD_REDIRECT_URI
    if (discordClientId && discordClientSecret && discordRedirectUri) {
      oauth.registerProvider('discord', createDiscordOAuthProviderConfig({
        clientId: discordClientId,
        clientSecret: discordClientSecret,
        redirectUri: discordRedirectUri,
      }))
    }
  }
}
