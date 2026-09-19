import { Env, defineEnv, type InferEnv } from '@guren/core'

const env = defineEnv({
  // Optional: without it the approval ledger is off, and the app warns at boot.
  APP_KEY: Env.string().secret().optional(),
  // Read by config/database.ts on Bun; D1 replaces the file on Workers.
  SQLITE_DATABASE_PATH: Env.string().optional(),
  ANTHROPIC_API_KEY: Env.string().optional().secret(),
  // Jev (TypeSafe AI), for `POST /tickets/:id/triage`. The same model is on Vercel AI Gateway as `typesafe-ai/jev`.
  TYPESAFE_AI_API_KEY: Env.string().optional().secret(),
})

export default env

declare module '@guren/core' {
  interface AppEnv extends InferEnv<typeof env> {}
}
