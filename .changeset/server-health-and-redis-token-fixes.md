---
'@guren/server': patch
---

Fix the health middleware returning an empty 204, and never-expiring Redis API tokens reading as expired

Two independent bugs, both fail-safe (a broken read, not an exposure):

- `HealthManager.middleware()` built its JSON response with `ctx.json(...)` but
  never returned or assigned it, so the router saw an unfinalized context and
  synthesized an empty `204` — the documented `router.get('/health',
  health.middleware())` returned no report at all. It now finalizes the context
  by assigning `ctx.res`, preserving the `200`/`503` status.

- `RedisApiTokenStore` serializes a never-expiring token's `expiresAt` as `''`
  (a Redis hash has no null). On read, `toOptionalExpiry('')` degraded the empty
  string to the epoch rather than treating it as absent, so every non-expiring
  token in Redis was rejected as expired. The empty string now maps to "no
  expiry"; a genuinely unparseable value still degrades to expired.
