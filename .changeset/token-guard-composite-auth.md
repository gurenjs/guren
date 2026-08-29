---
"@guren/server": minor
---

Add `TokenGuard` and unify bearer-token authentication with the auth context (RFC 0016 Phase 0).

- `TokenGuard` implements the `Guard` contract backed by an `ApiTokenStore`: `requireAuthenticated()`, `Controller.auth`, and `Gate` now treat token-authenticated requests exactly like session-authenticated ones. Successful verification also populates `ctx[API_TOKEN_KEY]`, so `getApiToken()` and `tokenCan*` keep working. `logout()` revokes the presented token; credential flows (`login`/`attempt`/`validate`) throw.
- `AuthManager.useTokens(store, { provider?, guardName?, updateLastUsed? })` registers the guard and enables header-based selection: an unqualified `auth.guard()` resolves to the token guard when the request carries `Authorization: Bearer`, and to the default (session) guard otherwise. Explicit guard names always win; session-only apps are unaffected.
- `Gate.resolveUser()` now consults the framework auth context (`guren:auth`) before the legacy `ctx.get('user')` fallback, so policies receive the principal for both session and bearer requests. An explicit `userResolver` still takes precedence, and the legacy fallback continues to work when no auth context is attached.
- New export: `VerifiedApiToken` (the result shape of `verifyApiToken`).
