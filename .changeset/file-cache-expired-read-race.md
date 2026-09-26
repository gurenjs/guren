---
'@guren/server': patch
---

The file cache store no longer loses a write that lands while another caller reads an expired entry. `get()`, `has()` and `ttl()` used to delete an expired file after reading it, which could remove a counter `increment()` had just written or let two `add()` calls on an expired key both succeed. Reads now leave expired files on disk until `cleanup()` runs, and nothing in the framework calls it for you: schedule it to reclaim disk space. `cleanup()` removes each expired file under the key's lock after moving it aside and checking it again, and puts back an entry `set()` replaced in the meantime. `delete()` now takes the same lock, so it cannot be undone by that restore.
