---
"@guren/plugin-ai": minor
---

Add `embed()`, `embedMany()` and `image()` (RFC 0029 Part 3): the AI SDK's own
calls with the model resolved by provider name through `AiManager`, so nothing
in an application holds a model and `fakeAi()` answers them as it answers a
prompt. `AiManager` gains `imageModel(provider?)` beside `embeddingModel()`.
Each wrapper takes the SDK's own options plus `provider` (a name from
`config/ai.ts`) and `manager` (the default application's `ai` binding when
absent). Vector storage stays out of scope.
