---
"@guren/server": patch
---

Fail a login attempt loudly when no user provider is registered

An app created with `auth` but no `users` provider (no `auth.useModel(User)`,
no `registerProvider('users', ...)`) used to answer every `attempt()` with
`false`: the default guard fell back to a provider that returned `null` for
every lookup and `false` for every credential check, so a misconfigured app
looked like one where every password was wrong. The fallback provider now
throws from `retrieveByCredentials()` and `validateCredentials()`, naming
`auth.useModel(User)` as the fix; `retrieveById()` still answers `null`, so an
anonymous request on such an app stays a 401 or a redirect rather than a 500.

The app also warns at boot when `createApp()` received `auth`, every provider
has booted, and the default guard still has no `users` provider behind it.

`AuthManager` gains `hasProvider(name)`. The default `web` guard is registered
by the `Application` constructor alone; `AuthServiceProvider` no longer carries
a second registration that could never run.
