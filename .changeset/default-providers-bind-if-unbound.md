---
'@guren/server': minor
---

Add `Container.singletonIf(key, factory)`, which binds only when `key` is unbound (RFC 0027 Part 1).

**Behaviour change:** framework default providers no longer replace a binding that already exists. `CacheServiceProvider`, `MailServiceProvider`, `QueueServiceProvider`, `StorageServiceProvider`, `OAuthServiceProvider`, `BroadcastServiceProvider`, `NotificationServiceProvider`, `HealthServiceProvider`, `SchedulingServiceProvider`, `EventServiceProvider`, `LogServiceProvider`, `AuthorizationServiceProvider`, `ErrorServiceProvider`, `I18nServiceProvider` and `EncryptionServiceProvider`'s `encrypter` now bind through it. An app that listed its own provider for one of these subsystems *before* the framework default used to end up with the default's empty manager; it now keeps its own. Apps that list the default first see no difference.
