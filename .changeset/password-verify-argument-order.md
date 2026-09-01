---
'@guren/server': minor
'@guren/testing': minor
---

Diagnose a swapped `PasswordHasher.verify()` call, and stop the built-in defaults from being Bun-only.

`verify(hashed, plain)` takes two same-typed strings in the inverse order of both the `Bun.password.verify(plain, hashed)` that `ScryptHasher` delegates to and this package's own `verifyPassword(plain, hashed)`, so a swapped call is a type-correct program that no compiler can reject. It surfaced as an opaque `UnsupportedAlgorithm` (or `Invalid password hash format.`) at runtime, naming neither the parameter nor the order — a 500 on every login. `ScryptHasher` and `NodeHasher` now throw a `TypeError` that says so.

The check is deliberately **two-sided**: it fires only when the second argument looks like a hash *and* the first does not. A one-sided "the first argument must look like a hash" precondition would misdiagnose a legitimate non-hash credential column — `passwordHash: 'oauth:...'`, the sentinel this repo documents for OAuth-only accounts — as a caller mistake; those keep falling through to the implementation and are rejected as before. Neither argument appears in the message, because one of them is a plaintext password and this throw is reached on a live login attempt.

**`AuthenticatableModel`, `ModelUserProvider`, and `AuthManager.useModel()` now default to `DefaultHasher` rather than `ScryptHasher`.** On Bun that is the same hasher and the same hash format. Off Bun it is the difference between working and not: `ScryptHasher` calls `Bun.password` unconditionally, so a model with a plain `password` field threw on `create()` under Node — the runtime the Lambda guide tells you to deploy to, and the runtime an app's own Vitest suite runs on. `DefaultHasher` also forwards `needsRehash()` now, so `Hash` is genuinely a drop-in for the runtime-specific hashers rather than silently dropping that member.

`@guren/testing`'s `configureInertiaVitest({ stubBun: true })` now installs a **working** `Bun.password` built on `node:crypto` scrypt, in the `$scrypt$` format `verifyPassword()` can read back, instead of stubs that throw. A stub that throws forces every app test touching a password into hand-writing its own hasher double, and a hand-written double is a copy of a contract that no type constrains — which is exactly how the swapped call above shipped with a green suite, its double having encoded the same inversion. The fake throws on a hash it cannot parse, as `Bun.password.verify` does, so a swapped call fails in a test the way it fails in production rather than looking like a wrong password.
