# RFC: Spec-Anchored Development

**Author:** Urata Daiki
**Date:** 2026-07-25
**Status:** Accepted (2026-07-25) — the standard two-week discussion window
was intentionally shortened by the author, who is also the project's
deciding maintainer. Unlike RFC 0002, acceptance precedes implementation;
the design is grounded in an infrastructure survey of the existing CLI
introspection layer and external prior art (see Prior art), and each part
ships as its own reviewed PR referencing this RFC. Open Questions remain
open and will be resolved during implementation with in-place amendments.

## Problem

In AI-assisted development the bottleneck has inverted: code is written
faster than humans can maintain their understanding of the system's
specification. Guren already generates *type-level* views of the system
(`pages.gen.ts`, `routes.gen.ts`, `api-client.gen.ts`, OpenAPI), but
nothing produces *human-level* views — the artifacts a person reads to
re-synchronize their mental model: a domain diagram, an ER diagram, a
screen inventory, a module map. Today those are hand-drawn or absent,
and hand-drawn versions drift the moment an agent lands the next PR.

Four concrete gaps:

1. **No derived spec views.** All the raw material exists — the model
   parser extracts relationships with direction and target
   (`packages/cli/src/model-parser.ts`), `RouteDefinition` carries
   controller bindings plus all four Zod schemas
   (`packages/server/src/mvc/Router.ts`), page-props codegen extracts
   every screen's data contract — but no command renders any of it into
   something a human reads. The only mature spec output is OpenAPI
   (`@guren/openapi`, `openapi:generate`).
2. **Docs and code are strangers.** Business context, decisions, and
   ADRs live in `docs/*.md` (when they exist at all — the scaffolded
   app template has no `docs/` convention). Nothing links a doc to the
   models or controllers it governs, so nothing can tell you that
   editing `Invoice` should make you re-read
   `docs/adr/0007-billing-cycle.md`, and nothing fails CI when the doc
   references a file that was renamed away.
3. **`guren context` cannot answer entity questions.** It emits the
   whole project or nothing, and its route section uses the lossy
   `RouteInfo` (method/path/name only, `packages/cli/src/route-list.ts`)
   instead of the rich `RouteDefinition`. An agent asking "everything
   about User" gets no help; it re-derives the answer with grep, every
   session, at token cost.
4. **Prose conventions decay.** Telling agents "keep the diagram
   updated" in `CLAUDE.md` fails for the same reason prose architecture
   rules failed before `guren check --arch` (RFC 0002): rules hold only
   when a machine checks them on every change.

### Prior art

The design below borrows deliberately:

- **Living Documentation** (Martraire): volatile knowledge must be
  generated from the source of truth, never hand-written; one diagram
  answers one question; annotate code to mark domain knowledge.
- **tbls** (k1LoW/tbls): generated schema docs plus a `diff` mode that
  fails CI when committed docs drift from reality. The drift gate is
  the feature; generation alone is not enough.
- **laravel-erd / drizzle-docs-generator**: derive the *domain* diagram
  from model relationship declarations and the *DB* diagram from the
  schema — two views, not one.
- **Context Mapper**: reverse-engineer a DDD context map from framework
  conventions (there: Spring annotations; here: `modules/*/`).
- **Swimm**: line-level doc↔code anchors need patented auto-repair
  machinery because they decay fastest. Traceability research (LiSSA,
  ICSE 2025; ReqToCode, 2026) agrees: explicitly declared file/class
  level anchors are robust and beat post-hoc link recovery on
  precision. We adopt declared, coarse-grained anchors.
- **Cursor rules / Kiro steering**: markdown frontmatter with glob
  patterns is the convergent idiom for attaching docs to code paths;
  agent tooling already parses this shape.
