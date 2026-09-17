import { defineAiConfig } from '@guren/plugin-ai'
import { createGateway } from 'ai'

// An agent names a provider from `providers`, never a model: the fake in
// @guren/testing replaces every model by replacing this manager. On Vercel the
// gateway authenticates with the deployment's OIDC token when AI_GATEWAY_API_KEY is unset.
export default defineAiConfig((env) => ({
  default: 'gateway',
  providers: {
    gateway: {
      model: () => createGateway({ apiKey: env.AI_GATEWAY_API_KEY })('anthropic/claude-opus-5'),
    },
  },
}))
