---
'@guren/plugin-ai': minor
'@guren/testing': patch
'@guren/cli': patch
---

A chat page can now restore its messages after a reload. `ai.agent(Agent).as(user).history(id)` reads a stored conversation under the same owner and `agentName` checks as `continue()` and returns it as `useChat` messages, or `null` for an unknown id, another user's conversation and another agent's alike. Pass the result and the id in the page props and give them to `useChat({ id, messages })`; the next turn still sends only `{ conversation, message }`. `toUIMessages()` is the conversion on its own: one assistant message per turn with a `step-start` per model call, and each tool call as a `tool-<name>` part in its final state. `UIMessage` is re-exported from `@guren/plugin-ai` and `@guren/plugin-ai/client`.

`BoundAgent` gains the `history()` member, so a hand-written `BoundAgent` must add it. `fakeAi()` in `@guren/testing` forwards it; an older `@guren/testing` paired with this release leaves `history()` off the agents it records.

The harness's `ai-agent` skill says how a chat page restores its history.
