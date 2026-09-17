import { defineEnv, Env, type InferEnv } from '@guren/core'

const env = defineEnv({
  // config/database.ts carries the fallback, the local Docker database.
  DATABASE_URL: Env.string().optional(),
})

export default env

declare module '@guren/core' {
  interface AppEnv extends InferEnv<typeof env> {}
}
