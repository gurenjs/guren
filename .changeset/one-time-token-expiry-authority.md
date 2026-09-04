---
'@guren/server': minor
---

Drop the unused `config` parameter from `verifyPasswordResetToken`,
`completePasswordReset`, and `verifyEmailToken`, and decide one-time token
expiry from the signed token alone.

The three functions accepted a `PasswordResetConfig` / `EmailVerificationConfig`
and ignored it. The password-reset JSDoc even told callers it "must match" the
config passed to `createPasswordResetToken`, which was never true: expiry is
signed into the token at issuance as an `exp` claim, and the signing key comes
from `APP_KEY`, so nothing in the config object can change what a verify call
decides. This ships as a minor deliberately, on the same footing as the
`ApplicationOptions.discover` removal in 2.10.0: it is a type-surface bug fix
for an argument that never did anything. No caller in the framework, the
scaffolds, or the guides passed one; TypeScript code that did now gets a
compile error naming the truth instead of a silent no-op.

These functions are re-exported from `@guren/core`, which makes them Stable
under `contributing/api-stability.md`, so the two-minor deprecation period
that governed the seeder-class removal in 2.9.0 would normally apply. It does
not here, for the reason `ApplicationOptions.discover` did not need one: a
deprecation period exists to give callers time to migrate, and there is no
migration. The argument was read by nothing, so no program's behavior depends
on passing it or on stopping.

With that settled, the store's `expiresAt` is no longer a second source of
truth. `verifyEmailToken` and `completeEmailVerification` used to re-check the
stored record's `expiresAt` after the signed claim had already passed; the
password-reset path never did. Both now share one rule: the `exp` claim signed
into the token is the authority on expiry, and the store is asked only whether
the token id still exists (single use and revocation). A store may still drop
expired records for housekeeping — the in-memory and Redis stores do — but
verification does not rely on it, so a custom store that returns stale rows is
no longer a way to keep an expired link alive, and one that keeps them is not a
way to extend it either.
