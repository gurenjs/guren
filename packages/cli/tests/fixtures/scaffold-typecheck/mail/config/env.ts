import { defineEnv, Env, type InferEnv } from '@guren/core'

// The declarations `guren add mail` writes into an app's config/env.ts.
const env = defineEnv({
  MAIL_MAILER: Env.string().default('log'),
  MAIL_FROM_ADDRESS: Env.string().default('noreply@example.com'),
  MAIL_FROM_NAME: Env.string().default('Guren'),
  SMTP_HOST: Env.string().default('localhost'),
  SMTP_PORT: Env.port().default(587),
  SMTP_USER: Env.string().optional(),
  SMTP_PASS: Env.string().optional().secret(),
})

export default env

declare module '@guren/core' {
  interface AppEnv extends InferEnv<typeof env> {}
}
