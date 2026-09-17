import { defineEnv, Env, type InferEnv } from '@guren/core'

// The declarations `guren add ai` writes into an app's config/env.ts, one per --provider.
const env = defineEnv({
  ANTHROPIC_API_KEY: Env.string().optional().secret(),
  OPENAI_API_KEY: Env.string().optional().secret(),
  AI_GATEWAY_API_KEY: Env.string().optional().secret(),
})

export default env

declare module '@guren/core' {
  interface AppEnv extends InferEnv<typeof env> {}
}
