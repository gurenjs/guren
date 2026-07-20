# RFC: First-class Plugin System

**Author:** Urata Daiki
**Date:** 2026-07-20
**Status:** Accepted

## Problem

Guren already has the runtime foundation of a plugin system: `ServiceProvider`
(register/boot lifecycle, deferred providers), `createApp({ providers })`,
`@guren/plugin-vercel` as the first official plugin, a plugin authoring guide
(`docs/*/guides/plugins.md`), a plugin contract (`contributing/plugin-contract.md`),
test helpers (`createPluginTestApp`, `assertPluginRegisters`), and a
`guren plugin <pkg>` CLI command that patches `src/app.ts`.

However, several promises in the documentation are not backed by code, and the
tooling around the contract is incomplete:

1. **`gurenPlugin.compatibility` is never read.** The contract says "the
   framework may read this field at boot time to warn about incompatible
   plugins", but no code anywhere reads the `gurenPlugin` field. Users get no
   warning when installing a plugin built for an incompatible Guren version.
2. **"Plugins can add CLI commands" has no mechanism.** The contract lists
   "Add CLI commands by registering them through the container" under what
   plugins CAN do, but `packages/cli/src/bin.ts` is a static citty command tree
   with no extension point. The claim is currently false.
3. **The documented configuration pattern is unsafe.** The authoring guide's
   "cleaner ESM-only approach" mutates a static `config` property on the shared
   provider class. Two `defineAnalyticsPlugin()` calls with different configs
   silently share the last config. There is no framework-provided helper, so
   every plugin author hand-rolls this (and can get it wrong the same way).
4. **`guren plugin` is minimal and partially hardcoded.** It patches
   `src/app.ts` but does not install the dependency (prints "Run: bun add ..."),
   does not check compatibility, and the extra scaffolding for official plugins
   is hardcoded per package (`plugin-vercel.ts`). Community plugins cannot ship
   config stubs, env keys, or migrations that install cleanly.

## Proposed Solution

Three deliverables, shippable as three independent PRs. All are additive
(minor-release safe).

### Part A: `definePlugin()` helper

A framework-provided factory in `@guren/server` (auto-exported via
`@guren/core`) that replaces the hand-rolled configured-provider pattern:

```typescript
// packages/server/src/container/definePlugin.ts
import { ServiceProvider } from './ServiceProvider'
import type { Container } from './Container'
import type { ServiceProviderConstructor } from '../http/Application'

export interface PluginDefinition<TConfig = void> {
  /** Diagnostic name, e.g. 'analytics'. Used in error messages and doctor output. */
  name: string
  register(container: Container, config: TConfig): void | Promise<void>
  boot?(container: Container, config: TConfig): void | Promise<void>
  /** Maps to ServiceProvider.deferred / .provides */
  deferred?: boolean
  provides?: string[]
}

export function definePlugin<TConfig = void>(
  definition: PluginDefinition<TConfig>,
): (config: TConfig) => ServiceProviderConstructor
```

The returned factory captures `config` in a closure and produces a fresh
`ServiceProvider` subclass per call — no shared static state:

```typescript
// Plugin side
export const analyticsPlugin = definePlugin<AnalyticsConfig>({
  name: 'analytics',
  register(container, config) {
    container.singleton('analytics', () => new AnalyticsClient(config))
  },
  boot(container) {
    const events = container.make('events')
    events.on('request.completed', (data) =>
      container.make<AnalyticsClient>('analytics').track('page_view', data))
  },
})

// App side
createApp({
  providers: [analyticsPlugin({ apiKey: process.env.ANALYTICS_API_KEY! })],
})
```

Class-based `ServiceProvider` plugins remain fully supported; `definePlugin`
is sugar, not a new contract. The authoring guide's static-mutation example is
replaced with this helper, and the contract's "Optional: definePlugin()"
section now points at the framework helper instead of a per-plugin recipe.

**Middleware/container rule (documented, not new API):** plugins that add
middleware must capture the services they need in a closure during `boot()`.
The Hono context does not carry the container, and this RFC does not change
that.

### Part B: `guren plugin` and the `gurenPlugin` manifest

#### Manifest schema (declarative only)

Extend the existing `gurenPlugin` package.json field:

```jsonc
{
  "gurenPlugin": {
    // Existing, now actually enforced
    "compatibility": ">=1.0.0",
    // Named export to register in createApp({ providers }).
    // Optional. ~~Falls back to the current name heuristic~~ **Amended in
    // implementation:** the name heuristic only applies to packages with
    // NO gurenPlugin manifest at all. When a manifest exists but omits
    // `provider` (e.g. a definePlugin()-only or commands-only plugin),
    // guessing a name would write an import that doesn't exist -- the CLI
    // skips automatic registration and prints a reminder to register
    // manually instead.
    "provider": "AnalyticsServiceProvider",
    // Keys appended to .env.example (and .env if present) when missing
    "env": [
      { "key": "ANALYTICS_API_KEY", "value": "", "comment": "Analytics API key" }
    ],
    // Files copied from the package into the app (skip if target exists,
    // unless --force)
    "publishes": [
      { "from": "stubs/config.ts", "to": "config/analytics.ts" }
    ],
    // Part C (CLI commands), see below
    "commands": { "entry": "./dist/commands.js", "names": ["analytics:flush"] }
  }
}
```

Security constraints, aligned with Guren's secure-by-default stance:

- `guren plugin` **never imports or executes plugin code**. The manifest is pure
  JSON data; there is no Adonis-style executable `configure` script.
- `publishes.to` is restricted to an allowlist of app directories
  (`config/`, `db/migrations/`, `resources/`); paths are normalized and
  path-traversal (`..`, absolute paths, symlink escapes) is rejected on both
  `from` and `to`.
