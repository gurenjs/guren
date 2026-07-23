---
'@guren/cli': minor
---

`guren make:auth --verify` now scaffolds an email verification flow (`VerifyEmailController`, a `VerifyEmail` page, an `emailVerifiedAt` users column, and an in-memory `EmailVerificationStore`). Registration sends a verification email and redirects to `/verify-email` instead of `/dashboard`, and the generated `/dashboard` route is guarded with `requireVerifiedEmail`. Also fixes `updateSchema()` corrupting a `users` table defined with Drizzle's three-argument form (e.g. `pgTable('users', {...}, (table) => [...])`) by inserting the new column next to the `rememberToken` field instead of attempting a whole-block replace.
