import { defineEnv, Env, type InferEnv } from '@guren/core'

// The declarations `guren add oauth` writes into an app's config/env.ts.
const env = defineEnv({
  OAUTH_GITHUB_CLIENT_ID: Env.string().optional(),
  OAUTH_GITHUB_CLIENT_SECRET: Env.string().optional().secret(),
  OAUTH_GITHUB_REDIRECT_URI: Env.url().optional(),
  OAUTH_GOOGLE_CLIENT_ID: Env.string().optional(),
  OAUTH_GOOGLE_CLIENT_SECRET: Env.string().optional().secret(),
  OAUTH_GOOGLE_REDIRECT_URI: Env.url().optional(),
  OAUTH_DISCORD_CLIENT_ID: Env.string().optional(),
  OAUTH_DISCORD_CLIENT_SECRET: Env.string().optional().secret(),
  OAUTH_DISCORD_REDIRECT_URI: Env.url().optional(),
})

export default env

declare module '@guren/core' {
  interface AppEnv extends InferEnv<typeof env> {}
}
