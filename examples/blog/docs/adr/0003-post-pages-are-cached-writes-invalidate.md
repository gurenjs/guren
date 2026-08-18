---
type: adr
status: stable
entities: [Post]
related:
  - app/Services/PostCacheService.ts
  - app/Http/Controllers/PostController.ts
generated: { by: "human:7nohe", at: 2026-08-11T11:19:26.406Z }
---

# Post pages are cached, writes invalidate

## Context

Post lists and detail pages are read far more often than they change, and
they are public ([Posts are public by default](0001-posts-are-public-by-default.md)),
so caching them is safe.

## Decision

PostCacheService fronts every post read with a short-TTL cache. The
mutating controller actions call invalidatePost after each write, so
a stale page lives at most until the write that outdates it.

## Consequences

Read throughput no longer scales with database load. Any new mutation
path must go through the service (or call invalidation itself) — a
write that skips it ships stale pages for up to the TTL.
