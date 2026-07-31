# RFC: Docs Viewer — an interactive graph UI for the OKF bundle on the dev server

**Author:** Urata Daiki
**Date:** 2026-07-30
**Status:** Accepted (2026-07-31) — the standard two-week discussion window
was intentionally shortened by the author, who is also the project's
deciding maintainer. The design was validated ahead of acceptance by a
working prototype and by the implementation itself (#229), which shipped
against this document with the amendments recorded in place below.

## Problem

Guren's docs pipeline now produces a knowledge corpus that is machine-true:
`docs/` is an OKF (Open Knowledge Format v0.2) bundle whose frontmatter
declares relations (`entities`, `related`, body markdown links), whose
provenance is recorded (`generated`, `verified`), and whose links are
mechanically validated (`guren check --docs`) alongside drift-gated spec
views (`guren check --spec`). Agents both write and consume this corpus
cheaply — `guren context <Entity>` and the MCP tools serve it as text.

Humans have no equivalent surface. The reading options today are:

1. **Raw markdown in the editor** — fine per document, but the relations
   are the point of the format, and frontmatter link lists don't read as
   a graph. Nobody re-synchronizes a mental model by opening five files
   and cross-referencing `related:` arrays.
2. **`guren context <Entity>` output** — entity-scoped text designed for
   agent context windows, not for a person browsing the whole corpus.
3. **GitHub's file view** — renders one document; no relations, no
   verdicts, no provenance at a glance.

This inverts the asymmetry the spec-anchored work (RFC 0004) exists to
fix: code and docs are now written at agent speed, but the human's cost
of *understanding what the corpus says and how it hangs together* hasn't
dropped. The declared graph — which documents govern which entities and
code paths, which views derive from which sources, what is verified and
by whom — exists only in frontmatter nobody can see whole.

A working prototype (2026-07-30, throwaway) established two facts this
proposal leans on:

- **The data is already sufficient.** A force-directed graph with
  per-document detail panels was rendered entirely from `scanDocs()` and
  `runDocsCheck()` output — no new introspection was needed.
- **No graph library is needed at this scale.** A ~60-line force
  simulation over plain SVG handles a bundle of this size smoothly, so
  the viewer can ship as a self-contained static asset with zero runtime
  dependencies.

## Proposed Solution

Mount a read-only docs viewer on the dev server at `/_guren/docs`,
following the MCP endpoint's precedent exactly: opt-in via environment
variable, never active in production, loopback-guarded, and reaching the
CLI's introspection layer via dynamic import.

### What the user sees

`bun run dev`, then `http://localhost:3333/_guren/docs`:

- A **full-viewport force-directed graph** of the OKF bundle. Every
  non-reserved `.md` under `docs/` (and `modules/*/docs/`) is a node;
  entities named in `entities:` and code paths named in `related:` are
  satellite nodes. Edges:
  - solid — declared relations (`entities`, `related`, body markdown
    links), colored by the `check --docs` verdict (ok / warn / fail);
  - dashed — derivation: the code sources each generated spec view
    regenerates from.
- **Click a doc node** → a side panel with the document: OKF frontmatter
  (type, status, `generated`/`verified` actors, trust tier per OKF §5.3),
  the validated link list with verdicts, and the rendered markdown body
  (mermaid fences included).
- **Click an entity/code node** → which documents govern it, which spec
  views it feeds, with cross-navigation into those documents.
- Hover dims non-neighbors; nodes are draggable; type/module/text
  filters narrow the graph on real bundles.

The viewer is deliberately a *reading* surface. It edits nothing and
executes nothing; the write path stays `make:adr`, the editor, and
`spec:generate`.

### Activation and access control

Mirrors `packages/server/src/mcp/endpoint.ts`:

```ts
// packages/server/src/docs-viewer/endpoint.ts
export const DOCS_VIEWER_PATH = '/_guren/docs'

export function isDocsViewerEnabled(): boolean {
  return (
    typeof process !== 'undefined' &&
    process.env?.NODE_ENV !== 'production' &&
    process.env?.GUREN_DOCS === '1'
  )
}
```

- **Opt-in, dev-only.** `GUREN_DOCS=1` and `NODE_ENV !== 'production'`,
  the same double gate as `GUREN_MCP`. The scaffold's `dev` script sets
  it alongside `GUREN_MCP=1`, so new apps get the viewer by default in
  dev while the gate stays explicit. Production ignores the variable.
- **Loopback guard.** The MCP access guard already rejects both
  non-loopback `Origin` values (browser pages, DNS rebinding) and
  non-loopback socket peers (other hosts on the LAN, since templates
  bind `0.0.0.0`). The guard is extracted from `mcp/endpoint.ts` into a
  shared helper and applied to every `/_guren/docs*` route; the MCP
  endpoint keeps its existing behavior through the same helper.
- **No CSRF exemption needed.** All viewer routes are `GET`; the CSRF
  middleware only guards mutating methods.

### Architecture

```
packages/server/src/docs-viewer/
  DocsViewerServiceProvider.ts   # mounts routes when enabled (boot)
  endpoint.ts                    # path constant, isDocsViewerEnabled, guard reuse
packages/cli/src/
  docs-graph.ts                  # buildDocsGraph(cwd) — nodes/edges/verdicts
  docs-render.ts                 # renderDocHtml(source) — markdown subset → HTML
packages/cli/assets/docs-viewer/
  index.html                     # self-contained UI (inline CSS/JS, no deps)
```

`DocsViewerServiceProvider` follows `McpServiceProvider`: registered by
`Application` when `isDocsViewerEnabled()` holds, and loading `@guren/cli`
via dynamic import at boot so `@guren/server` takes no static dependency
on the CLI and production bundles stay clean.

Routes (all `GET`, all behind the loopback guard):

| Route | Response |
|-------|----------|
| `/_guren/docs` | the static UI shell from `packages/cli/assets/docs-viewer/` |
| `/_guren/docs/data.json` | `{ nodes, edges, docs }` — the whole bundle in one payload |
| `/_guren/docs/assets/mermaid.js` | mermaid resolved from the app's `node_modules` (see below) |

`data.json` embeds everything: graph nodes/edges with verdicts, and per
document the parsed frontmatter plus the rendered HTML body. There is
deliberately **no per-file endpoint taking a path parameter** — the
whole-bundle payload removes the path-traversal surface entirely, and
OKF bundles are small (a corpus is dozens of documents, not thousands).

### The graph builder

```ts
// packages/cli/src/docs-graph.ts
export interface DocsGraphNode {
  id: string                      // doc path | 'entity:<Name>' | code path
  kind: 'doc' | 'entity' | 'code'
  label: string
  docType?: string                // OKF type, doc nodes only
}

export interface DocsGraphEdge {
  from: string
  to: string
  relation: 'governs' | 'links' | 'derives'
  verdict: 'pass' | 'warn' | 'fail'
}

export function buildDocsGraph(
  refs: DocRef[],
  checks: CheckResult[],
): { nodes: DocsGraphNode[]; edges: DocsGraphEdge[] }
```

Inputs are the existing `scanDocs()` and `runDocsCheck()` outputs; the
builder is a pure join of the two, unit-testable without a filesystem.
Derivation edges come from `SPEC_VIEWS` (`packages/cli/src/spec-generate.ts`);
each `SpecViewDescriptor` gains a human-readable ~~`sourceLabels: string[]`
alongside its `sources` regexes~~ **Amended in implementation:** label —
`sources` became `Array<{ pattern: RegExp; label: string }>`. Two
parallel arrays drifted before the first release (a pattern added
without its label), so the pairing is enforced by the type instead of by
adjacency — which is the property this sentence wanted: the graph and
the drift gate share one
list and cannot drift apart. Living in `@guren/cli`, the builder is also
trivially exposable as `guren docs:graph --json` for agents and CI later,
though that command is not part of this RFC.

### Markdown rendering

The prototype's markdown subset renderer (headings, paragraphs, lists,
tables, fenced code, inline spans; mermaid fences passed through as
`<pre class="mermaid">`) moves into `packages/cli/src/docs-render.ts`
with tests. It covers what the bundle format produces today. A full
CommonMark dependency is explicitly *not* added — the docs convention is
a controlled vocabulary (same philosophy as the frontmatter parser in
`docs-index.ts`), and holes found in practice are cheaper to patch than
a markdown engine is to carry.

