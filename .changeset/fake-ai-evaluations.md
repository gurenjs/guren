---
'@guren/testing': minor
---

`fakeAi()` scripts evaluations. `answer([{ ... }])` queues one answer set per future `evaluate()` (or evaluation through `ai.evaluationModel()`), a value per question: a string is a `choice` at probability 1, a number a `boolean`'s probability or a `score`'s position, and a full AI SDK answer passes through. Each value is checked against the questions when consumed, so a choice outside the options, a score past the last level or a probability outside 0 to 1 fails the call and the dispose; the fake cannot answer what the real model could not. `evaluations()`, `assertEvaluated(predicate?)` and `assertNeverEvaluated()` read the calls, and unconsumed answers fail the dispose. Needs `@guren/plugin-ai` with `AiManager.evaluationModel()` and `ai` `^7.0.106`.