- Existing files are never overwritten without `--force`.

#### Command behavior

> **Amendment (implementation):** `guren add` already exists as the blueprint
> namespace (`guren add auth`, `guren add plugin <pkg>`, ...), so the bare
> `guren add <pkg>` form proposed here would collide with blueprint names.
> The implemented primary name is `guren plugin <pkg>` (top-level, previously
> documented but unwired), with `guren add plugin <pkg>` unchanged.

`guren plugin <pkg>`:

1. If `<pkg>` is not in the app's dependencies, run `bun add <pkg>`
   (`--no-install` opts out and prints the command instead).
2. Read `node_modules/<pkg>/package.json` → `gurenPlugin` manifest.
3. Check `compatibility` against the installed `@guren/core` version using
   `Bun.semver.satisfies` (no new dependency; the CLI is Bun-only). Warn and
   require `--ignore-compatibility` to proceed on mismatch (`--force` stays
   scoped to file overwrites).
4. Patch `src/app.ts` via the existing `addImport`/`addProvider` helpers,
   using `gurenPlugin.provider` when present.
5. Apply `publishes` and `env` entries.
6. Print a summary of every file touched and remaining manual steps.

`@guren/plugin-vercel`'s hardcoded installer (`cli/src/plugin-vercel.ts`)
migrates to this manifest; the hardcoded path is kept for one minor release,
then deleted.

`guren doctor` gains a check: for every direct dependency with a `gurenPlugin`
field, verify `compatibility` against the installed core version and flag
mismatches. This makes the contract's "the framework may warn about
incompatible plugins" true — at install time and diagnosis time, with zero
boot-time cost.

### Part C: CLI command extension point

Plugins declare commands statically in the manifest (`commands.names`) and
implement them in a module (`commands.entry`) that default-exports a record of
citty commands:

```typescript
// plugin: src/commands.ts
import { defineCommand } from 'citty'

export default {
  'analytics:flush': defineCommand({
    meta: { name: 'analytics:flush', description: 'Flush queued events' },
    async run() { /* ... */ },
  }),
}
```

Resolution in `bin.ts`:

- Discovery reads the **app's** package.json direct dependencies (and
  devDependencies), then reads each dependency's package.json looking for
  `gurenPlugin.commands`. This is a handful of `readFile` calls at CLI
  startup; no plugin code runs.
- `guren --help` lists plugin command names from `commands.names` without
  importing anything.
- Invoking a plugin command dynamically imports `commands.entry` and runs the
  matching command. Executing plugin code here requires the same trust the
  user already extended by installing the package and registering its
  provider — and only happens on explicit invocation.
- Plugin command names **must** contain a `:` namespace; un-namespaced names
  are rejected at discovery with a warning.
- Conflicts: built-in commands always win. ~~Two plugins declaring the same
  name is an error naming both packages.~~ **Amended in implementation:** a
  name declared by multiple plugins is dropped for all of them, with one
  warning naming every declaring package — a hard error would brick every
  `guren` invocation (including `--help`) over a conflict between two
  third-party packages.

## Alternatives Considered

- **Laravel-style auto-discovery** (register providers automatically from
  node_modules): rejected. Code executing because a package landed in
  node_modules contradicts Guren's opt-in security posture (`GUREN_MCP=1`,
  `GUREN_TESTING`, explicit provider lists). Explicit registration stays;
  `guren plugin` automates the writing, not the deciding.
- **Adonis-style executable configure script** (`node ace add` runs the
  package's `configure.ts`): rejected in favor of the declarative manifest.
  Arbitrary install-time code execution is a supply-chain foothold; the
  manifest covers the common cases (provider, config stub, env, migrations)
  without it. If a plugin genuinely needs imperative setup, it documents
  manual steps.
- **Boot-time compatibility checking**: rejected. It taxes every cold start
  (relevant for Lambda/Vercel) to catch a problem that is knowable at install
  time. `guren plugin` + `guren doctor` cover it.
- **Container-registered CLI commands** (what the contract currently claims):
  rejected. It would require booting the full application to enumerate
  commands, making `--help` slow and coupling the CLI to app boot success.
  The static manifest keeps listing free and execution lazy.

## Migration Path

No breaking changes.

- `definePlugin` is additive; existing class-based plugins keep working.
- `guren plugin <pkg>` is the primary top-level form (see the Part B
  amendment); `guren add plugin <pkg>` remains available unchanged.
- Plugins without a `gurenPlugin` manifest still install via the name
  heuristic exactly as today; the manifest only unlocks the extra steps.
- Docs changes: replace the static-config pattern in the authoring guide
  (en/ja), update the contract's CLI-commands claim to describe the real
  mechanism, and change "may read this field at boot" to "checked by
  `guren plugin` and `guren doctor`".

## Implementation Order

1. **PR 1 (server, docs):** `definePlugin` + tests + guide/contract updates.
2. **PR 2 (cli):** `guren plugin` (manifest, compat check, publishes/env,
   `bun add`), doctor check, plugin-vercel manifest migration.
3. **PR 3 (cli):** command extension point + `make:*` template for plugin
   commands modules.

## Open Questions

- Should `publishes` support a `migrations` shorthand that timestamps files
  into `db/migrations/` on copy (so repeated `guren plugin` runs don't duplicate
  them), or is plain file copy with skip-if-exists enough for v1?
- ~~Should the install command run `bun add` by default, or print the
  command and require `--install`?~~ **Resolved:** implemented as
  install-by-default with `--no-install`. The compatibility gate got its own
  escape hatch, `--ignore-compatibility`, so `--force` stays scoped to file
  overwrites.
- Do we want a `guren remove <pkg>` inverse (unregister provider, leave
  published files)? Deferred unless demand appears.
