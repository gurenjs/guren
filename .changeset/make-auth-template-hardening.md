---
'@guren/cli': patch
---

Harden `make:auth` templates with fixes discovered while adopting the full auth stack in a real app:

- Validators lowercase the email field, so mixed-case input round-trips correctly through login, password-reset, and email-verification lookups (the token helpers normalize to lowercase internally).
- `/verify-email/confirm` is scaffolded as a public route — it validates the signed token itself, and gating it behind auth stranded users who opened the emailed link from another device or after their session expired.
- `ProfileController.update()` clears `emailVerifiedAt` and re-sends the verification email when the address changes (with `--verify`), instead of letting an unproven replacement address inherit verified status.
- `ForgotPasswordController` no longer awaits the reset-email send inline; the transport round-trip only happened for known accounts, so response timing could reveal which emails are registered.
- `OAuthController` lowercases the provider email before matching and creating accounts.
