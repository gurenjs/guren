---
'@guren/server': minor
'@guren/cli': patch
---

Add `emailVerified` to `OAuthUserProfile`. Providers report whether they actually verified an address separately from the address itself — Google sends OIDC's `email_verified`, Discord sends `verified` — and until now that signal was only reachable through the untyped `profile.raw` bag. The field is tri-state on purpose: `true` (the provider asserts verified), `false` (it asserts not verified), `undefined` (no signal, so the app decides its own policy).

Provider configs declare where to read it via `emailVerifiedKey`, so the shared mapper knows only OIDC's standard `email_verified` claim; the Google and Discord presets each declare their own key, and only boolean values are read. GitHub's `/user` carries no such field, so `emailVerified` stays `undefined` there — except when the private-email fallback runs, which reports `true` because `/user/emails` only yields verified primary addresses. `mapProfile` still owns the whole mapping when set.

`make:auth --oauth`'s scaffolded `OAuthController` now checks `profile.emailVerified === false` instead of matching provider-specific keys on `profile.raw`. Same behavior, no provider names in generated application code.
