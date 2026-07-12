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

### rc → 1.0.0

#### Strict mass assignment

- **What changed**: Models that define `fillable` now throw a `MassAssignmentException` when `create()` / `update()` receives a field outside the allowlist. Previously, extra fields were silently discarded.
- **Who is affected**: Any code that passes unfiltered objects (spread request bodies, merged defaults) to `create()` / `update()`.
- **How to migrate**: Pass only allowlisted fields, or use `forceCreate()` / `forceUpdate()` for trusted server-side data such as seeders and system records. To restore the old discard behavior on a specific model, set `static strictFillable = false`.

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
