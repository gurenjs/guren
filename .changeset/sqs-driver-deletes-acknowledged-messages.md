---
'@guren/server': patch
---

Delete acknowledged SQS messages instead of only dropping the receipt handle.

`SqsDriver.delete()` and `fail()` now send `DeleteMessage`, so a job a worker
finished or gave up on no longer reappears when the queue's visibility timeout
expires. `SqsAdapter` gains an optional `deleteMessage()` — `createSqsAdapter()`
implements it, and an adapter without it warns once and keeps its previous
behaviour.
