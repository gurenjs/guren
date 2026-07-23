---
'@guren/cli': minor
---

`guren make:auth` now scaffolds a password reset flow (`ForgotPasswordController`, `ResetPasswordController`, a `config/mail.ts` defaulting to the `log` driver, and an in-memory `PasswordResetStore`) by default, alongside a fix for `addImport` corrupting multi-line leading import statements when wiring providers into `src/app.ts`. Pass `--minimal` to skip registration and password reset scaffolding.
