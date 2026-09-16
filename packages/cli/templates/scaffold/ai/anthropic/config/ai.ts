import { createAnthropic } from '@ai-sdk/anthropic'
import { defineAiConfig } from '@guren/plugin-ai'

// An agent names a provider from `providers`, never a model: the fake in
// @guren/testing replaces every model by replacing this manager. `model` runs on
// first use, so the app boots without ANTHROPIC_API_KEY and the first prompt fails.
export default defineAiConfig((env) => ({
  default: 'anthropic',
  providers: {
    anthropic: {
      model: () => createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })('claude-opus-5'),
    },
  },
}))
