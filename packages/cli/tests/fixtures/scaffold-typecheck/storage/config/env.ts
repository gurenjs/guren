import { defineEnv, Env, type InferEnv } from '@guren/core'

// The declaration `guren add storage` writes into an app's config/env.ts.
const env = defineEnv({
  STORAGE_DISK: Env.string().default('local'),
})

export default env

declare module '@guren/core' {
  interface AppEnv extends InferEnv<typeof env> {}
}