- **Spec-driven tools** (Kiro, GitHub Spec Kit, OpenSpec, Tessl): all
  forward-only (spec → code) with per-feature spec bundles that die at
  merge time (Fowler's critique). None regenerates specs from code
  continuously. Guren's conventions make the reverse direction cheap;
  no tool currently occupies this position.

## Proposed Solution

Three parts sharing one principle — **derived where possible, declared
where not, checked always** — shipped in dependency order. All parts
are purely additive; no existing API changes.

- **Part 1 — entity context:** `guren context <Entity>` joins
  everything the CLI already knows about one entity into a single
  markdown/JSON bundle, and exposes it over MCP.
- **Part 2 — doc–code links:** a `docs/` frontmatter convention that
  declares which entities and paths a document governs, a reverse
  index that feeds Part 1, and `guren check --docs` to keep links
  valid.
- **Part 3 — derived spec views:** `guren spec:generate` renders
  Mermaid ER/domain/screen/module views into the repo, and
  `guren check --spec` fails CI when they drift from code.

### Part 1: `guren context <Entity>`

Extend the existing `context` command with an optional positional
argument:

```bash
bunx guren context              # whole project (unchanged)
bunx guren context User         # entity-centric bundle
bunx guren context User --json  # machine-readable
```

#### Route data upgrade (prerequisite)

`generateContext` switches from `listRoutes`/`RouteInfo` to
`loadRouteDefinitions`/`RouteDefinition`
(`packages/cli/src/load-routes.ts`), which is already module-aware and
carries `controller: {name, action}`, the four Zod schemas, and OpenAPI
metadata. This enriches the whole-project output too (routes gain a
Controller column) and is the join key for everything below.

#### Entity resolution and joins

The entity name resolves against discovered model class names
(case-insensitive). On ambiguity across modules (`app/Models/User.ts`
vs `modules/crm/models/User.ts`) the command lists candidates and
requires `--module <name>`.

The bundle joins, using existing infrastructure only:

| Section | Source |
|---|---|
| Model | `parseModelFile` — table, traits, relationships (both directions: declared on the entity, plus reverse edges where other models target it) |
| Schema | table columns from the schema parser (Part 3 extends it; until then, column names via the extractor in `audit.ts`) |
| Routes | `RouteDefinition[]` where `controller.name` matches `<Entity>Controller` or `bind` references the model |
| Controller | file path + public action list (AST, as in `check.ts`) |
| Pages | pages rendered by those controller actions (the `this.inertia(...)` scan from `check.ts:checkInertiaPages`) + their extracted Props types |
| Resource / Policy / Factory / Seeder / Tests | name-convention lookup via the discovery layer |
| Linked docs | reverse index from Part 2 (section absent until Part 2 ships) |

Output is a markdown document with those sections; `--json` emits the
same structure as data. Example (abridged):

```markdown
# User

## Model — app/Models/User.ts (table: users)
- hasMany posts → Post
- hasOne profile → Profile

## Routes
| Method | Path | Action | Body |
|---|---|---|---|
| GET | /users/:id | UserController.show | — |
| POST | /users | UserController.store | { email, name } |

## Pages
- users/Show — Props: { user: Data.User }

## Linked docs
- docs/adr/0007-billing-cycle.md (adr, accepted, reviewed 2026-07-25)
```

#### MCP surface

`create-mcp-server.ts` gains one tool and one resource template:

- tool `guren_entity_context({ entity, module?, format? })`
- resource `guren://context/{entity}`

Both delegate to the same `generateEntityContext()` in `@guren/cli`
through the existing `GurenCliApi` injection seam. The MCP endpoint
remains gated behind `GUREN_MCP=1` and non-production `NODE_ENV`; this
adds read-only introspection only.

### Part 2: doc–code linking

#### The `docs/` convention

Scaffolded apps gain a `docs/` directory with `docs/adr/`. Any
markdown file under `docs/` may declare frontmatter:

```yaml
---
kind: adr            # adr | context | guide
status: accepted     # adr only: draft | accepted | superseded
entities: [User, Invoice]
related:
  - app/Models/Invoice.ts
  - modules/billing/**
last_reviewed: 2026-07-25
---
```

- `entities` — model class names this document governs. This is the
  primary anchor: class-granularity links survive file moves and are
  what Part 1 consumes.
- `related` — paths or globs, for docs governing non-model code. Glob
  syntax matches the Cursor/Kiro idiom so agent tooling can reuse it.
- `last_reviewed` — freshness marker, advisory.

All fields are optional; a plain markdown file with no frontmatter is
simply never linked and never checked.

A `make:adr` generator scaffolds numbered files:

```bash
bunx guren make:adr "Billing cycle is end-of-month"
# → docs/adr/0001-billing-cycle-is-end-of-month.md (frontmatter prefilled)
```

#### Reverse index

A `docs-index.ts` module in `@guren/cli` scans `docs/**/*.md` (and
`modules/*/docs/**/*.md`), parses frontmatter, and builds
`Map<entityName, DocRef[]>` plus `Map<path, DocRef[]>`. Part 1's
"Linked docs" section is a lookup into this index. No content is
parsed beyond frontmatter and the first heading (used as the title).

#### `guren check --docs`

One new check function following the existing `CheckResult[]` pattern
in `check.ts`:

- **fail** — a `related` path/glob matches nothing on disk (rename or
  deletion broke the link).
- **fail** — an `entities` name matches no discovered model.
- **warn** — an ADR with `status: superseded` is still the only doc
  linked to an entity.
- **warn** (opt-in) — `last_reviewed` older than a configured TTL.
  Off by default; enabled via `guren.config` or flag, since a default
  TTL would make every fresh scaffold noisy.

The check runs as part of plain `guren check` whenever a `docs/`
directory exists — presence is the opt-in, mirroring how module checks
activate on `modules/`. It participates in `--changed`: only docs
whose frontmatter targets changed files (and docs that themselves
changed) are validated, which is what makes it cheap enough for the
edit-hook path.

#### Code-side tags (minimal)

A single JSDoc tag closes the loop from the code side:

```typescript
/** @docs docs/adr/0007-billing-cycle.md */
export class Invoice extends Model<typeof invoices> { ... }
```

The model/controller parsers already walk these classes with Babel;
extracting leading-comment `@docs` tags is a small addition. Tags feed
the same reverse index (so `guren context Invoice` shows the doc even
if its frontmatter forgot `entities`), and `check --docs` fails on a
tag pointing at a missing file. Richer vocabularies
(`@coreConcept`, `@businessRule`, glossary generation) are explicitly
out of scope for this RFC — see Open Questions.

### Part 3: derived spec views

#### `guren spec:generate`

Renders four markdown artifacts into `docs/spec/` (committed to git;
see Alternatives for the location discussion):

| File | Content | Source |
|---|---|---|
| `er.md` | Mermaid `erDiagram` — tables, columns with types, FK edges | schema parser (extended); edges additionally from model relationships, since scaffolded schemas do not emit `.references()` |
| `domain.md` | Mermaid `classDiagram` — models grouped by module, relationship edges with cardinality | `parseModelFile` output |
| `screens.md` | Per-screen table: route → controller action → page → Props type ~~→ Resource data type~~ | `RouteDefinition` + inertia scan + page-props extraction |
| `modules.md` | Mermaid graph of modules, their entities, and cross-module dependencies | discovery + ~~the arch-check dependency data~~ a self-contained static-import scan |

**Amended in implementation:** `screens.md` has no separate Resource
column — resource data types already appear inside the extracted Props
types (`{ post: PostResourceData }`), so a dedicated column would
repeat the same information on every row. `modules.md` scans imports
itself rather than reusing arch-check's helpers: the two disagree on
purpose (type-only imports count in a context map but not in boundary
enforcement, and the scan must stay a pure function of the sources).

Design rules, all consequences of the prior art:

- **Deterministic output.** Stable sort order, no timestamps, no
  absolute paths. A regeneration with no code change is byte-identical
  — this is what makes the drift gate and PR diffs meaningful.
- **One file answers one question.** No single grand diagram; the
  domain view and the DB view are different documents on purpose.
- **Generated banner.** Each file starts with a comment naming the
  generating command, so humans and agents know not to hand-edit.

The schema parser extension: `extractTableColumns` in `audit.ts`
currently returns column names only. It is promoted into a shared
`schema-parser.ts` that also captures column builder types
(`varchar`, `integer`, …), nullability, and `.references()` targets
when present, keeping `audit.ts` as a consumer.

`openapi:generate` is unchanged and remains the API spec channel;
`spec:generate` links to its output rather than duplicating it.

#### `guren check --spec`

Regenerates all four artifacts in memory and diffs against the
committed files. Any difference is a **fail** with the suggestion
`run bunx guren spec:generate`. Like `--docs`, it activates only when
`docs/spec/` exists, runs inside plain `guren check`, and is exactly
the tbls-diff mechanic: the committed spec cannot silently lie.

The Vite plugin does **not** regenerate spec views on save (unlike
route codegen) — spec artifacts change at PR granularity, and
auto-writing committed docs from a file watcher invites churn. The
edit-hook path stays fast via `check --changed`, which skips `--spec`
unless schema/model/route files changed.

### Rollout

1. Part 1 without the docs section (route-data upgrade + entity
   bundle + MCP tool).
2. Part 2 (`docs/` convention, `make:adr`, reverse index wired into
   Part 1, `check --docs`, `@docs` tag).
3. Part 3 (`spec:generate`, shared schema parser, `check --spec`).
4. Template/harness updates: `create-app` templates gain `docs/adr/`
   with a seed ADR explaining the convention; `agent:init`/`agent:sync`
   rules teach agents to run `guren context <Entity>` before touching
   an entity and `spec:generate` after schema/model/route changes.

Each part is independently shippable and useful; implementation PRs
reference `Refs: RFC 0004`.

## Alternatives Considered

- **LLM-based link recovery as the primary mechanism.** Embedding or
  LLM-judged traceability (LiSSA-style) could infer doc↔code links
  with no authoring cost, but precision is unreliable and results are
  non-deterministic — unacceptable as a CI gate. Research consensus is
  that declared anchors win where you control the conventions;
  recovery is for backfilling legacy corpora. A future
  `docs:suggest-links` command may use the user's own agent for
  backfill, but it is out of scope here.
- **Swimm-style line-level anchors with auto-repair.** Line-granular
  references decay fastest and demand heavy repair machinery
  (Swimm's is patented). Class/file/glob granularity keeps validation
  deterministic and cheap, at the cost of coarser links — the right
  trade for a framework.
- **Spec-first workflow files (Kiro/Spec Kit/OpenSpec shape).**
  Per-feature `requirements.md`/`design.md`/`tasks.md` bundles are
  disposable — they describe a change, not the system, and go stale at
  merge. Guren derives the durable, whole-system spec from code
  instead; nothing stops users from also using an SDD workflow on top.
- **Extending `guidelines` instead of adding `spec:generate`.**
  `guidelines` synthesizes *conventions* for agents; spec views are
  *facts* for humans with a CI drift gate. Different audiences,
  different freshness contracts; conflating them would force one
  command to serve both badly.
- **Emitting into `.guren/` instead of `docs/spec/`.** `.guren/` holds
  build-time artifacts that tooling consumes; spec views exist to be
  read and reviewed by humans in PR diffs. Committing them under
  `docs/spec/` makes spec drift visible in review, with `check --spec`
  as the enforcement. (Location is still listed as an open question.)
- **PlantUML or DBML output.** Mermaid renders natively on
  GitHub/GitLab and in most editors; PlantUML needs a render server
  and is declining in new tooling; DBML serves interactive editors,
  not in-repo review. Mermaid only, at least initially.

## Migration Path

Purely additive. Existing applications see no behavior change:

- `guren context` without an argument behaves as today (richer route
  data aside).
- `check --docs` / `check --spec` activate only when `docs/` /
  `docs/spec/` exist, so no existing CI goes red.
- New scaffolds include `docs/adr/` and the seed ADR; existing apps
  opt in by creating `docs/` (or running `make:adr` once) and running
  `spec:generate` once.

## Open Questions

1. **Artifact location.** `docs/spec/` (committed, human-first) is
   proposed, but `.guren/spec/` (generated-only) with a rendered copy
   in the docs site is defensible. Does committing generated Mermaid
   create merge-conflict pain on busy repos?
2. **Entity ambiguity UX.** Is `--module` sufficient, or should the
   bundle merge same-named entities across modules with clear
   provenance headers?
3. **Reverse relationship edges.** Showing "Post belongsTo User" under
   `guren context User` requires an inverted index over all models —
   ~~include in Part 1, or defer?~~
   **Resolved in implementation:** included in Part 1 as `referencedBy`.
   Every model is already parsed to resolve the entity argument, so the
   inversion is a cheap in-memory pass over data the command has anyway.
4. **`last_reviewed` TTL.** Ship disabled with config opt-in (as
   proposed), or default to a generous TTL (e.g. 180 days, warn-only)?
5. **Richer code-side vocabulary.** `@coreConcept`/`@businessRule`
   tags plus a `guren glossary` command (living glossary) are a
   natural follow-up — separate RFC, or fold in here?
6. **MCP doc content.** Should `guren://context/{entity}` inline
   linked doc *content* (token cost, but one round trip) or only
   paths/titles (proposed)?
7. **screens.md fidelity.** Props types can be large; render full
   types, or truncate to top-level keys with a link to the page file?
