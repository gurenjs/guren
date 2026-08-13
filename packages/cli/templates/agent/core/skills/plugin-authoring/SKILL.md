---
name: plugin-authoring
description: Install or author Guren plugins — npm packages that extend a Guren app via the ServiceProvider system. Use when the user asks to "install a plugin", "add @guren/plugin-*", "create a plugin", "build a Guren plugin", "make:plugin", or wants a reusable package that registers services, middleware, or CLI commands into a Guren app.
---

# Guren Plugin Authoring Skill

You help with two distinct tasks: **installing** an existing plugin into this app, and **authoring** a new plugin package. Figure out which one the user wants before acting — they are different workflows.

> Full reference: `docs/en/guides/plugins.md` (or `docs/ja/guides/plugins.md`) and `contributing/plugin-contract.md` in the Guren framework repo. This skill is a condensed, task-oriented version for AI agents.

## Installing an Existing Plugin

Official (`@guren/plugin-*`) or community (`guren-plugin-*`) plugins install with one command, run from the app root:

```bash
bunx guren plugin <package-name>
```

This installs the dependency (`bun add`, unless `--no-install`), verifies the plugin's declared `gurenPlugin.compatibility` against the installed `@guren/core` (throws unless `--ignore-compatibility`), registers the provider import in `createApp({ providers })` inside `src/app.ts`, and applies any `env`/`publishes` entries the plugin declares. `--force` overwrites already-published files.

**Do not hand-edit `src/app.ts` to add a plugin provider — always run the command.** It's idempotent (safe to re-run) and keeps the import/registration correctly formatted.

If the plugin's manifest omits `provider` (common for `definePlugin()`-based plugins, which need configuration), the command will NOT auto-register it — it prints a reminder instead. In that case, add the import and call manually:

```typescript
// src/app.ts
import { somePlugin } from 'guren-plugin-something'

export const app = createApp({
  providers: [somePlugin({ apiKey: process.env.SOME_API_KEY! })],
})
```

## Authoring a New Plugin

A Guren plugin is a **separate npm package** — scaffold it outside the current app directory (a sibling directory, not `app/` or `src/`).

### 1. Package setup

```bash
mkdir guren-plugin-<name> && cd guren-plugin-<name> && bun init
```

```json
{
  "name": "guren-plugin-<name>",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "gurenPlugin": { "compatibility": ">=1.0.0" },
  "peerDependencies": { "@guren/core": ">=1.0.0" },
  "devDependencies": {
    "@guren/core": "^1.0.0",
    "@guren/testing": "^1.0.0",
    "typescript": "^5.0.0",
    "tsup": "^8.0.0"
  }
}
```

`@guren/core` is a **peer dependency** (the host app provides it), and also a **dev dependency** (for building/testing this package in isolation).

### 2. Define the plugin with `definePlugin()`

This is the recommended path for any plugin that needs configuration. Each factory call produces an independent provider — never store config on a static class property (it would leak across registrations):

```typescript
// src/plugin.ts
import { definePlugin } from '@guren/core'

export interface MyConfig {
  apiKey: string
}

export const myPlugin = definePlugin<MyConfig>({
  name: 'my-plugin',
  register(container, config) {
    container.singleton('my-service', () => new MyClient(config))
  },
  boot(container) {
    // optional: runs after all providers have registered
  },
  // optional: defer instantiation until 'my-service' is first resolved
  // deferred: true,
  // provides: ['my-service'],
})
```

For plugins needing no configuration or full class-based lifecycle control, export a `ServiceProvider` subclass directly instead — that contract is unchanged. **What plugins may touch:** the DI container (`this.container` / the `container` passed to `definePlugin`) and, from `boot()`, the shared Hono instance via `container.make('hono')` for middleware. Never reach into framework internals via deep imports (e.g. `@guren/server/src/http/Application`) — only import from public package entry points.

Export it: `export { myPlugin } from './plugin'`.

### 3. The `gurenPlugin` manifest (package.json)

Every field is optional except the parent key itself:

| Field | Purpose |
|-------|---------|
| `compatibility` | Semver range of Guren versions this plugin supports (e.g. `">=1.0.0 <2.0.0"` — always bound the upper end to the major you've actually tested, don't leave it open-ended). Checked by `bunx guren plugin` at install time and by `bunx guren doctor`. |
| `provider` | Named **class** export for `bunx guren plugin` to auto-register. Omit for `definePlugin()` factories — those need configuration, so they're always registered manually. |
| `env` | Array of `{ key, value?, comment? }` — appended to the installing app's `.env.example` (and `.env` if present). |
| `publishes` | Array of `{ from, to }` — files copied from this package into the app at install time. `to` must resolve inside `config/`, `db/migrations/`, or `resources/`; existing files are never overwritten without `--force`. |
| `commands` | `{ entry, names }` — CLI commands this plugin contributes (see below). |

The manifest is pure data — installers never execute plugin code from it.

### 4. Optional: contribute a `guren` CLI command

```json
{ "gurenPlugin": { "commands": { "entry": "./dist/commands.js", "names": ["my-plugin:sync"] } } }
```

```typescript
// src/commands.ts
import { defineCommand } from 'citty'

export default {
  'my-plugin:sync': defineCommand({
    meta: { name: 'my-plugin:sync', description: 'Sync something' },
    async run() { /* ... */ },
  }),
}
```

Command names **must** contain a `:` namespace. Built-in `guren` commands always win a name collision; a name declared by two installed plugins is dropped for both with a warning. The entry module is imported lazily (only when the command runs or renders its own `--help`) — never for the root `guren --help` listing.

### 5. Test with `@guren/testing`

```typescript
import { describe, test, expect } from 'bun:test'
import { createPluginTestApp, assertPluginRegisters } from '@guren/testing'
import { myPlugin } from './plugin'

test('registers the service', async () => {
  const app = await createPluginTestApp([myPlugin({ apiKey: 'test' })])
  assertPluginRegisters(app, ['my-service'])
})
```

### 6. Test locally before publishing

```bash
# from the app you're testing against
bun add file:../guren-plugin-<name>
bunx guren plugin guren-plugin-<name>
```

`bun add file:` (and `link:`/`workspace:`) symlink back to the plugin's source instead of copying it. If the plugin still has its own `node_modules` (from its `@guren/core` devDependency in step 1), the app can load two separate `@guren/core` copies — surfacing as duplicate-module runtime warnings or a `Property 'bindings' is protected...` TypeScript error. Fix: delete `node_modules` inside the plugin package directory before linking it — the app's own `@guren/core` then satisfies the plugin's `peerDependencies` with nothing left to shadow it. Published plugins never ship `node_modules`, so this is a local-testing-only gotcha.

### 7. Build and publish

```json
{ "scripts": { "build": "tsup src/index.ts --format esm --dts" } }
```

```bash
bun run build && npm publish
```

## Naming Convention

Official (framework-team) plugins: `@guren/plugin-{name}`. Community plugins: `guren-plugin-{name}`. Class-based provider names follow `{Name}ServiceProvider`; `definePlugin()` factory exports follow `{name}Plugin`.
