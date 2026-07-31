---
type: adr
status: stable
entities: [Post]
related:
  - app/Http/Controllers/PostController.ts
  - app/Http/Resources/PostResource.ts
verified: { by: human:7nohe, at: 2026-07-25T00:00:00Z }
---

# Posts are public by default

## Context

The blog is a public reading experience; only authoring is gated.

## Decision

Index and Show render without authentication. Store, update, and
destroy require an authenticated author (see PostController).

## Consequences

Public caching of post pages stays trivial; any future private-post
feature must introduce its own visibility model.
