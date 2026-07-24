---
'@guren/cli': patch
---

Fix a stray `@guren/server/redis` reference in `make:auth`'s password-reset/email-verification store comments — it should point at `@guren/core/redis`, the public subpath. Also fully adopt `make:auth`'s auth stack (registration, password reset, email verification, GitHub/Google OAuth) into `examples/blog`, replacing the login-only reference implementation.
