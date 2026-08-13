---
'@guren/cli': minor
---

`guren audit` now audits routes registered with custom HTTP verbs (`router.on('PURGE', ...)`) instead of silently skipping them.

Route auditing enumerated the methods it knew: only POST/PUT/PATCH/DELETE were checked for authentication and only POST/PUT/PATCH/QUERY for body validation. A route registered with any other verb fell through both checks, so an unvalidated body plus a missing auth guard produced zero findings and the audit reported a clean pass.

Method handling is now driven by a single fail-closed classification (`describeMethod`): GET/HEAD/OPTIONS stay unaudited (safe, body-less), QUERY keeps its body check without demanding auth, DELETE stays auth-only, and any other verb is treated as unsafe and body-carrying, so it gets both the authentication and the validation check. That includes TRACE — formally safe per RFC 9110, but deliberately left to the fail-closed default here. Apps using custom verbs may see new findings; genuinely body-less custom verbs can be suppressed via `config/audit.ts`. Output for apps using only GET/HEAD/OPTIONS/QUERY/POST/PUT/PATCH/DELETE is unchanged.
