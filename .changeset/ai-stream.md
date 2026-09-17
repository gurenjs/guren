---
'@guren/plugin-ai': minor
---

Agents stream (RFC 0029 §4). `stream(input, options)` returns a UI-message stream `Response` for `useChat`, and `@guren/plugin-ai/client` exports `createChatTransport()` to consume it:

```ts
async chat() {
  const { conversation, message } = await this.validateBody(ChatTurnSchema)
  const user = await this.auth.userOrFail()
  return this.make('ai').agent(SupportTriager).as(user).stream(message, { conversation: conversation ?? true, signal: this.request.raw.signal })
}
```

```tsx
const { messages, sendMessage } = useChat({
  transport: createChatTransport('/support/chat', { conversation: props.conversationId }),
})
```

- A started or continued conversation is named in the `X-Guren-Conversation` response header. The turn is stored when the stream ends. An aborted turn stores nothing, and a storage failure is logged.
- A chat needs `conversations` in `config/ai.ts`: the server holds the history, and the first turn fails naming the missing store when none is configured.
- The transport posts `{ conversation, message }` with the `XSRF-TOKEN` cookie as `X-XSRF-TOKEN`. That is the last user message as text, never the transcript, since the server holds the history. It refuses `regenerate-message`.
- `ChatTurnSchema` validates that body. `zod` is now a peer dependency, on the range `ai` itself requires.
- `ConversationStore.create()` takes the conversation id from its caller and returns nothing. A hand-written `ConversationStore` implementation must change its `create()`.
