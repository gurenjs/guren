# Upgrading Guren

Use this guide for minor-to-minor upgrades.

## Upgrade Workflow (Required)

1. Read `CHANGELOG.md` and release notes.
2. Check `docs/en/guides/release-policy.md` compatibility matrix.
3. Update dependencies and regenerate artifacts:

```bash
bun install
bunx guren codegen
```

4. Run validations:

```bash
bun run build
bun run typecheck
bun run test
```

5. Apply migration notes for your source/target versions.

## Migration Notes

### 1.x → 2.0.0

#### Structural mass assignment

- **What changed**: `static guarded` and `static strictFillable` are removed. `fillable` is always strict; the primary key (`id`) is always silently stripped. On `AuthenticatableModel` subclasses, the password-hash and remember-token columns can never be mass-assigned — a request body carrying them throws a `MassAssignmentException`, whatever `fillable` says.
- **Who is affected**: Models declaring `guarded` or `strictFillable` (now flagged as errors by `guren check`), and code that mass-assigns a precomputed hash or remember token through `create()`/`update()`.
- **How to migrate**: Delete `guarded`/`strictFillable` declarations — `bunx guren upgrade --check-only` lists the affected files. Where a model relied on `strictFillable = false`, each new throw names a field that was being silently dropped: add it to `fillable` or remove it from the payload. Replace `create({ ..., passwordHash })` with `create({ ..., password })` and let the model hash it, or `forceCreate({ ..., passwordHash: 'oauth:...' })` for trusted server-side values — never with request input.

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

`ModelUserProvider` now reads credential column names from the model (`passwordHashField` / the new `rememberTokenField`), so a renamed column needs no matching provider option; explicit `passwordColumn`/`rememberTokenColumn` options still win. The deprecated `createType` option of `defineModel()` is removed — use `optionalOnCreate`/`requireOnCreate`.

### rc → 1.0.0

#### Strict mass assignment

- **What changed**: Models that define `fillable` now throw a `MassAssignmentException` when `create()` / `update()` receives a field outside the allowlist. Previously, extra fields were silently discarded.
- **Who is affected**: Any code that passes unfiltered objects (spread request bodies, merged defaults) to `create()` / `update()`.
- **How to migrate**: Pass only allowlisted fields, or use `forceCreate()` / `forceUpdate()` for trusted server-side data such as seeders and system records.

```ts
// Before: authorId silently dropped when not in fillable
await Post.create({ ...data, authorId: user.id })

// After: either add authorId to fillable, or use forceCreate for trusted data
await Post.forceCreate({ ...validated, authorId: user.id })
```

#### Sanitized auth user records

- **What changed**: `auth.user()` no longer contains the password column, the remember-token column, or fields listed in the model's `static hidden`.
- **Who is affected**: Code that read those fields off the authenticated user object.
- **How to migrate**: Load the model explicitly (e.g. `User.findOrFail(user.id)`) in the rare server-side flows that need the raw record.

#### SSE broadcasting

- **What changed**: `private-` / `presence-` channels without a registered authorizer are now denied by default, and subscribing requires the `clientId` delivered in the SSE `connected` event.
- **Who is affected**: Apps using the SSE broadcasting endpoints.
- **How to migrate**: Register authorizers with `broadcast.privateChannel()` / `broadcast.presenceChannel()`, capture the `clientId` from the `connected` event, and send it in `POST /broadcasting/auth` to authorize and subscribe in one call. See the [Broadcasting guide](./broadcasting.md).

Verify the upgrade:

```bash
bun run typecheck && bun run test
```

## Breaking Change Template (for future releases)

For each breaking item, document:

- **What changed**
- **Why**
- **Who is affected**
- **Before/After code examples**
- **One-command verification**
