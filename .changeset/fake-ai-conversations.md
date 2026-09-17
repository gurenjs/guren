---
'@guren/testing': minor
---

`app.fakeAi()` records prompts made through an agent's `continue(id)`, and its `conversations()` returns the store `config/ai.ts` configures, so a test can script a multi-turn conversation and read back what was stored.

The optional `@guren/plugin-ai` peer now starts at `>=0.1.0`, the first release that exports `bindAgent`. `continue()` and `conversations()` need the `@guren/plugin-ai` release that ships conversations.
