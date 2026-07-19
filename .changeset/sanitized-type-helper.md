---
'@guren/server': minor
---

Add the `Sanitized<T, Hidden>` type helper (and `DefaultSanitizedKeys`). `auth.user()` sanitizes records at runtime — the password column, remember-token column, and the model's `static hidden` fields are stripped — but the type previously still claimed those fields were present. `auth.userOrFail<Sanitized<UserRecord>>()` now lets the compile-time type match the runtime shape; extra hidden fields go in the second type parameter (`Sanitized<UserRecord, 'twoFactorSecret'>`).
