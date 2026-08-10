---
'@guren/server': patch
'@guren/core': patch
---

Degrade a corrupt ability list to no abilities instead of every ability

`DatabaseApiTokenStore` decoded `abilities` with
`decodeJsonColumn<string[]>(value, [])`, which returns whatever the JSON
decodes to. A stored `'"*"'` decodes to the *string* `"*"`, and `tokenCan` then
runs `String.prototype.includes` on it, so `"*".includes("*")` is true and the
token is granted every ability — the exact opposite of the deny-by-default the
file's own comment claimed. `RedisApiTokenStore` had the same collapse, and its
`JSON.parse` was unguarded besides, so one corrupt record threw on every
verification of that token rather than degrading.

Both stores now require an array and keep only its string members. A value that
is not a list of strings yields no abilities.
