---
'@guren/plugin-ai': minor
---

Evaluation models in `config/ai.ts` (RFC 0029 §3, amended). A provider entry may carry `evaluationModel: () => AiEvaluationModel`, an AI SDK evaluation model such as `createTypeSafeAi().evaluationModel('jev-latest')` or `gateway.evaluationModel('typesafe-ai/jev')`, and `model` is now optional so an entry may exist for evaluation alone. `AiConfig.defaultEvaluation` names the entry evaluations use when the call names none (checked at boot like `default`; `default` when absent). `AiManager` gains `evaluationModel(provider?)`, memoized like `model()`, and `evaluate({ state, questions, provider?, manager? })` joins `embed()` and `image()`: the AI SDK's `experimental_evaluate` with the model resolved by provider name, so `fakeAi()` scripts every answer. The `AiEvaluation*` types re-export the SDK's; the SDK marks the API experimental and may change it in a patch release, so `ai` now needs `^7.0.106`.
