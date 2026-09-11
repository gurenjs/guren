---
"@guren/server": minor
---

Let `StorageCheck` take the framework's own `StorageDriver`

The check hand-wrote a `StorageDriverInterface` whose `put` returned
`Promise<void>`, while `StorageDriver.put` resolves the stored path, so
`new StorageCheck(storage.disk())` did not compile — the built-in check could
not be handed a built-in disk. `StorageDriverInterface` is now
`Pick<StorageDriver, 'put' | 'get' | 'delete'>`, which every shipped driver
satisfies.

This is a source break for an object written against the old shape: a `put`
returning `Promise<void>` no longer compiles against the constructor. Return
the path, or pass a `StorageDriver`.

The guide showed a `disk` option the check has never had, and a `.health`
default `testPath` against the code's `__health_check__.txt`. Both now match
the code.
