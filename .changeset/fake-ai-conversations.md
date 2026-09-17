---
'@guren/testing': minor
---

`app.fakeAi()` records prompts made through an agent's `continue(id)`, and its `conversations()` returns the store `config/ai.ts` configures, so a test can script a multi-turn conversation and read back what was stored.
