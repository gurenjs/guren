# ORM internals

## Write execution

`Model.update()` and `Model.delete()` run the model lifecycle (below), then
delegate to a scoped `QueryBuilder`. Builder writes share validation for adapter
capabilities, dropped filters, and unsupported ordering or pagination before
calling the adapter. Bulk builder writes retain their existing behavior: they do
not invoke per-model hooks or observers.

Update payloads cross the internal `PREPARED_UPDATE` boundary after fillable
filtering, mutators, and casts have run. Do not prepare them again inside that
boundary. Internal soft-delete timestamps bypass user payload transforms.
`SoftDeletes` supplies the `BULK_DELETE` handler used by both static and
builder deletion; `PHYSICAL_DELETE` is the internal path for explicit hard deletes.

## Model lifecycle

`model-lifecycle.ts` owns event order and cancellation for static create, update,
and delete, and for the `SoftDeletes` `delete()` and `forceDelete()`. Each write
holds its hooks object and a copy of its observer list from before the first
event, so replacing `hooks` or calling `observe()` or `clearObservers()` inside a
callback applies from the next write. Before events run all hooks first, then
observers in registration order for each event. A false result aborts before
persistence; exceptions propagate. After events run only after a successful
write, before read transforms, and their return values do not cancel the write.

Model retains payload preparation, scoped query construction, and return types.
Create and update pass the prepared payload to before events and the adapter
result to after events. Every static delete goes through the symbol-keyed
`LIFECYCLE_DELETE` on Model: the caller checks its own adapter capability, the
dropped-filter guard runs before `deleting`, and the same condition object
reaches both phases. `restore()` fires no events, since no hook name covers it.

`model-lifecycle.test.ts` fixes these contracts through the public Model and
`SoftDeletes` methods, including asynchronous ordering, abort messages, failure
paths, and registration changes during callbacks.

## Relation loading

Model owns relation declarations, public result types, and dispatch through its
protected loader methods. Keep those methods as delegates: subclasses can
override them, including on a model reached through a nested relation.

- `relation-loading.ts` fetches and attaches rows for each relation kind.
- `relation-records.ts` owns scoped raw reads, key batching, count plans, and
  related-row transforms. Pivot reads use the parent's adapter; through-model
  and target-model reads use their respective scoped query builders.
- `relation-tree.ts` groups shared path heads and walks children before applying
  their transforms. Identity deduplication prevents shared children from being
  transformed twice; projections continue to suppress accessors.
- `relation-definitions.ts` describes internal relation metadata. `casts.ts`
  keeps ordinary reads and related reads on the same cast implementation.

Match and recurse on raw keys before casts or accessors change them. Preserve
query options through pivot, intermediate, and target reads. A missing to-many
relation yields an empty array, and a missing to-one relation yields null.

## Connection ownership

`drizzle-adapter.ts` builds queries and decodes results. `drizzle-connection.ts`
owns execution and transaction lifetimes. Each database object has one runtime,
kept in a weak registry. Its transaction queue, pending operations, savepoint
counter, and cached driver capabilities belong to that runtime.

`DrizzleAdapter.configure(db)` selects the default runtime. Selecting the same
database again reuses its state, including any queued work. An active transaction
retains its owning runtime through async context even if the default changes.
The async-context transport is shared so transactions on different connections
can identify their owners; it does not own their queues or capability caches.

The default remains process-wide. This is not an application-level connection
registry or a tenant-routing API. Outside an active transaction, operations use
the configured default. An explicit `trx` still takes precedence when resolving
the query executor. Code opening nested transactions must await them in order,
as savepoints share a connection.

## Regression coverage

Run `bun run test:bun orm` from the repository root. Its isolated test contexts
prevent driver mocks in unit tests from leaking into integration tests.

`write-contract.test.ts` runs the same write semantics against SQLite and, when
`POSTGRES_URL` or `MYSQL_URL` is supplied, live PostgreSQL and MySQL. The live
fixtures create and remove their own databases; the supplied account needs
database creation permission. SQLite connection-isolation tests cover default
reconfiguration during an active transaction. Driver-specific tests continue
to cover migrations, result shapes, and nested transaction behavior.

When adding a write path, route it through these boundaries and extend the shared
contract before introducing driver-specific expectations.
