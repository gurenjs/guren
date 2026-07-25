---
'@guren/cli': patch
---

Fix `make:auth --verify --oauth <providers>`: newly created OAuth accounts are now marked email-verified at creation. Previously they were left unverified, and since `OAuthController` never sends a verification email, `requireVerifiedEmail` would strand every OAuth signup at `/verify-email` with no way to get past it. The OAuth provider already vouches for the address, so there's nothing to re-verify.
