---
'@guren/server': patch
---

The file cache store no longer loses a write that lands while another caller reads an expired entry. `get()`, `has()` and `ttl()` used to delete an expired file after reading it, which could remove a counter `increment()` had just written or let two `add()` calls on an expired key both succeed. Reads now leave expired files in place, and `cleanup()` removes them under the key's lock after moving each file aside and re-checking it, so an entry `set()` replaced in the meantime is kept. Call `cleanup()` periodically to reclaim disk space.
