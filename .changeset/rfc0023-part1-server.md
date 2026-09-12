---
"@guren/server": minor
---

Consumers read their container first and the process-wide slot second (RFC 0023 Part 1)

- `Controller.authorize()` / `can()` and the authorization middleware use the
  gate of the app serving the request; two `Application`s booted in one
  process each authorize by their own policies.
- `getGate()`, `getEncrypter()`, `encrypt()` / `decrypt()`, `getI18n()`,
  `t()` / `tc()`, `getLogManager()`, `getNotificationManager()`,
  `getBroadcastManager()` and `getExceptionHandler()` resolve from the default
  application's container, then from what the matching `set*()` installed.
  `encrypt()` and `t()` therefore work in every app that registers the
  provider without any `set*()` call.
- `AuthorizationServiceProvider`, `EncryptionServiceProvider`,
  `LogServiceProvider`, `NotificationServiceProvider` and
  `BroadcastServiceProvider` no longer publish a global.
- `Job.make()` reads the worker's container, and the new `Job.makeOptional()`
  reads it without throwing. A `setQueueDriver()` pin still overrides the
  bound `queue` manager, for `Job.dispatch()` and `mail(manager).queue()` alike.
- `resolve(key)` resolves through the default application rather than the raw
  ambient slot, so it reports an ambiguous default like every other ambient
  helper. `getMailManager()` reads the default application's `mail` binding
  before the manager `setMailManager()` installed.
- Prototype routes (RFC 0021) render with their app's container, so
  `createApp({ inertia })` document defaults reach a fixture-backed page.
- `resolveOptional(container, key)` is exported: the one rule for reading a
  binding that may be absent, preferring `makeOptional` so a fake and a
  deferred provider are found rather than skipped.
- `SendMailJob` and `SendNotificationJob` resolve `mail` / `notifications`
  from the worker's container. `createMailManager(config, container)` records
  the container a manager is bound in, and `mail(manager).queue()` dispatches
  through that container's `queue`; `MailServiceProvider` passes its own.
- `detectLocaleMiddleware` defaults `i18n` to the serving app's binding.
- `tryGetRequestContainer()` judges the stamp by shape, so a test double
  answering every context key does not pass as a container.
- `ContainerLike` is exported.
