---
'@guren/server': minor
'@guren/core': minor
'@guren/testing': minor
'@guren/plugin-cloudflare': minor
---

Declare the environment once and validate it at boot (RFC 0027 Part 0). `defineEnv({ APP_KEY: Env.string().secret(), SMTP_PORT: Env.port().default(587) })` builds a schema from `Env.string`, `url`, `number`, `port`, `boolean`, `enum` and `custom` (a synchronous Standard Schema), each with `.optional()`, `.default()`, `.allowEmpty()`, `.secret()`, `.describe()` and `.requiredInProduction()`. A blank `FOO=` counts as unset, so `.default()` applies to it, and numbers, ports and booleans are coerced by the builder.

`createApp({ env })` validates the schema at the start of `boot()`, before any provider registers, and binds the result as `env`. A failure throws one `EnvValidationError` listing every problem, with secret values redacted; under `GUREN_INTROSPECT=1` the problems are logged instead. Values are read from the `env.source` binding first and `process.env` second: `@guren/plugin-cloudflare` binds the entrypoint's env there before boot, since wrangler `vars` are not guaranteed to reach `process.env`, and `TestApp.create({ env, envSource })` binds a test's overrides. `env.parse(source, { mode })` runs the same validation outside an application. `NODE_ENV` and `GUREN_*` cannot be declared (`isRawEnvKey()`), because production gates only fold at bundle time as the literal `process.env.NODE_ENV` read.

`createApp({ inertia: { share } })` registers shared Inertia props scoped to that application's container.
