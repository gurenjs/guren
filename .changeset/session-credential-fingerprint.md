---
'@guren/server': minor
---

`SessionGuard` binds a session to the password it was opened under. `ModelUserProvider` reports a digest of the password hash through the new optional `UserProvider.credentialFingerprint()`, the guard stores it at login, and a session whose copy differs from the stored record's stops authenticating at its next request. A password reset or a profile password change therefore signs out every other session of the account, on every session driver, with no change to the app. Log the user in again after the write to keep the session that made the change, as the `make:auth` profile controller does.

Sessions opened before this version carry no fingerprint and are signed out once. A login or a `validate()` call that rehashes the stored password signs out that account's other sessions and keeps the one that made the call. `auth.id()` now loads the user for a provider with the capability, so an ended session reports no id. A test that writes `auth:user_id` into the session directly has to log in through the guard instead. A custom provider without `credentialFingerprint()` keeps the previous behaviour.
