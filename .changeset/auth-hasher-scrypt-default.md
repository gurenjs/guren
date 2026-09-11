---
"@guren/server": minor
"@guren/core": minor
---

Choose the password hasher once, and default to scrypt on every runtime

**New hashes written under Bun change format, from Argon2id to `node:crypto`
scrypt.** Existing rows are untouched and still verify, because verification
routes on the stored hash's own prefix. To keep writing Argon2id on a
deployment that stays on Bun, pass `createApp({ auth: { hasher: 'argon2' } })`.

`createApp({ auth: { hasher } })` selects the one hasher the app writes
passwords with: `'scrypt'` (the default), `'argon2'`, or a `PasswordHasher` of
your own. `AuthManager.hasher()` resolves it, `useModel()` hands it to both the
`ModelUserProvider` and the model class, so a row the model hashes on `create()`
and a login the provider verifies can no longer disagree on the format. A model
declaring `static passwordHasher` keeps it, and the provider then uses that one
rather than the app's.

An Argon2id hash written under Bun could not be verified anywhere else, which is
how a column seeded locally broke the first login after a Workers or Lambda
deploy. A `$scrypt$` hash verifies on Bun, Node, Lambda and Workers alike.
`createApp()` throws on `'argon2'` where `Bun.password` is missing, rather than
failing at the first `create()`.

`DefaultHasher.needsRehash()` now reports any hash whose format differs from the
configured writer, and `SessionGuard` acts on it: after a successful credential
check it rehashes the plaintext with the configured hasher and persists it
through the new optional `UserProvider.rehashPasswordIfRequired()`, which
`ModelUserProvider` implements. A failed attempt never rehashes, and a write
that fails is warned rather than refusing the login. Rows that never log in
again keep their format; migrate such a column while the app still runs on Bun,
or reset those passwords, before moving off it.

`ScryptHasher` is deprecated in favour of `Argon2Hasher`, the same class under
the name that says what it produces: `Bun.password`'s Argon2id, never scrypt.
`guren doctor` / `guren check` / the deploy builds flag `hasher: 'argon2'`,
`new Argon2Hasher()` and `new Hash({ algorithm: 'argon2' })` on a Workers or
Lambda app, and report a hasher named by an expression they cannot read instead
of passing it as scrypt.

This is a minor rather than a major: no stored hash stops verifying, no
signature changes, and Argon2id was already unverifiable off Bun. Only the
format of new writes moves.
