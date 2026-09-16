import { defineEnv, Env, type InferEnv } from '@guren/core'

// The declaration `guren add queue` writes into an app's config/env.ts.
const env = defineEnv({
  QUEUE_CONNECTION: Env.string().default('sync'),
})

export default env

declare module '@guren/core' {
  interface AppEnv extends InferEnv<typeof env> {}
}
