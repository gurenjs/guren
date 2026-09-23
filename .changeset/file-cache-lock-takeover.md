---
'@guren/server': patch
---

The file cache store takes over a counter lock only once one writer has held it for five seconds, and a writer whose lock was taken over no longer releases the lock of the writer that took it. A waiter used to take over whatever lock it found once it had itself waited five seconds, so a waiter queued behind many short `increment()` or `add()` calls on one key removed a lock another writer had just acquired, and that writer's update could be lost: 6000 concurrent increments on one key across two store instances kept 3323. The cache guide described the wrong behaviour too, saying a wait longer than five seconds throws; it now says the lock is taken over, and that a writer still running after five seconds (a suspended process, a stalled disk) then overlaps the one that took its lock, so one of their updates can be lost.

`increment()` and `add()` also no longer reject when a concurrent `clear()` removed the directory they were waiting in, or when removing the lock fails after the update was written.

While a deploy runs this release beside the previous one, the two do not reliably exclude each other on a key: either can take over a lock the other has just acquired, and a previous-release process can reject `increment()` or `add()` with `ENOTEMPTY`.
