---
'@guren/server': patch
---

A broadcast channel pattern such as `chat.{room}.{user}` now matches a channel name in linear time, so a long name a client sends no longer stalls `authorize()`.
