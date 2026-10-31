# Upgrading Guren

Use this guide when you move an app to a newer version. Follow the workflow below. The migration notes are listed by release (the version on the GitHub release), newest first; apply the ones for every release you cross, starting from the oldest.

## Upgrade Workflow (Required)

1. Read `CHANGELOG.md` and the release notes.
2. Check the compatibility matrix in the [Release Policy](./release-policy.md).
3. Update dependencies and regenerate artifacts:

```bash
bun install
bunx guren codegen
```

4. Check the project for deprecated API usage:

```bash
bunx guren upgrade --check-only
```

Each finding names the version the API was deprecated in, the version it is removed in, the replacement to move to, and the files that use it. Nothing is written to disk.

5. Apply the migration notes below for every version between your current one and the target.
6. Run validations:

```bash
bun run build
bun run typecheck
bun run test
```

## Guren UI Tokens

`resources/css/guren.css` holds the Guren UI design tokens. The part Guren owns sits between two marker lines:

```css
/* guren:tokens begin: `guren upgrade` replaces everything up to the end marker. Add your own rules after it. */
...
/* guren:tokens end */
```

When a release changes the tokens, `bunx guren doctor` reports the `guren-ui-tokens` check and `bunx guren upgrade` replaces the block. Lines outside the markers stay as you wrote them, so put your own overrides after the end marker. `bunx guren upgrade` runs the CLI the app has installed, so a token change reaches the file on the first upgrade after `bun install` brings in the release that carries it.

An app created before the markers existed has a `guren.css` without them. If you never edited it, `bunx guren upgrade` swaps it for the marked sheet. If you did, doctor leaves it alone and prints how to move your edits after the end marker of the current sheet. Broken markers (a begin with no end, an end with no begin, two blocks) are reported too, and upgrade writes nothing to the file until you fix them.

## Migration Notes

### 2.26.x → 2.27.0

#### `analyzeDeployRuntime()` and `judgeDeployRuntime()` are deprecated

- **What changed**: These two `@guren/cli` exports, for scripts that check whether an app is safe to deploy, carry `@deprecated` and warn once each per process. They keep working until `@guren/cli` 3.0.0.
- **Who is affected**: Scripts that import either function. `bunx guren upgrade --check-only` lists them.
- **How to migrate**: Call `checkDeployRuntime(cwd)`, which returns the same three verdicts, or none when the app declares no deploy target. It reads the password hasher and session stores from the app itself, loaded without booting; when that load fails, those two verdicts come back as the advisory `deploy-password-hashing-unverified` and `deploy-runtime-stores-unverified`. The six hasher and session-config signal arrays on `DeployRuntimeAnalysis` are now always empty.

#### Concurrent cache misses share one callback

