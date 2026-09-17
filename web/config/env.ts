import { defineEnv, Env, type InferEnv } from '@guren/core'

// On Workers this parses the entrypoint env (vars and secrets), not process.env.
const env = defineEnv({
  APP_KEY: Env.string().secret().requiredInProduction()
    .describe('Signs sessions and CSRF tokens.'),
  SQLITE_DATABASE_PATH: Env.string().default('./data/guren.db'),
  SESSION_DRIVER: Env.string().default('database'),
  OAUTH_GITHUB_CLIENT_ID: Env.string().optional(),
  OAUTH_GITHUB_CLIENT_SECRET: Env.string().secret().optional(),
  // Not Env.url(): a malformed value should disable admin login, not fail the whole site's boot.
  OAUTH_GITHUB_REDIRECT_URI: Env.string().optional(),
  BLOG_ADMIN_GITHUB_ID: Env.string().optional()
    .describe('The one GitHub account id allowed to sign in. Unset refuses everyone in production.'),
})

export default env

declare module '@guren/core' {
  interface AppEnv extends InferEnv<typeof env> {}
}
