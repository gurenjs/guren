import { defineEnv, Env, type InferEnv } from '@guren/core'

const env = defineEnv({
  APP_NAME: Env.string().default('Guren Blog'),
  APP_ENV: Env.string().default('development'),
  APP_KEY: Env.string().secret().requiredInProduction()
    .describe('Signs cookies and encrypts session payloads.'),
  APP_DEBUG: Env.boolean().default(false),
  APP_URL: Env.url().requiredInProduction()
    .describe('Public base URL. Production host authorization answers only to its hostname.'),
  PORT: Env.port().default(3333),
  HOST: Env.string().default('0.0.0.0'),
  // config/database.ts carries the fallback, the local Docker database.
  DATABASE_URL: Env.string().optional(),
  REDIS_URL: Env.url().optional().describe('Read only when CACHE_STORE=redis.'),
  SESSION_DRIVER: Env.string().default('database'),
  CACHE_STORE: Env.string().default('memory'),
  QUEUE_CONNECTION: Env.string().default('memory'),
  MAIL_MAILER: Env.string().default('log'),
  RESEND_API_KEY: Env.string().secret().optional().describe('Read only when MAIL_MAILER=resend.'),
  MAIL_FROM_ADDRESS: Env.string().default('noreply@blog.example.com'),
  MAIL_FROM_NAME: Env.string().default('Guren Blog'),
  OAUTH_GITHUB_CLIENT_ID: Env.string().optional(),
  OAUTH_GITHUB_CLIENT_SECRET: Env.string().secret().optional(),
  OAUTH_GITHUB_REDIRECT_URI: Env.url().optional(),
  OAUTH_GOOGLE_CLIENT_ID: Env.string().optional(),
  OAUTH_GOOGLE_CLIENT_SECRET: Env.string().secret().optional(),
  OAUTH_GOOGLE_REDIRECT_URI: Env.url().optional(),
})

export default env

declare module '@guren/core' {
  interface AppEnv extends InferEnv<typeof env> {}
}
