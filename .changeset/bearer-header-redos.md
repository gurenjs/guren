---
'@guren/server': patch
---

Fix a quadratic-backtracking regex in `readBearerToken` (CodeQL `js/polynomial-redos`).

`/^Bearer\s+(.+)$/i` let the separator and the token both match a space, so the
two repetitions overlapped. On `Bearer` followed by a long run of spaces and a
newline — `.` never matches one, so `$` is unreachable — the engine retried
every split of that run, quadratic in the header's length: ~1.5s for a 50KB
header, and the header is parsed *before* any authentication, by
`hasBearerHeader` on every request that carries one. Anchoring the capture with
`\S` removes the overlap; the same input now costs ~0.1ms.

The only input whose result changes is an all-whitespace token, which was never
a token: `Bearer` + spaces used to read as a bearer request carrying a space,
and now reads as not a bearer request at all. That reclassification is what the
change is, not just a different token value — `AuthManager.resolveGuardName` no
longer routes such a request to the token guard, and the CSRF middleware no
longer skips it. Net stricter: the request falls back to the session guard with
CSRF enforced, where it previously bypassed CSRF to reach a token lookup that
could only ever 401.
