---
'@guren/plugin-ai': patch
---

`createChatTransport()` adopts the conversation id from the `X-Guren-Conversation` header, and calls `onConversation`, only once the turn's body has been read to its end after a `finish` chunk with no `error` or `abort`. A first turn stopped or failed before the model answered stores no conversation, and the transport used to keep its id anyway, so every later turn failed with "cannot continue conversation". Now the next turn starts a new conversation.
