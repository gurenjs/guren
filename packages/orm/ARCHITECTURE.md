# ORM internals

## Write execution

`Model.update()` and `Model.delete()` handle model hooks and observers, then
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
and delete. Each operation captures its hook and observer references after
payload preparation. Before events run all hooks first, then observers in
registration order for each event. A false result aborts before persistence;
exceptions propagate. After events run only after a successful write, before
read transforms, and their return values do not cancel the write.

Model retains payload preparation, scoped query construction, and return types.
Create and update pass the prepared payload to before events and the adapter
result to after events. Delete passes the same condition object to both phases.
Bulk builder writes and SoftDeletes keep their own existing lifecycle behavior;
the helper does not introduce events at those boundaries.

`model-lifecycle.test.ts` fixes these contracts through the public Model methods,
including asynchronous ordering, abort messages, failure paths, and registration
replacement during callbacks.

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
