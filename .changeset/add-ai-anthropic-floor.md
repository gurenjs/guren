---
"@guren/cli": patch
---

`guren add ai --provider anthropic` installs `@ai-sdk/anthropic@^4.0.78`, a release that knows Claude Opus 5.5 rejects forced tool choice and disabled thinking, and sends an agent's `output` schema through `output_config.format`.
