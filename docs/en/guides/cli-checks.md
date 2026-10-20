# Checks and Audits in Depth

The [CLI Reference](./cli.md#inspection-audit-commands) lists `check`, `audit`, `gate`, `introspect` and `doctor`. This page holds the rules behind them: what the audit's policy rule looks for, how to suppress an audit finding, what `introspect` runs, the extra rules for agent routes and in-process agents, architecture boundaries, and which facts the checks read from the registered (but never booted) app.

## The audit's policy rule

The policy rule of `audit` only ever warns. Once the app keeps a policy
for a model (`app/Policies/<Model>Policy.ts`, what `make:policy` writes,
paired within one app root), every controller action on a non-safe method
whose body names that model gets a `policy:<METHOD> <path>` finding, and so
does a GET route to an `edit` action, which shows a record's edit form (one
whose only literal check is a read ability such as `view` warns too). It
passes when the action calls `this.authorize()` or `this.can()`, consults
the gate, references the policy class, or sits behind
`authorize()`/`authorizeResource()` middleware. It warns, naming the action,
the policy and the fix, when nothing the scan can see consults the policy,
and it warns rather than passes when the controller source is not among
those the audit reads. A helper the action calls is not followed, so put
`// guren-audit-ignore` in a comment above an action whose check lives
elsewhere: the finding is then reported as ignored, with that comment as its
reason. An app with no policy gets no such finding.

A related model rule, `owner-fillable:<Model>`, warns when a model lists in
`fillable` a column that references the users table (the table of a model
built on `AuthenticatableModel`), such as `authorId`: a request could then
choose the record's owner. Keep the column out of `fillable` and set it on
the server with `create(data, { set: { authorId: user.id } })`. A column
the user picks on purpose (an assignee) is a deliberate exception: record it
in `config/audit.ts`. An edit form is recognized by its action name, `edit`.

## Suppressing audit findings

When an `audit` finding is a false positive, suppress it with one of two mechanisms. Which one applies depends on whether the finding has a source line (`policy:*` accepts both).

For a finding with a source line, place `// guren-audit-ignore` on the flagged line or the line above it:

```ts
// guren-audit-ignore -- documented example value
const apiKey = 'example-not-a-real-key'
```

Route- and model-level findings (`authz:*`, `policy:*`, `validation:*`, `agent-annotation:*`, `mass-assignment:*`, `owner-fillable:*`, `hidden-columns:*`) have no single line to attach a comment to: they come from executing your route registrar and inspecting your models. Ignore those with `config/audit.ts` instead (`policy:*` also honours the marker in a comment above the action, since the action is where its fix goes), keyed by the finding's `key` (copy it straight from `--json` output) and a required `reason`. `force-write-request-data:*` and `set-spread:*` name a controller method but carry no line either, so they are ignored the same way:

```ts
// config/audit.ts
export default {
  ignore: [
    { key: 'authz:POST /webhooks/stripe', reason: 'HMAC signature verified in the controller' },
  ],
}
```

Ignored findings stay in the report with `status: "ignored"` and an `ignoreReason`. Nothing is silently dropped. An entry with a missing `key`/`reason`, or one that never matches a finding, produces its own warning so stale rules don't rot unnoticed.

`config/audit.ts` only accepts findings that have no source line, the route- and model-level ones above. Line-scoped findings (hardcoded secrets, raw SQL, disabled security toggles) already have `// guren-audit-ignore` for that; an entry targeting one is rejected with a warning pointing you back to the inline comment, rather than becoming a second, less visible way to silence them.

## Introspecting the registered app

`guren introspect` answers from the application itself rather than from its
source text. It starts a child process with `GUREN_INTROSPECT=1`, imports
`src/main.ts`, registers every provider and every route, and stops there.
Routes are not mounted, and provider `boot()` methods, the `createApp({ boot })`
callback and `listen()` never run, so no port is bound and the scaffold's
`defineDatabaseConfig()` definition, which connects in its `boot`, does not
connect. Code that connects at module scope or in `register()` still runs. The
child loads `.env` from the app root, as `guren dev` does, and a variable set in
your shell wins over it. With `--app`, the current directory's `.env` files are
loaded into the CLI as well and reach the child the same way, so they also win
over the app's.

