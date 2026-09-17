import { defineEnv, Env, type InferEnv } from '@guren/core'

// The declaration `guren add session` writes into an app's config/env.ts.
const env = defineEnv({
  SESSION_DRIVER: Env.string().default('database'),
})

export default env

declare module '@guren/core' {
  interface AppEnv extends InferEnv<typeof env> {}
}
