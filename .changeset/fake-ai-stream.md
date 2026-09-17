---
'@guren/testing': minor
---

`app.fakeAi()` scripts `stream()` as well as `prompt()`. A streamed call is recorded on entry, and its `toolCalls` fill in as the response body is read.
