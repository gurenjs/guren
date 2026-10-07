---
"@guren/cli": patch
---

`make:auth` gives the generated `User` model a `fillable` list (`name`, `email`, and `password` when password sign-in exists) and writes the server-chosen columns through `set` (RFC 0031). The OAuth callback creates the account with `User.create({ name, email }, { set })`, so the provider id and `emailVerifiedAt` can no longer arrive in create data. The profile update resets `emailVerifiedAt` through `set`. Email confirmation, which carries no request data, uses `forceUpdate`. Apps scaffolded before keep their model; to adopt this, add the same `fillable` and move those writes as the new scaffold does.
