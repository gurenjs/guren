---
'@guren/cli': patch
---

Fix `make:auth --oauth`: the scaffolded `OAuthController` no longer creates an account from an email address the provider has not verified. Google reports `email_verified` and Discord reports `verified` alongside the address, and returning an email is not a claim that it was checked — so an unverified one could previously create an authenticated account holding an address it did not own, and the callback's email-collision check would then permanently turn the real owner away on their first sign-in. The check runs only on the account-creation path, so an already-linked account is not locked out if its provider status changes later.

This changes the generated `OAuthController.ts` for every `--oauth` variant; the rest of the scaffold is untouched. GitHub was already safe here — its fallback email lookup requires a verified primary address.
