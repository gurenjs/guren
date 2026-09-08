---
"@guren/plugin-cloudflare": minor
---

**The `--mcp-oauth` worker sweeps its own KV.** The `scheduled` handler that shipped with cron triggers dispatched only to the app's `scheduler`, so the OAuth provider's storage was never swept and orphaned grants accumulated in `OAUTH_KV` with nothing to remove them. A grant whose client has been deleted carries no expiry at all, so KV's TTLs — which do drop the *expiring* records — never see it. Each firing now calls `purgeExpiredData` before delegating to the app's tasks.

Throttled through KV rather than off `event.cron`: the trigger belongs to the app and the build scaffolds none, so nothing may assume a particular cadence. A marker key records the last sweep, is read every firing and written only on the firings that actually sweep — a `* * * * *` app therefore sweeps roughly hourly rather than every minute, and writes one marker per sweep rather than one a minute against a free tier of 1000 a day. Roughly, because KV reads are eventually consistent: a marker may not be visible everywhere for up to a minute, and an extra sweep is harmless. The marker is claimed *before* the sweep, so a sweep that dies part-way waits out the interval instead of retrying, and failing, on every firing. The marker sits under a prefix the provider never lists (`client:`, `grant:` and `token:` are its three), so it is invisible to the sweep itself.

`batchSize` is the depth of the only window ever swept rather than a throughput knob: the provider's cursor lives inside one call and `PurgeOptions` carries none, so every firing restarts at the head of the key space and neither looping nor deferring the remainder to the next firing makes progress. It is 15 per pass — below the upstream default of 50 — because a Free-plan invocation allows 50 subrequests, KV reads count toward them, and the app's own scheduled tasks share the same budget; a worker cannot tell which plan it is on, so the smaller one sets the number. A sweep that stops at the limit says so through `console.warn`.

The grant and token passes are two calls rather than one, for the same total reads. `purgeExpiredData` returns as soon as the grant pass fills its budget, *before* the token pass in the same call — so an app holding more than `batchSize` grants would sweep grants forever and never once reach its tokens. `purgeOrphanedTokens: false` on the first call and both grant flags off on the second give each pass its own window.

The sweep runs first and its failures are logged rather than rethrown, so the app's own tasks still run. An app that adds a cron *only* for the sweep still has to bind a `scheduler` — `handler.scheduled` throwing on an empty binding is deliberate and unchanged.

`sweepOAuthStorage` is exported from `@guren/plugin-cloudflare` rather than emitted into the worker as text: the generated module gains one name on the import line it already carries and one call, matching how it gets `createWorkersHandler`, `routeGuardedAgentRequest` and `mcpOAuthPropsToAuth`. The bindings it needs are typed structurally (`OAuthSweepKvLike`, `OAuthPurgerLike`), the way `R2BucketLike` already is, so `@cloudflare/workers-oauth-provider` and `@cloudflare/workers-types` stay devDependencies.

The plain and agents workers are byte-identical to what they emitted before.
