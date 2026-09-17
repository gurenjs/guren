---
'@guren/cli': minor
---

`guren add ai` sets up conversation storage (RFC 0029 §5). In an app with a `db/schema.ts`, it appends the `ai_conversations` and `ai_messages` tables in the app's dialect, generates their migration, and adds `conversations: { driver: 'database', conversations: aiConversations, messages: aiMessages }` to `config/ai.ts`. `--no-conversations` skips all three.

- An app with no `db/schema.ts` still gets agents, with conversations left unconfigured.
- Re-running on an app that ran `add ai` before adds the tables and the store without duplicating either.
- A `config/ai.ts` that is not in the shape `add ai` writes is left alone, and the lines to add are printed.