Mermaid is the one heavyweight: diagrams are central to the spec views,
but bundling mermaid (~1 MB minified) into a published `@guren/*` package
taxes every install for a dev-only screen. Instead:

- the scaffold adds `mermaid` to ~~new apps'~~ `devDependencies` —
  **Amended in implementation:** to the `default` blueprint only. The
  `api` blueprint has no frontend, so it relies on the degradation path
  below instead of carrying a browser diagram library;
- `/_guren/docs/assets/mermaid.js` serves the file resolved from the
  *app's* `node_modules` (via `import.meta.resolve`, no path input);
- when mermaid is not installed, diagram fences degrade to plain code
  blocks with a one-line hint (`bun add -d mermaid`).

No CDN is involved: the viewer works offline and sends nothing anywhere.

### Freshness

v1 keeps updates simple: the UI polls `data.json` with `If-None-Match`
every few seconds while the tab is visible; the endpoint answers `304`
from a content hash. The dev server already restarts on backend changes
(`bun --hot`) and the Vite plugin already watches the paths that feed
codegen, so polling only has to cover edits to `docs/` itself. A push
channel (SSE) is deferred — see Open Questions.

### Testing

- `docs-graph.ts` and `docs-render.ts`: pure-function unit tests in
  `packages/cli/tests/`.