```bash
bunx guren introspect                 # providers, routes, services and warnings as tables
bunx guren introspect --json          # the manifest, for tools
bunx guren introspect --timeout 60    # allow a slow register() up to 60 seconds (default 30)
bunx guren introspect --app ../api    # introspect another app root
```

Each provider is reported with how it registered: `ran`, `introspect-hook`
(it defines `introspect()`, which runs in place of `register()`), `threw` (the
message is kept and the other providers still register), or `skipped` for a
deferred provider. A provider whose `register()` opens a connection or reads a
runtime binding can define `introspect()` to bind only what the manifest
describes:

```ts
import { ServiceProvider } from '@guren/core'
import Redis from 'ioredis'

export class RedisProvider extends ServiceProvider {
  register(): void {
    // Connects as soon as it is constructed.
    this.container.instance('redis', new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379'))
  }

  introspect(): void {
    // The manifest does not describe 'redis', so nothing needs binding here.
  }
}
```

`isIntrospecting()` is the same check for code outside a provider. Under the
flag `app.boot()` stops after registration and `app.listen()` throws, so an
entry that calls `listen()` while it is imported fails with a pointer to the
`bin/serve.ts` shape. On failure `--json` prints `{ "status": "failed",
"reason", "message" }` and the command exits 1. The reason is one of
`no-entry`, `import`, `timeout`, `crashed` or `old-server` (an installed
`@guren/core` from before introspection, detected before the entry is
imported).

## Agent-exposed routes

Routes that declare `.agent()` metadata (see [Routing](./routing.md)) are checked by `check` and treated more strictly by `audit`. The rules run in the normal `check` suite and are content-activated: an app with no agent routes contributes no findings, and no controller is scanned.

`check` **fails** on:

| Finding key | Rule |
|---|---|
| `agent-route-name:*` | The route declares agent metadata but has no `.name()`. The tool name is the tool's identity, so a nameless route cannot become a tool. |
| `agent-route-tool-name:*` | The tool name (`agent.toolName`, or the route name) falls outside the MCP grammar `^[A-Za-z0-9._-]{1,128}$`. A client rejects the whole tool list, not just the one tool. |
| `agent-route-reserved-name:*` | The tool name is reserved by the framework — `guren_preflight` is a meta-tool the MCP endpoint adds itself. A route claiming it is not exposed at all. |
| `agent-route-portable-name:*` | (warn, advisory) The tool name is legal MCP but falls outside `^[A-Za-z0-9_-]{1,64}$`, the grammar the Claude and OpenAI tool APIs enforce and Claude Managed Agents applies to MCP tools. Such a client skips the tool silently. Set `agent.toolName` to a portable spelling (`posts_index`). Advisory, so `check --ci` and `guren gate` do not fail on it. |
| `agent-route-duplicate:*` | Two or more routes resolve to the same tool name. |
| `agent-route-authorization:*` | A non-read-only tool whose middleware chain carries no authorization capability and whose controller action never calls `this.authorize(...)`. **Authentication is not authorization**: `this.auth.userOrFail()` or an API-token check satisfies neither, and produces its own message saying so. |

`check` **warns** on:

| Finding key | Rule |
|---|---|
| `agent-route-output:*` | The route declares neither an `output` schema nor a `resource` hint, so a tool derived from it advertises no output shape. Applies to write tools as much as read tools. |
| `agent-route-inertia:*` | The action answers with `this.inertia(...)` and declares no output shape — such a tool returns whatever the page happens to pass its component. Replaces the finding above for that route. |
| `agent-route-input:*` | A body-carrying route with no `body` schema, so the derived input schema is built from the path and query alone. On an inline handler that schema is also what validates at request time, so nothing checks the payload either. |
| `agent-route-annotation:*` | The tool is read-only but its action deletes, updates, or force-writes records — either an explicit `readOnlyHint: true` on a mutating verb, or a GET/QUERY route, which is read-only by default. Read-only is what exempts a route from the authorization rule, so it is checked against the action. |
| `agent-route-authorization:*` | The verdict could not be reached: the handler is an inline function, or the controller action is not among the sources the check reads. |
| `agent-route-controller-collision:*` | Two controller classes share a name and an agent route uses one of them, so a verdict drawn from a controller body may describe the other class. |
| `agent-route-controller-unreadable:*` | A controller file could not be read at all, so any agent route whose action lives there was checked against no body. |
| `agent-route-controller-unparsed:*` | A controller file could not be parsed, so any agent route whose action lives there was checked against no body, and a route naming one of its classes may be judged against another file declaring the same class name, with no collision reported. |
| `route-graph` | The routes file failed to load, so neither the route-contract nor the agent-route checks ran. |

