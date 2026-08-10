---
'@guren/orm': patch
---

Stop concurrent callers from opening a second SQLite handle

`createSqliteDatabase()` was the one driver still memoizing its connection by
hand, and the check ran five awaits before the memo was written — so two callers
arriving together both opened a client, ran `PRAGMA journal_mode = WAL` on it,
and the second overwrote the first. `closeDatabase()` only ever closes the
client it can still see, leaving the first one open for the life of the process.
The connection now shares the `singleFlight()` helper the other four drivers
already use, so one attempt serves every caller that races it.
