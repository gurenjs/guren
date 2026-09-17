import { DatabaseOAuthStateStore, defineOAuthConfig, type OAuthProviderConfig, createGitHubOAuthProviderConfig, createGoogleOAuthProviderConfig, createDiscordOAuthProviderConfig } from '@guren/core'
import { oauthStates } from '../db/schema.js'

export default defineOAuthConfig((env) => {
  // A provider is registered only when all three of its keys are set, so a
  // half-configured one fails app-side rather than at the provider.
  const providers: Record<string, OAuthProviderConfig> = {}

  if (env.OAUTH_GITHUB_CLIENT_ID && env.OAUTH_GITHUB_CLIENT_SECRET && env.OAUTH_GITHUB_REDIRECT_URI) {
    providers.github = createGitHubOAuthProviderConfig({
      clientId: env.OAUTH_GITHUB_CLIENT_ID,
      clientSecret: env.OAUTH_GITHUB_CLIENT_SECRET,
      redirectUri: env.OAUTH_GITHUB_REDIRECT_URI,
    })
  }

  if (env.OAUTH_GOOGLE_CLIENT_ID && env.OAUTH_GOOGLE_CLIENT_SECRET && env.OAUTH_GOOGLE_REDIRECT_URI) {
    providers.google = createGoogleOAuthProviderConfig({
      clientId: env.OAUTH_GOOGLE_CLIENT_ID,
      clientSecret: env.OAUTH_GOOGLE_CLIENT_SECRET,
      redirectUri: env.OAUTH_GOOGLE_REDIRECT_URI,
    })
  }

  if (env.OAUTH_DISCORD_CLIENT_ID && env.OAUTH_DISCORD_CLIENT_SECRET && env.OAUTH_DISCORD_REDIRECT_URI) {
    providers.discord = createDiscordOAuthProviderConfig({
      clientId: env.OAUTH_DISCORD_CLIENT_ID,
      clientSecret: env.OAUTH_DISCORD_CLIENT_SECRET,
      redirectUri: env.OAUTH_DISCORD_REDIRECT_URI,
    })
  }

  return {
    providers,
    // The authorize redirect and its callback may reach different processes, so
    // the state tying them together lives in the database, not in memory.
    stateStore: new DatabaseOAuthStateStore(oauthStates),
  }
})
