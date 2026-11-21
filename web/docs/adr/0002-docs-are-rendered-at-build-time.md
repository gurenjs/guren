---
type: adr
status: stable
entities: []
related:
  - scripts/prerender-docs.ts
  - app/Services/DocsStore.ts
  - app/Services/docs-manifest.ts
  - app/Services/FsDocsStore.ts
verified: { by: human:7nohe, at: 2026-11-21T13:05:19Z }
---

# Docs are rendered at build time

## Context

The docs are markdown in the repository. Rendering them needs shiki, marked
and `node:fs`, and the full shiki bundle alone would have put the Worker
over the size limit Workers had then.

A first version rendered at build time into generated modules inside the
bundle. Measured later, those modules were 23 MB: 83% of the upload and
about 40 MB of every isolate's heap, for strings most requests never read.

## Decision

A build step renders every doc once. Each doc becomes a JSON fragment and a
`.md` file under `public/`, served by Workers Static Assets. The Worker
reads a fragment back through its `ASSETS` binding when it renders a page.

The bundle carries only a manifest of titles and descriptions. In
development a filesystem store renders from `docs/` on each request, so an
edited file shows on reload.

## Consequences

The upload went from 28,622 KiB to 4,917 KiB, and no renderer runs on a
request.

A doc changes only with a deploy. A manifest entry whose fragment is
missing answers 503, since a 404 would present a broken deploy as a page
that never existed.

The `.md` mirrors and `llms-full.txt` are answered by the asset layer
before the Worker runs, so the Worker's middleware does not see those
requests.
