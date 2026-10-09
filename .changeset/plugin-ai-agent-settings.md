---
"@guren/plugin-ai": minor
---

Add per-agent call settings (`settings`: `maxOutputTokens`, `providerOptions` and the rest of the AI SDK's call settings), resumable paused turns (`continueWhen`, `maxContinuations` and `isPausedTurn` for Anthropic's `pause_turn`), and `rawFinishReason`, `sources`, `providerMetadata` and `modelId` on `AgentResponse`. `usageOf()`, `addUsage()`, `computeCostUsd()` and `sumCosts()` are exported from the main entry, and `AiPricing.perThousandRequests` prices provider-executed tool calls such as web search, in evals too.
