---
type: adr
status: stable
entities: [Post]
related:
  - modules/blog/app/Services/PostRenderer.ts
  - modules/blog/app/Http/Controllers/Admin/PostsController.ts
  - modules/blog/app/Http/Controllers/BlogController.ts
  - db/schema.ts
verified: { by: human:7nohe, at: 2026-11-21T13:05:19Z }
---

# Posts are rendered when saved

## Context

A post is written in markdown with highlighted code blocks. Rendering one
means running the markdown renderer and shiki, which is the work ADR 0002
keeps off the request path for the docs.

Posts are edited in the admin, so they cannot be rendered at build time as
the docs are.

## Decision

Saving a post renders its markdown once and stores the HTML beside the
source, in `body_html`. Reading a post serves the stored HTML.

The renderer's sanitization stays on: the stored HTML is injected into the
page as is. The renderer imports each shiki grammar and theme as its own
module, never the full `shiki` entry.

## Consequences

A public read runs no markdown and no highlighting.

A change to the renderer, a theme or the sanitizer does not reach posts
already saved. Each has to be saved again to pick it up.

Only the admin's save request pays for rendering, and only that request
loads the grammars.
