import { defineEnv, Env, type InferEnv } from '@guren/core'

// The declaration `guren add cache` writes into an app's config/env.ts.
const env = defineEnv({
  CACHE_STORE: Env.string().default('memory'),
})

export default env

declare module '@guren/core' {
  interface AppEnv extends InferEnv<typeof env> {}
}
