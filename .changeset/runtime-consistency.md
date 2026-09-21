---
"@guren/orm": patch
"@guren/server": patch
"@guren/core": patch
---

Protect SQLite transaction isolation, reject unsupported bulk-write pagination, and honor soft deletes through query builders. Preserve concurrent cache counters, expiration deadlines, tag namespaces, rate-limit admission, and once-listener execution. Apply scheduler timezones, validate cron fields, find leap-day occurrences, and encode storage URL paths. Serialize single-attachment replacements within a process and support a shared collection lock across processes.

Custom tagged cache stores must implement atomic `add()`. Bulk writes with limit, offset, or ordering now throw rather than silently ignoring those options.
