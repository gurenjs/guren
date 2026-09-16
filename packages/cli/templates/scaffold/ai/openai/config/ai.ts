import { createOpenAI } from '@ai-sdk/openai'
import { defineAiConfig } from '@guren/plugin-ai'

// An agent names a provider from `providers`, never a model: the fake in
// @guren/testing replaces every model by replacing this manager. `model` runs on
// first use, so the app boots without OPENAI_API_KEY and the first prompt fails.
export default defineAiConfig((env) => ({
  default: 'openai',
  providers: {
    openai: {
      model: () => createOpenAI({ apiKey: env.OPENAI_API_KEY })('gpt-5'),
    },
  },
}))
