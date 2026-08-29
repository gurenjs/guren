---
"@guren/server": minor
---

Add `TokenGuard` and unify bearer-token authentication with the auth context (RFC 0016 Phase 0).

- `TokenGuard` implements the `Guard` contract backed by an `ApiTokenStore`: `requireAuthenticated()`, `Controller.auth`, and `Gate` now treat token-authenticated requests exactly like session-authenticated ones. Successful verification also populates `ctx[API_TOKEN_KEY]`, so `getApiToken()` and `tokenCan*` keep working. `logout()` revokes the presented token; credential flows (`login`/`attempt`/`validate`) throw.
- `AuthManager.useTokens(store, { provider?, guardName?, updateLastUsed? })` registers the guard and enables header-based selection: an unqualified `auth.guard()` resolves to the token guard when the request carries `Authorization: Bearer`, and to the default (session) guard otherwise. Explicit guard names always win; session-only apps are unaffected.
- `Gate.resolveUser()` now treats an attached framework auth context (`guren:auth`) as authoritative — including when it resolves no user — so policies receive the principal for both session and bearer requests, and a rejected authentication can no longer be shadowed by a manually-set `ctx.set('user', ...)`. An explicit `userResolver` still takes precedence, and the legacy `ctx.get('user')` fallback continues to work for requests with no auth context attached. **Behavior note:** apps that attach the auth context *and* set a reduced/impersonated principal via `ctx.set('user', ...)` for Gate evaluation should move that logic to `defineGate({ userResolver })` or `gate.forUser(...)`, which keep precedence.
- With a configured user provider, `TokenGuard.check()` requires the token's user to resolve — an unrevoked token for a deleted account is not authenticated. `logout()` also clears the request's `API_TOKEN_KEY`, and `useTokens()` refuses a `guardName` that would shadow an already registered guard.
- New export: `VerifiedApiToken` (the result shape of `verifyApiToken`).
