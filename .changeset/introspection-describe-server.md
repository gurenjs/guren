---
'@guren/server': minor
---

The introspection manifest (RFC 0026) gains the `session`, `auth`, `cache`, `storage`, `queue` and `attachments` sections, read through new read-only `describe()` methods on `SessionManager`, `CacheManager`, `StorageManager`, `QueueManager` and `AuthManager` that build no store and call no factory. A section a deferred or throwing provider may supply is reported as unverified rather than absent. The `auth` section names each hasher's `algorithm` and whether it `requiresBun`, read by exact class, since scrypt and Argon2id share the `DefaultHasher` class. Middleware entries carry the `ability` their authorization check names, and `definePlugin()` accepts an `introspect` hook.
