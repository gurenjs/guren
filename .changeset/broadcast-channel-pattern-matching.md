---
'@guren/server': patch
---

A broadcast channel pattern such as `chat.{room}.{user}` or `chat\.{room}.{user}` now matches a channel name in linear time, so a long name a client sends no longer stalls `authorize()`. A pattern that uses other regular expression syntax (a group, a class, an alternation) is still matched with a regular expression.
