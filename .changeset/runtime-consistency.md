---
"@guren/orm": patch
"@guren/server": patch
"@guren/core": patch
---

Protect SQLite transaction isolation, reject unsupported bulk-write pagination, and honor soft deletes through query builders. Preserve concurrent cache counters, expiration deadlines, tag namespaces, rate-limit admission, and once-listener execution. Apply scheduler timezones, validate cron fields, find leap-day occurrences, and encode storage URL paths. Serialize single-attachment replacements within a process and support a shared collection lock across processes.

Tagged caches create tag namespaces with the store's atomic `add()` when it has one; a custom store without it keeps the previous non-atomic behavior. The file store locks only its read-modify-write operations (`add()`, `increment()`, `decrement()`), and takes over a lock still held after five seconds, so a crashed process no longer leaves a key unusable. Bulk writes with limit, offset, or ordering now throw rather than silently ignoring those options.
