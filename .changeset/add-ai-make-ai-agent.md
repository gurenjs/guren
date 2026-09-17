---
'@guren/cli': minor
---

`guren add ai` and `guren make:ai-agent` scaffold in-process AI agents (RFC 0029 §8).

```bash
bunx guren add ai --provider anthropic
bunx guren make:ai-agent SupportTriager --tools tickets_show,tickets_update --output --test
```

- `add ai` writes `config/ai.ts` for `anthropic`, `openai` or `gateway`. It declares the provider's API key in `config/env.ts` and the env files, registers the config and `aiPlugin()` in `createApp()`, and runs `bun add @guren/plugin-ai ai <provider package>`. `--no-install` prints that command instead.
- The key is optional, so the app boots without it. The first prompt then throws, naming the variable to set, before any request: given no key, the AI SDK would send the blank `.env` value to the API. The command refuses an app without `config/env.ts`.
- `make:ai-agent` writes `app/Ai/Agents/<Name>.ts` with a pinned `agentName`. `--tools` checks each name against the tools the app's routes derive, refuses an unknown one before writing, and warns on a name Anthropic and OpenAI reject. `--output` adds a Zod schema stub, and `--test` writes a test that scripts the model with `app.fakeAi()`. `--module` places both inside the module.
- `add ai` writes no conversation tables yet; they come with the `database` conversation store.
