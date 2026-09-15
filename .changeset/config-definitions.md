---
'@guren/server': minor
'@guren/core': minor
---

Configuration as data (RFC 0027 Part 1). `createApp({ config: [...] })` takes the definitions `config/*.ts` export: each resolves its config from the validated `env` and binds the manager that config builds, inside `ConfigServiceProvider`, before any other provider registers. Its `boot` runs before any other provider boots. `defineConfig()` is the general form; `defineCacheConfig`, `defineHttpConfig`, `defineMailConfig`, `defineOAuthConfig`, `defineQueueConfig` and `defineStorageConfig` come from `@guren/server`, and `defineSessionConfig` from `@guren/core`, since only core's session manager knows the `database` driver.

```ts
// config/session.ts
export default defineSessionConfig((env) => ({
  default: env.SESSION_DRIVER,
  stores: { database: { driver: 'database', table: sessions }, cookie: { driver: 'cookie' } },
}))
```

Two definitions with one key fail the boot, and so does a provider that rebinds a key a definition bound: `"session" is configured twice: config/session.ts and SessionProvider.register(). Keep one.` `Container.bindingOf(key)` exposes the binding record that check compares.

`defineHttpConfig((env) => ({ hostAuthorization }))` moves host authorization into config, where it can read `APP_URL`. The middleware keeps its place ahead of every app middleware; a request that arrives before `boot()` gets a 503, and passing `createApp({ hostAuthorization })` as well fails the boot.
