---
'@guren/plugin-ai': minor
---

Agents keep conversations (RFC 0029 §5). Configure a store in `config/ai.ts`, then start a conversation with `prompt(input, { conversation: true })` and continue it with `continue(id)`:

```ts
const first = await SupportTriager.as(user).prompt('Hello', { conversation: true })
const next = await SupportTriager.as(user).continue(first.conversationId!).prompt('Tell me more')
```

- `conversations: { driver: 'memory' }` keeps history in the process. `{ driver: 'database', conversations, messages }` stores it in two tables through ORM Models, one row per `ModelMessage`.
- A plain `prompt()` stores nothing.
- A conversation belongs to the principal that started it and to its agent. `continue()` under another principal, another agent or `as(null)` is refused before any model call.
- Each turn is appended in one transaction, after the model answers.
- The stored transcript is what the model saw, tool results included, so treat the tables as sensitive data.
- `AiManager` gains a required `conversations()` method. A hand-written `AiManager` implementation must add it.
- The `database` driver appends inside `Model.transaction()`, so it needs a database driver with interactive transactions.
