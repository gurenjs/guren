import { createOpenAI } from '@ai-sdk/openai'
import { defineAiConfig } from '@guren/plugin-ai'

// An agent names a provider from `providers`, never a model: the fake in
// @guren/testing replaces every model by replacing this manager. `model` runs on
// first use, so the app boots without OPENAI_API_KEY. The guard matters: given no key, the
// SDK reads process.env itself and sends a blank `OPENAI_API_KEY=` to the API as a real key.
export default defineAiConfig((env) => ({
  default: 'openai',
  providers: {
    openai: {
      model: () => {
        if (!env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY in .env to call the openai provider.')
        return createOpenAI({ apiKey: env.OPENAI_API_KEY })('gpt-5')
      },
    },
  },
}))