- **What changed**: When several calls in one process miss the same key with the same TTL at the same time, `remember()` and `rememberForever()` on a store from `cache.store()` run the callback once, and every caller receives the same result object or the same error. Hits are unchanged.
- **Who is affected**: Code on the file or Redis store that changes a remembered value in place. Callers that missed together used to get a copy each; now a change reaches the callers it shares the result with.
- **How to migrate**: Copy the value before modifying it (`structuredClone(value)`). See [Concurrent Misses](./cache.md#concurrent-misses).

### 2.25.x → 2.26.0

#### Queue cancellation and reservations

- **What changed**: Jobs receive a cancellation signal through `this.signal`, which aborts when the job times out or its worker loses the job to another worker. After a timeout the worker waits for `handle()` to settle before retrying, and a handler that completes late is acknowledged rather than retried. A worker holds a *reservation* on the job it runs: Redis workers now renew it, and once another worker has taken the job, the first one's acknowledgement is rejected. `SqsDriver` likewise keeps the message hidden from other workers while a job runs.
- **Who is affected**: Apps with queued jobs, especially on Redis or SQS, and custom queue drivers.
- **How to migrate**, for every app:
  - Pass `this.signal` to `fetch` and other cancellable I/O. A handler that ignores it can run past the timeout, so keep a process manager (systemd, a container restart policy) that can stop a stuck worker.
  - Restart every worker when you deploy this update: an older worker skips the reservation check. Queue keys and stored payloads stay compatible.
  - On SQS, set `SqsDriver`'s `visibilityTimeout` option to the queue's visibility timeout, in seconds (default 30).
  - Delivery is still at least once, so external side effects still need idempotency keys.
- **How to migrate**, for custom queue drivers: implement `heartbeatInterval` and `extendReservation(job)` to renew reservations. `delete()` gains an optional second argument, the reservation token; existing drivers keep working. A driver failure now resets the worker and rejects `start()`, so a process manager can restart it with backoff.

```ts
import { Job } from '@guren/core'

export class SyncInvoiceJob extends Job<{ url: string }> {
  async handle(payload: { url: string }) {
    await fetch(payload.url, { signal: this.signal })
  }
}
```

### 2.23.x → 2.24.0

#### `Model.query()` is deprecated

- **What changed**: `Model.query()` carries `@deprecated` and warns once per model. It keeps working until `@guren/orm` 3.0.0. The query builder gains `sum()`, `avg()`, `min()`, `max()`, `exists()`, `toSql()` and `toDrizzle()`, and every one of them applies the model's global scopes.
- **Who is affected**: Code that calls `Post.query()` or `Post.query(db)`. That query skips every global scope, so on a model with `SoftDeletes` or a tenant scope it has been reading trashed rows and other tenants' rows.
- **How to migrate**: Run `bunx guren upgrade --check-only` for the call sites. There is no codemod, because the replacement depends on what the query does: an aggregate moves to the builder, and a join moves to `toDrizzle()`. See [Dropping to Drizzle](./database.md#dropping-to-drizzle).

```ts
// Before
const rows = await Post.query(db).where(gt(posts.views, 100)).orderBy(desc(posts.id))

// After
const rows = await Post.newQuery().toDrizzle().where(gt(posts.views, 100)).orderBy(desc(posts.id))
```

### 2.22.x → 2.23.0

#### Module-level service setters and getters are deprecated

- **What changed**: `setGate`/`getGate`, `setEncrypter`/`getEncrypter`, `setMailManager`/`getMailManager`, `setQueueDriver`/`getQueueDriver`, `setI18n`/`getI18n`/`tryGetI18n`, `setLogManager`/`getLogManager`, `setNotificationManager`/`getNotificationManager`, `setBroadcastManager`/`getBroadcastManager`, `setExceptionHandler`/`getExceptionHandler`, `setContainer`/`getContainer`, `setInertiaDocument`, `setInertiaSsrRenderer`, and `setInertiaSharedProps`/`getInertiaSharedPropsResolver` carry `@deprecated` and warn once per symbol. They keep working until 3.0.0. A setter now binds the value on the container of the application that is live, so two applications in one process no longer overwrite each other's services.
- **Who is affected**: Providers that call a setter after binding the same key, code that reads a service through a getter, and tests that inject a fake through `setGate()` or `setQueueDriver()`.
- **How to migrate**: Run `bunx guren upgrade --check-only` for the list of files, then `bunx guren upgrade` to apply the rewrites. The codemod:
  - turns a getter inside a provider into `this.container.make(key)`;
  - binds a setter's value with `this.container.instance(key, value)`, or deletes the call when the same file already binds that key;
  - moves an inline `setInertiaDocument({ ... })` into `createApp({ inertia: { document } })`;
  - gives the attachments `storage` factory the container it is bound with;
  - rewrites `getContainer().make(key)` inside a `Job` to `this.make(key)`.

  Test injections are reported, not rewritten: bind a manager holding the fake with `app.container.fake(key, manager)` instead (see [Faking Services](./testing.md#faking-services)). The codemod leaves `setQueueDriver()` calls alone, because the pin still overrides the bound manager until 3.0.0; a queue test that moves to the container fake drops the pin in the same change.

```ts
// Before
export default class AuthorizationProvider extends ServiceProvider {
  boot(): void {
    getGate().policy(Post, PostPolicy)
  }
}

// After
export default class AuthorizationProvider extends ServiceProvider {
  boot(): void {
    this.container.make('gate').policy(Post, PostPolicy)
  }
}
```

The functional helpers built on these accessors are not deprecated and keep their signatures: `encrypt`, `decrypt`, `t`, `tc`, `can`, `cannot`, `defineGate`, `authorizeAbility`, `resolve`, `Job.dispatch` and `Job.make` all resolve from the container of the application they run under.

### 1.x → 2.0.0

#### Structural mass assignment

- **What changed**: `static guarded` and `static strictFillable` are removed. `fillable` is always strict; the primary key (`id`) is always silently stripped. On `AuthenticatableModel` subclasses, the password-hash and remember-token columns can never be mass-assigned: a request body carrying them throws a `MassAssignmentException`, whatever `fillable` says.
- **Who is affected**: Models declaring `guarded` or `strictFillable` (now flagged as errors by `guren check`), and code that mass-assigns a precomputed hash or remember token through `create()`/`update()`.
- **How to migrate**: `bunx guren upgrade --check-only` lists the affected files.
  - Delete the `guarded` and `strictFillable` declarations.
  - **If a `guarded` list carried app-specific fields beyond `id` and the credential columns (e.g. `tenantId`, `isAdmin`), deleting it makes them mass-assignable.** Declare `static fillable = [...]` without those fields to keep them protected.
  - Where a model relied on `strictFillable = false`, each new throw names a field that was being silently dropped: add it to `fillable` or remove it from the payload.
  - Replace `create({ ..., passwordHash })` with `create({ ..., password })` and let the model hash it. For trusted server-side values use `forceCreate({ ..., passwordHash: 'oauth:...' })`, never with request input.

```ts
// Before
export class User extends defineModel(users, { base: AuthenticatableModel }) {
  static fillable = ['name', 'email', 'password']
  static guarded = ['id', 'passwordHash', 'rememberToken']  // now a check error
}

// After — the framework denies the credential columns itself
export class User extends defineModel(users, { base: AuthenticatableModel }) {
  static fillable = ['name', 'email', 'password']
}
```

`ModelUserProvider` now reads credential column names from the model (`passwordHashField` / the new `rememberTokenField`), so a renamed column needs no matching provider option; explicit `passwordColumn`/`rememberTokenColumn` options still win. The deprecated `createType` option of `defineModel()` is removed; use `optionalOnCreate`/`requireOnCreate`.

### rc → 1.0.0

#### Strict mass assignment

- **What changed**: Models that define `fillable` now throw a `MassAssignmentException` when `create()` / `update()` receives a field outside the allowlist. Previously, extra fields were silently discarded.
- **Who is affected**: Any code that passes unfiltered objects (spread request bodies, merged defaults) to `create()` / `update()`.
- **How to migrate**: Pass only allowlisted fields in the data. A column the server chooses, such as the author, goes in the `set` option ([Columns the server chooses](./database.md#columns-the-server-chooses)). Keep `forceCreate()` / `forceUpdate()` for writes that carry no request data, such as seeders and system records.

```ts
// Before: authorId silently dropped when not in fillable
await Post.create({ ...data, authorId: user.id })

// After: keep authorId out of fillable and pass it from the session in set
await Post.create(data, { set: { authorId: user.id } })
```

#### Sanitized auth user records

- **What changed**: `auth.user()` no longer contains the password column, the remember-token column, or fields the model lists in `hidden`.
- **Who is affected**: Code that read those fields off the authenticated user object.
- **How to migrate**: Load the model explicitly (e.g. `User.findOrFail(user.id)`) in the rare server-side flows that need the raw record.

#### SSE broadcasting

- **What changed**: `private-` / `presence-` channels without a registered authorizer are now denied by default, and subscribing requires the `clientId` delivered in the SSE `connected` event.
- **Who is affected**: Apps using the SSE broadcasting endpoints.
- **How to migrate**: Register authorizers with `broadcast.privateChannel()` / `broadcast.presenceChannel()`, capture the `clientId` from the `connected` event, and send it in `POST /broadcasting/auth` to authorize and subscribe in one call. See the [Broadcasting guide](./broadcasting.md).

## Breaking Change Template (for maintainers)

When a release breaks something, its migration note documents:

- **What changed**
- **Why**
- **Who is affected**
- **Before/After code examples**
- **One-command verification**