- Endpoint behavior: `@guren/testing` `TestApp` with `GUREN_DOCS=1` —
  mounts only when enabled, serves `data.json`, guard rejects
  non-loopback `Origin`, 404 in production mode.
- The existing MCP guard tests extend to the shared helper.

### Scaffold and docs changes

- `create-app` templates: `GUREN_DOCS=1` joins `GUREN_MCP=1` in the
  `dev` script; `mermaid` joins `devDependencies`.
- Agent harness (`docs-and-spec.md` rule) and the spec-anchored guide
  mention the viewer as the human-facing half of the loop.

## Alternatives Considered

- **A CLI command that generates a static HTML export instead of a dev
  server route** (`guren docs:export`). Simpler security story (no
  endpoint at all), and the prototype effectively was this. Rejected as
  the *primary* interface because the viewer's value is being one
  keystroke away during development, always current; an export command
  composes cleanly later on top of the same builder + asset.
- **Rendering inside the docs site / a hosted service.** The corpus is
  the app's private knowledge; it must not leave the machine. Everything
  here is local by construction.
- **A Vite-built SPA (React, d3).** The app's Vite pipeline belongs to
  the app; adding a framework build for a framework-internal screen
  couples the viewer to frontend tooling that API-only apps don't have.
  The prototype showed a dependency-free static asset is enough, and it
  works identically for the `api` blueprint.
- **Default-on in dev without an env gate.** Friendlier, but
  `.claude/rules/common-pitfalls.md` records the standing rule: features
  that expand attack surface are opt-in. The scaffold setting
  `GUREN_DOCS=1` in the `dev` script gives new apps default-on ergonomics
  while keeping the gate explicit and greppable.
- **Reusing `GUREN_MCP` as the gate for both endpoints.** Fewer knobs,
  but the two surfaces have different risk profiles (code-generating
  JSON-RPC vs read-only HTML) and users legitimately want one without
  the other.
- **Mermaid via CDN.** Rejected: offline development and zero-egress are
  hard requirements for a screen that renders private specs.

## Migration Path

Purely additive. Existing apps opt in by setting `GUREN_DOCS=1` (and
installing `mermaid` for diagrams); `guren agent:sync` refreshes the
harness rule text. Nothing changes for apps that ignore the feature.

## Open Questions

1. **Push updates.** Is ETag polling enough, or should the endpoint grow
   an SSE channel (`/_guren/docs/events`) watching `docs/`? Polling is
   dependency-free; SSE is nicer but adds a watcher to the dev server's
   lifecycle (teardown on `bun --hot` reloads needs care — see the timer
   teardown work in #169).
   **Resolved in implementation:** ETag polling shipped, with the
   server-side payload cache's TTL held above the poll interval so a
   visible tab does not trigger rebuilds. SSE stays deferred.
2. **Large bundles.** At what node count does the flat graph stop being
   readable, and is the answer clustering (collapse `docs/adr/` into an
   expandable group node), a module-level zoom, or search-first
   navigation? Real usage on `web/` and larger dogfood apps should
   decide before anything speculative is built.
3. **Entity deep links.** Should entity nodes link out to
   `guren context <Entity>` output rendered in the panel (making the
   viewer the human face of the context bundle), or stay minimal? The
   data path exists; the question is scope.
4. **Static export.** `guren docs:export` writing a self-contained HTML
   file (for PR artifacts, sharing a snapshot with a reviewer) — same
   builder, same asset, no server. Worth shipping in v1 or after?
   **Resolved in implementation:** after. Not part of the initial
   implementation.
5. **OKF `index.md` generation.** OKF §8 lets producers generate
   directory listings for progressive disclosure. The viewer makes them
   redundant locally, but generated `index.md` would serve GitHub
   browsing and external OKF consumers. Separate proposal if wanted.
