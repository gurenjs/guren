---
'@guren/cli': patch
---

Fixed `make:auth --oauth <providers>` scaffolding a profile form that let an account replace the email its identity provider had vouched for. Without `--verify` nothing in the generated app can re-prove a new address, so the account could end up asserting an email it had never owned — and the generated `OAuthController` would then turn that assertion into a rejection for the address's real owner on their first sign-in.

`--oauth` without `--verify` now scaffolds the profile email read-only: the field is dropped from `ProfileUpdateSchema` and `ProfileController.update()` no longer reads one, so a hand-crafted request cannot carry an address either. `--oauth --verify`, and every scaffold without `--oauth`, keep the editable email field unchanged.

This does not make an email address exclusive to whoever owns the mailbox. Registration still accepts any well-formed email and `users.email` is unique, so an account holding an address still blocks that address's first OAuth sign-in — the fix only stops a provider-vouched account from silently moving off the address it proved.
