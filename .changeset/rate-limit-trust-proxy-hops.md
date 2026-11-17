---
'@guren/server': minor
'@guren/cli': patch
---

`trustProxy: true` on `createRateLimitMiddleware()` now keys on the last `X-Forwarded-For` entry, the one the nearest proxy appended, and no longer reads `CF-Connecting-IP`, `True-Client-IP`, `X-Real-IP` or the first `X-Forwarded-For` entry. An ALB or Nginx forwards those as the client sent them, so a client could pick a new value on every request and never hit the limit. `trustProxy` also takes `{ hops: n }` (the nth entry from the right, for a chain of proxies such as Cloudflare in front of an ALB) and `{ header: 'cf-connecting-ip' }` (one single-value header the proxy overwrites). `resolveClientIp(ctx, trustProxy?)` reads the same address for a custom `keyGenerator`.

To upgrade: behind a single ALB or Nginx, nothing changes. Behind Cloudflare in front of a load balancer, set `trustProxy: { hops: 2 }` or `trustProxy: { header: 'cf-connecting-ip' }`, or every visitor coming through one Cloudflare edge shares that edge's bucket. Behind an Nginx that sets only `X-Real-IP`, set `trustProxy: { header: 'x-real-ip' }`. The limiter logs one warning the first time a request carries one of the headers it no longer reads.
