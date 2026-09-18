---
"@guren/example-agents": patch
---

Adds `TicketDigest`, an in-process AI agent behind `POST /ops/agents/digest`, with a `fakeAi()` test. The `tickets.index` route now advertises the tool name `tickets_index`, which Anthropic and OpenAI accept; the triager's scope in `config/agents.ts` and its `tools.call()` use the new name.
