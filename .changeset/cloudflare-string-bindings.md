---
'@guren/orm': minor
'@guren/plugin-cloudflare': minor
'@guren/server': minor
---

`createD1Database({ binding: 'DB' })` and `new R2Driver({ binding: 'MEDIA' })` take the binding's name (RFC 0035 §2.1). The name is read from the Workers env the first request captured, at the first query or storage operation. A D1 factory given a name reports it from `describe()`, so `guren introspect --json` shows which binding the database uses. `StorageManager.registerDisk(name, factory, { driver, binding })` records what a factory builds, and a configured disk's string `binding` is recorded too. `describe()` reports both without building the disk. The closure form keeps working. `@guren/plugin-cloudflare/env` keeps the captured env under `Symbol.for('guren.workersEnv')` on `globalThis`, which is how `@guren/orm` reads it without importing the plugin.
