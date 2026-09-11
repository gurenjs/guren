---
"@guren/server": minor
"@guren/core": minor
---

Choose the password hasher once, and default to scrypt on every runtime

`createApp({ auth: { hasher } })` selects the one hasher the app writes
passwords with: `'scrypt'` (the default), `'argon2'`, or a `PasswordHasher` of
your own. `AuthManager.hasher()` resolves it, `useModel()` hands it to the
`ModelUserProvider`, and `AuthenticatableModel` reads it through the container,
so a row the model hashes on `create()` and a login the provider verifies can no
longer disagree on the format. An explicit static `passwordHasher` on a model
still wins.

The default changes from "Argon2id under Bun, scrypt elsewhere" to scrypt
everywhere. A `$scrypt$` hash verifies on Bun, Node, Lambda and Workers alike;
an Argon2id hash written under Bun could not be verified anywhere else, which is
how a column seeded locally broke the first login after a Workers or Lambda
deploy. `'argon2'` keeps `Bun.password` for a deployment that stays on Bun, and
`createApp()` throws on a runtime without it rather than failing at the first
`create()`.

Verification still routes on the stored hash's prefix, so existing Argon2id rows
keep logging in under Bun. `DefaultHasher.needsRehash()` now reports any hash
whose format differs from the configured writer, and `SessionGuard` acts on it:
after a successful credential check it rehashes the plaintext with the configured
hasher and persists it through the new optional
`UserProvider.rehashPasswordIfRequired()`, which `ModelUserProvider` implements
with a `forceUpdate()` of the password column. A failed attempt never rehashes.
Rows that never log in again keep their format; migrate such a column while the
app still runs on Bun, or reset those passwords, before moving off it.

`ScryptHasher` keeps its name and is also exported as `Argon2Hasher`, which is
what it is: `Bun.password`'s Argon2id, never scrypt. `guren doctor` / `guren
check` / the deploy builds flag `hasher: 'argon2'` and `new Argon2Hasher()` on
a Workers or Lambda app the way they already flagged `new ScryptHasher()`.
