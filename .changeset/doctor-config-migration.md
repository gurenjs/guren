---
'@guren/cli': minor
---

`guren doctor --next` points an app that configures services in providers at the config definitions that replace them (RFC 0027).

It detects:

- a `CacheProvider`, `MailProvider`, `QueueProvider` or `StorageProvider` that builds its manager from an object literal;
- a `SessionConfig`-typed `config/session.ts`, with the provider that binds it;
- `config/app.ts`'s `bootModels()`.

For each, the next step names the `config/<service>.ts` to write and prints it. The provider's values carry over: `process.env.CACHE_STORE || 'memory'` becomes `env.CACHE_STORE`, declared as `Env.string().default('memory')`. A separate step lists the variables `config/env.ts` does not declare yet, or the whole file when the app has none.

Next steps gain an optional `content` field holding the file. `--json` and the dev MCP `guren_doctor` tool include it. An app already on definitions gets no migration step.