`audit` adds these rules for the same routes:

- A body-validation finding that is a warning for an ordinary route becomes a **failure** when the route is agent-exposed, under the same `validation:*` key, so an existing `config/audit.ts` entry keeps applying.
- `agent-annotation:*` warns when `destructiveHint: false` is declared on an action that deletes, updates, or force-writes records, and also when that claim could not be checked because the action body was unreadable.
- `controller-unreadable:*` warns when a controller file could not be read, since every rule above saw no body for the actions it declares.
- `controller-unparsed:*` warns when a controller file was read but could not be parsed. The rules above saw no body for its actions, and a route matched to one of its classes by name alone is judged against another controller file that declares the same class name, with no `controller-name-collision:*` reported.

## In-process agents

`Agent` subclasses from `@guren/plugin-ai` get their own rules in `check`. They are content-activated too: an app with no such class contributes nothing. A class counts only when it extends the package's `Agent` (a named or namespace import) or another class that does, resolved through the file's imports rather than by the superclass's spelling. A durable agent from `@guren/plugin-agents` is never read as one, and a same-named class from elsewhere is not mistaken for an agent's parent.

`check` **fails** on:

| Finding key | Rule |
|---|---|
| `ai-agent-tool-underived:*` | A literal `appTools([...])` name that no `.agent()` route derives. `as()` throws on it. |
| `ai-agent-tool-unscoped:*` | A name the class's `static scopes` (own or inherited) does not grant, judged with the RFC 0016 grammar: `tool:<name>`, `tools:<prefix>.*`, `tools:read`, `tools:*`. A class with no `scopes` grants nothing. |
| `ai-agent-scope-malformed:*` | A `static scopes` entry outside that grammar, such as a bare `tickets_show`. It grants nothing, and `as()` throws. |
| `ai-agent-audit-duplicate` | Both `aiPlugin({ audit })` and `mcpPlugin({ audit })` configure a trail. The first tool call throws. Two approval queues are not reported: each plugin gates its own surface with its own queue. |

`check` **warns** on:

| Finding key | Rule |
|---|---|
| `ai-agent-plugin-missing` | `Agent` subclasses exist, but no source file in the project calls `aiPlugin()`. When an agent calls `appTools()`, its first `as()` throws; `queue()` and the audit trail need the plugin too. A warning because the evidence is an absence, as with an unbound session config. |
| `ai-agent-app-tools-unreadable:*` | The `appTools()` argument is not an array of string literals (a spread, a variable, a computed element). The names are unverifiable, and the check does not pass them. |
| `ai-agent-scopes-unreadable:*` | `static scopes` is not a literal array, so no name was judged against it. |
| `ai-agent-tools-unverified:*` | The route graph failed to load, so the names were not checked against the derived tools. |

`audit` lists every local tool an agent's `tools()` returns beside its `appTools()` spread, under its own heading and in `--json` as `aiLocalTools`. A local tool runs with its closure's authority: no scope, policy, approval or audit line. `ai-local-tool-write:*` warns when the tool's `execute` calls a Model write (`create`, `update`, `delete`, `save`) on a model whose table an `.agent()` route's action also uses; hand the agent that route instead. `ai-local-tools-unreadable:*` warns when `tools()` does not return an object literal the scan can list whole. Both findings point at a source line, so `// guren-audit-ignore` suppresses them.

## Architecture boundaries

Drop a `guren.arch.ts` file at your project root and `guren check` starts enforcing it, with no flag required:

```typescript
// guren.arch.ts
import { defineArchRules } from '@guren/cli/arch'

export default defineArchRules({
  layers: {
    domain: 'app/Domain/**',
    http: 'app/Http/**',
  },
  rules: [
    // Domain logic must not depend on the HTTP layer.
    { from: 'domain', disallow: ['http'] },
    // Controllers should query through Models, not the ORM directly.
    { from: 'http', disallowPackages: ['drizzle-orm'] },
  ],
})
```

Each rule's `from` and `disallow` accept either a layer name declared above or an inline glob. Add `severity: 'warn'` while rolling out a new boundary on an existing codebase, then drop it (defaulting to `'fail'`) once violations reach zero.

Rules analyse *runtime* dependencies. Type-only imports (`import type { X } from '...'`, `export type { X } from '...'`, and `import('...').X` in a type position) compile away, so they are skipped by default. Sharing a DTO or a props interface across layers is usually fine. For a boundary that should hold at the type level too, set `includeTypeImports: true` on the rule (or once on the whole set; a rule's own setting wins):

```typescript
rules: [
  // Even a type dependency on the query layer is one refactor away from a runtime one.
  { from: 'frontend', disallow: ['queries'], includeTypeImports: true },
]
```

`includeTypeImports` covers the rules you declare in `guren.arch.ts`. The zero-config module boundary rules that activate for a `modules/` directory take no options and always analyse runtime imports only.

Two flags make this practical for AI coding agents and large apps:

```bash
bunx guren check --arch      # architecture checks only, the fastest run
bunx guren check --changed   # restrict checks to files changed vs. the merge base with main
```

An import Guren can't resolve to a project file is reported as a warning, never a failure: an unresolved path shouldn't block your build.

## Destructive migrations

`guren check` judges the migrations that are not on `main` yet: those committed
on the current branch since its merge base with `main` (or `origin/main`), plus
uncommitted and untracked ones. It does this whether or not `--changed` is
passed, and it never reads a migration that is already on `main`, so a drop that
shipped long ago does not fail today's check. It reads `migration.sql` and
`snapshot.json` only; it does not import `drizzle.config.ts` or
`config/database.ts`.

| Finding key | Rule |
|---|---|
| `migrations-destructive:<file>:<line>` | (warn) A destructive statement in a migration with no `-- guren:allow-destructive` comment. It counts for `check --ci` and `guren gate`, so the Stop hook sends an agent back before it finishes with one in the tree. [Destructive migrations](database.md#destructive-migrations) lists what counts. |
| `migrations-destructive:<file>` | (pass) The migration's destructive statements are acknowledged; the message quotes the reason. |
| `migrations-destructive-unverified` | (warn, advisory) Not a git repository, so nothing was judged. |
| `migrations-destructive-no-base` | (warn, advisory) No merge base with `main`, so only uncommitted and untracked migrations were judged. |

## How the Checks Read the App

This section is for when a check's verdict surprises you. `check`, `doctor`, `audit` and `gate` read some facts from the app itself, through [`guren introspect`](#introspecting-the-registered-app), and the rest from source.

### Checks that read the introspected app

`guren check` and `guren doctor` judge the deploy-runtime verdicts from the
introspected app first: the hashers the auth manager holds, the session store
and cache store it selects, and whether a provider threw while registering.
`guren check` reads it for the session and attachments wiring too:

| Check keys | Read from the introspected app |
|------------|--------------------------------|
| `sessions-binding` | Whether a provider binds `session` in `register()`. A session config the app never reads (no binding, or `auth.sessionOptions.store` supplying the store instead) is the warning; a bound manager beside `auth.sessionOptions.store`, which the app refuses at boot, is a failure |
| `sessions-config:*` | The table each `database` store of the bound session manager holds, by its SQL name, against the tables every app root's `db/schema.ts` declares, module schemas included. A name the schema reader does not find is only an advisory warning, and only for a table the source cannot trace to a schema export: the reader sees neither the other files `drizzle.config` lists nor a `pgTableCreator()` prefix. A verdict goes to every config declaring the store, or, when none the source reads declares it, under `sessions-config:<store>` with no file |
| `attachments-model:*`, `attachments-config:*` | Whether an attachments engine was configured while the app registered, and the table it writes to, read like the session tables, with `attachments-config` as the key naming no file. When every `configureAttachments()` runs whenever its file loads (not in a function, branch or class field), no source imports that file with `import()`, no `createApp({ boot })` was skipped, and the app still configured no engine, the model fails: nothing the app loads while it registers imports that file |
| `attachments-delivery` | Whether the route the engine's `delivery` names is registered, and registered by `registerAttachmentRoutes()` |
| `attachments-route-name:*` | How many registered routes carry that route name |
| `attachments-serve-redirect:*` | The disks the engine serves by redirect, with each disk's driver from the storage manager |
| `attachments-public-disk:*` | The disk the engine writes to. The disk's `root` still comes from source |
| `route-contract-*` | Every registered route, a provider's or a plugin's included. A params schema's keys come from its JSON Schema (`properties`, and `required` for the severity); where that rendering is short of the schema (a nullable object, a `z.any()` or `z.undefined()` key), the routes file's Zod for the same route decides. A route only the app registers has no Zod: a short rendering is reported unreadable, and a key the rendering drops without a note (`z.undefined()`) goes unseen |
| `agent-route-*` | Every route that declares `.agent()`, with its controller found by file and export |
| `prototype-*` | Every named route, so a fixture entry naming a route a provider registers is not an orphan. The `createApp({ prototype })` wiring and the fixture itself are read from source |

A run introspects only when some check needs it: the app declares a deploy
plugin or the Lambda adapter, has a session config, calls
`configureAttachments()`, has a model that mixes in `Attachable(...)`, or its
routes file registers a route with a params schema or a binding, a route that
declares `.agent()`, or a `prototype` route (or the app has a prototype
fixture). Each rule asks on its own content, so a route only the app registers
is judged by the route contracts only when the routes file has a params schema
or a binding, and by the agent-route rules only when it has an agent route. The
route rules read the routes file under `--routes`, since the manifest
describes the app's entry. Each
run introspects at most once, and a `--changed` run that changed no source
file does not introspect at all. The manifest is read with this environment's
`.env`, so a store selected by an environment variable is judged at its local
value. Introspection stops before any provider's `boot()`, so for a
`configureAttachments()` called inside a function the call's options are read
from source, and the routes and storage drivers from the app.

`guren check`, `doctor`, `audit`, `gate` and `plan:verify` introspect, all
with the same 10-second cap, so `check --ci` and the gate judge an app the same
way. The edit hook (`check --changed`) and the dev MCP server's `guren_check` do
not, so there the verdicts only the app can answer are `-unverified`.

Each of these results carries `evidence` in `--json` output. A verdict that reads
several facts reports the weakest source among them:

| `evidence` | Meaning |
|------------|---------|
| `manifest` | Judged with the introspected app. Facts the manifest does not carry (OAuth state stores, explicit in-memory constructions) still come from the source scan |
| `static` | Judged from source because the fact lives there: provider discovery, a disk's `root`, the options of a `configureAttachments()` called inside a function, a session or attachments table the schema must export (a missing export fails the introspection, so the source is the only reader), and a session config the app never reads. The message says why the manifest was not used |
| `none` | Only the registered app can answer, and no manifest could vouch for it: the app was not introspected, the introspection failed, a provider threw in `register()`, a config was left unbound because it reads an unset environment variable, or a deferred provider or an undescribable binding supplies the section. The key ends in `-unverified` and the result is an advisory warning, never a pass. This covers the deploy hasher and stores, the session binding, and the attachments delivery mount and redirect disks |

When introspection fails, `check` adds one advisory `introspection-unavailable`
line with the reason. The verdicts that read the source are judged from it,
and the rest are `-unverified`. `doctor` reports the reason as
`evidenceReason` in its JSON. `--no-introspect` skips introspection, which
suits an app whose entry does not import yet:

```bash
bunx guren check --no-introspect
bunx guren doctor --no-introspect
```

The deploy builds run the same verdicts, with introspection capped at 10
seconds, and print one line naming what each was judged from.

`guren audit` reads the introspected app for its route-level rules
(`validation:*`, `authz:*`, `agent-annotation:*`). It introspects only when the
routes file registers a route that mutates or carries a body, or fails to load
on its own (the app may still register it), and never with
`--routes`, since the manifest describes the app's entry rather than the file
you named. From the manifest:

- A middleware alias arrives resolved, wherever the app registers it: a route
  behind an `auth` alias that a provider registers passes `authz:*`, where the
  routes file loaded on its own reports a guard it does not recognize.
- A chain that authorizes but never authenticates stays a warning, and the
  message says what it checks: the ability, any or all of several, or an
  ability decided at request time. A guest request reaches the gate with a
  `null` user, and a policy may let it through.
- A name no alias or group registers anywhere in the app is reported as
  unresolved. Mounting such a route fails at boot, so the warning comes ahead of
  any guard beside it, and a guard never passes it. When something introspection
  skips could register the name (a `createApp({ boot })` callback, or a provider
  whose `introspect()` hook replaced its `register()`), the message names it.
- A controller is found by its file and export. Two modules may each declare a
  `ReportController`, and each route is judged against its own class. When a
  route's class matches no export of the controller files (a class declared in
  the routes file, say), an exported class of the same name is not used, and
  neither is any same-named class while the routes file or the entry declares
  the name: the route is reported as not analyzable. Otherwise a same-named
  class a controller file declares without exporting it, or one in a file that
  failed to import during introspection, is read by name.
  `controller-name-collision:*` is reported only when such a name fallback
  meets two files declaring the name, or the class was found through a
  re-export. The body checks (`validateBody()`, `userOrFail()`) still read the
  action's source.

`guren check` uses the same lookup for its agent-route rules. Raw SQL, secrets,
mass assignment and CSRF exemptions are judged from source either way.

Route-level findings carry `evidence`: `manifest` when the manifest alone
decided them (a guard's capability, a body schema the route enforces), `static`
when they read a controller body or the routes file. The JSON report's
`routeSource` says which was read, with the reason when it was the routes file.
A failed introspection adds one `introspection-unavailable` warning, which does
not change the exit code, and a provider that threw in `register()` sends the
rules back to the routes file, since that provider may register an alias the
routes name. `--no-introspect` reads the routes file only:

```bash
bunx guren audit --no-introspect
```

### Route lists from the introspected app

`guren context` lists the introspected app's routes, a provider's or a plugin's
included, and leaves out a module under `modules/` that `createApp()` never
mounts. Schema types are still rendered from the routes file, so a route only
the app registers is listed without them. `--no-introspect`, or `--routes`,
lists the routes file's routes. When the app cannot be introspected, the Routes
section says why in one line (`routesNotIntrospected` in `--json`) and lists
the routes file's routes. `guren context <Entity>` introspects only when a route
reaches a controller class that two files declare, and never with `--routes`.

`guren doctor`'s `prototype-routes` counts the introspected app's routes once a
routes file passes the `prototype` handler.

`guren codegen` reads the routes file unless you pass `--introspect`. The Vite
plugin runs codegen on every edit, and the default codegen is the reference
`guren check`, `doctor` and `guren gate` work from. With `--introspect` the app decides
which routes exist and in which order, and each route is rendered from the
routes file's Zod. An app whose routes all come from the routes file and its
modules gets the same files byte for byte, unless two routes share a name and
`createApp({ modules })` lists the modules in another order than their
directories sort. A route only the app registers is added without schema types,
with a warning naming it, and an agent tool on it comes from the manifest; when
two routes claim one tool name, the one the running app registers first wins,
as at runtime. The output lasts until the next codegen without the flag, the
Vite watcher's included. In an app whose agent tools all come from a provider,
`check` and `doctor` report the `.guren/agents.gen.ts` it wrote as stale, and
the `guren codegen` they name removes it. When the routes file derives tools of
its own, they only ask whether the file exists, so the extra tools pass unseen. When the app cannot be introspected, or `--routes` names a
file other than the one `check` finds as the entry, codegen writes from the
routes file and says why:

```bash
bunx guren codegen --introspect
```

`guren spec:generate` and `check --spec` always read the routes file. The views
are committed, and `guren gate` regenerates them in process without
introspecting, so a view written from the manifest would read as drift there.
