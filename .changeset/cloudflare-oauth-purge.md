---
"@guren/plugin-cloudflare": minor
---

**The `--mcp-oauth` worker sweeps its own KV.** The `scheduled` handler that shipped with cron triggers dispatched only to the app's `scheduler`, so the OAuth provider's storage was never swept and orphaned grants accumulated in `OAUTH_KV` with nothing to remove them. A grant whose client has been deleted carries no expiry at all, so KV's TTLs — which do drop the *expiring* records — never see it. Each firing now calls `purgeExpiredData` before delegating to the app's tasks.

Throttled through KV rather than off `event.cron`: the trigger belongs to the app and the build scaffolds none, so nothing may assume a particular cadence. A marker key records the last sweep, is read every firing and written only on the firings that actually sweep — a `* * * * *` app therefore sweeps roughly hourly instead of paying ~200 KV reads a minute, and writes a marker per sweep rather than one a minute against a free tier of 1000 a day. Roughly, because KV reads are eventually consistent: a marker may not be visible everywhere for up to a minute, and an extra sweep is harmless. The marker sits under a prefix the provider never lists (`client:`, `grant:` and `token:` are its three), so it is invisible to the sweep itself.

`batchSize` is 100 rather than the upstream default of 50, and it is the depth of the only window ever swept rather than a throughput knob: the provider's cursor lives inside one call and `PurgeOptions` carries none, so every firing restarts at the head of the key space and neither looping nor deferring the remainder to the next firing makes progress. It is not raised further because a firing that purges everything it sees costs roughly ten subrequests per record, against the thousand Workers allows. A sweep that stops at the limit says so through `console.warn`.

The grant and token passes are two calls rather than one, for the same total reads. `purgeExpiredData` returns as soon as the grant pass fills its budget, *before* the token pass in the same call — so an app holding more than `batchSize` grants would sweep grants forever and never once reach its tokens. `purgeOrphanedTokens: false` on the first call and both grant flags off on the second give each pass its own window.

The sweep runs first and its failures are logged rather than rethrown, so the app's own tasks still run. An app that adds a cron *only* for the sweep still has to bind a `scheduler` — `handler.scheduled` throwing on an empty binding is deliberate and unchanged.

The plain and agents workers are byte-identical to what they emitted before.
