import { defineEnv, Env, type InferEnv } from '@guren/core'

const env = defineEnv({
  APP_NAME: Env.string().default('Guren'),
  APP_ENV: Env.string().default('development'),
  APP_KEY: Env.string().secret().requiredInProduction()
    .describe('Signs cookies and encrypts session payloads.'),
  APP_DEBUG: Env.boolean().default(false),
  APP_URL: Env.url().requiredInProduction()
    .describe('Public base URL. Production host authorization answers only to its hostname.'),
  PORT: Env.port().default(3333),
  HOST: Env.string().default('0.0.0.0'),
  // config/database.ts carries the fallbacks, which differ per driver.
  DATABASE_URL: Env.string().optional(),
  TEST_DATABASE_URL: Env.string().optional()
    .describe('Read under NODE_ENV=test by the SQLite driver only.'),
})

export default env

declare module '@guren/core' {
  interface AppEnv extends InferEnv<typeof env> {}
}
