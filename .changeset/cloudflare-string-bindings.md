---
'@guren/orm': minor
'@guren/plugin-cloudflare': minor
'@guren/server': minor
---

`createD1Database({ binding: 'DB' })` and `new R2Driver({ binding: 'MEDIA' })` take the binding's name (RFC 0035 §2.1). The name is read from the Workers env the first request captured, at the first query or storage operation. A D1 factory given a name reports it from `describe()`, so the introspected app names the binding the database uses. `StorageManager.registerDisk(name, factory, { driver, binding })` records what a factory builds, and `describe()` reports it without building the disk. `r2Disk(options)` from `@guren/plugin-cloudflare` returns both arguments from one options object. An empty binding name is refused when the factory or driver is created. The closure form keeps working. `@guren/plugin-cloudflare/env` keeps the captured env under `Symbol.for('guren.workersEnv')` on `globalThis`, which is how `@guren/orm` reads it without importing the plugin.
