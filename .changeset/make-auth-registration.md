---
'@guren/cli': minor
---

`guren make:auth` now scaffolds a registration flow (`RegisterController`, `RegisterSchema` with password confirmation, and a `Register` page) by default, wired into `routes/auth.ts` and linked from the login page. Pass `--minimal` to reproduce the previous login-only scaffold.
