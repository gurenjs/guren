import { createAnthropic } from '@ai-sdk/anthropic'
import { defineAiConfig } from '@guren/plugin-ai'

// An agent names a provider from `providers`, never a model: the fake in
// @guren/testing replaces every model by replacing this manager. `model` runs on
// first use, so the app boots without ANTHROPIC_API_KEY. The guard matters: given no key, the
// SDK reads process.env itself and sends a blank `ANTHROPIC_API_KEY=` to the API as a real key.
export default defineAiConfig((env) => ({
  default: 'anthropic',
  providers: {
    anthropic: {
      model: () => {
        if (!env.ANTHROPIC_API_KEY) throw new Error('Set ANTHROPIC_API_KEY in .env to call the anthropic provider.')
        return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })('claude-opus-5')
      },
    },
  },
}))
