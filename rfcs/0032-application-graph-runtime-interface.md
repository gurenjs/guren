# RFC: Application Graph and Agent Runtime Interface

**Author:** Guren contributors
**Date:** 2026-09-27
**Status:** Accepted (2026-09-27; the deciding maintainer explicitly approved
the proposal and shortened the standard discussion period before implementation.)

## Problem

A developer following a failed request needs to connect its route, controller,
model, validation and page. A coding agent needs the same information and the
failure from the running application. Guren already exposes much of the static
information, but its consumers assemble different views and do not share a
versioned graph or a bounded feed of request failures.

This proposal implements the first milestone of the DX improvement discussion:
Application Graph → CLI/MCP → Human UI → Plan verification. The graph describes
what Guren can establish, including the limits of that evidence. It must not
turn a parser's incomplete answer into a claim that an application is correct.

The discussion's revised Markdown attachment was not available during drafting.
This document reconstructs the implementation proposal from the conversation
and the repository. It does not reproduce or verify the discussion's competitor
claims, download counts or research findings. Those are motivation to evaluate,
not acceptance criteria or proof that this feature will improve adoption.

### Existing implementation to reuse

| Capability | Existing source | Consequence for this proposal |
| --- | --- | --- |
| Project context | `packages/cli/src/context.ts`, `context-route.ts` | Preserve current JSON and Markdown contracts. |
| Entity context | `packages/cli/src/entity-context.ts` | Reuse entity resolution and module disambiguation. |
| Registration-only introspection | `packages/cli/src/introspect.ts`, RFC 0026 | Distinguish registered routes from source declarations and fallback data. |
| Fresh reads in a long-lived MCP process | `packages/cli/src/fresh-context.ts` | Continue using isolated child processes for imports. |
| Development MCP | `packages/cli/src/dev-mcp/server.ts`, `handler.ts` | Add capabilities to the existing endpoint; do not create another MCP server. |
| Local access guard | `packages/server/src/mcp/endpoint.ts` | Preserve explicit opt-in, production exclusion and peer/origin checks. |
| Documentation graph | `packages/cli/src/docs-graph.ts` | Keep document relations distinct; join by verified source references later. |
| Plan state and detail | `packages/cli/src/plan/app-state.ts`, `app-detail.ts` | Preserve unreadable sections, module scope and mounting evidence. |
| Plan verification | `packages/cli/src/plan-verify.ts`, RFC 0030 | This already exists; migrate readers only after parity is demonstrated. |
| Error handling | `packages/server/src/errors/ExceptionHandler.ts` | Record development failures without changing responses or reporting policy. |

## Proposed Solution

### 1. Scope and delivery order

The first milestone contains a versioned structural graph, read-only CLI/MCP
access, and an opt-in feed of recent server request failures. Deliver it as four
independently reviewable implementation changes after this RFC is accepted:

1. Graph contract and pure builder, with adapters over existing readers.
2. Fresh graph loading, CLI output and a graph MCP tool.
3. Per-application development error buffer and runtime transport.
4. Documentation and an end-to-end fixture proving graph/error correlation.

Do not migrate all existing readers in one change. Do not build the Dev Center
UI before the shared data contract is usable by agents.

### 2. Graph contract

The proposed CLI-internal entry points are:

```ts
buildApplicationGraph(input: ApplicationGraphInputs): GurenApplicationGraph
loadApplicationGraph(options: {
  cwd: string
  introspect?: boolean
}): Promise<GurenApplicationGraph>
```

`ApplicationGraphInputs` contains normalized output of the existing readers.
The builder does no filesystem access, application imports or network calls.
The loader owns discovery, source loading and bounded introspection. Do not
export these functions through `@guren/core` in v0. CLI JSON is the external
contract; publish its JSON Schema with the CLI package.

```ts
type Coverage = {
  status: 'complete' | 'partial' | 'unavailable'
  reasons: Array<{ code: string; message: string; file?: string }>
}

type GraphEvidence = {
  kind: 'registered' | 'static'
  source: string
  file?: string
  line?: number
}

interface GurenApplicationGraph {
  schemaVersion: 1
  snapshot: { id: string; capturedAt: string; consistency: 'stable' | 'changed' }
  coverage: Record<string, Coverage>
  nodes: Array<{
    id: string
    kind: 'route' | 'controller' | 'model' | 'page' | 'middleware' | 'validator' | 'policy' | 'test'
    label: string
    module: string | null
    file?: string
    evidence: GraphEvidence[]
  }>
  edges: Array<{
    from: string
    to: string
    relation: 'handles' | 'binds' | 'renders' | 'usesMiddleware' | 'validates' | 'authorizes' | 'tests'
    evidence: GraphEvidence[]
  }>
  unresolved: Array<{
    from?: string
    relation?: string
    target: string
    reason: string
  }>
}
```

Start the builder with routes, controllers, models and pages. Before milestone
completion, each remaining node/edge kind must either have a supported reader
or an explicit unavailable coverage entry. Coverage keys include both node
kinds and relations. `complete` means the documented reader covered its supported
scope, not that arbitrary TypeScript semantics were proven.

An absent optional directory is a complete empty section. A permission error,
parse failure, ambiguous symbol or unsupported dynamic expression cannot be a
complete empty section. Successful sections remain inspectable when another
section fails. Keep existing diagnostics' keys and evidence levels when linked
later; do not derive security pass/fail verdicts from graph edges.

Use stable, module-scoped IDs. For file-backed symbols, encode a tuple of kind,
project-relative POSIX file path and exported symbol. For a runtime route without
a source location, encode module, method, path, name and registration occurrence.
The occurrence disambiguates duplicate registrations; it is explicitly unstable
when duplicates are reordered. Never merge identical class names across modules
or silently select the first matching route/controller. Preserve route execution
order in source metadata, even when presentation arrays sort by ID.

Edges require resolved endpoints and evidence. A naming convention may produce
an unresolved candidate, never a confirmed model-use or authorization edge.
For example, a route's registered binding can support `binds`; a controller named
`PostController` alone cannot. A test reference means a test was found, not that
it passed. Test execution and freshness remain RFC 0030 responsibilities.

Sort nodes, edges and reasons deterministically. Compute the snapshot ID from
canonical graph content, coverage and relevant source fingerprints, excluding
capture time. Read source bytes once per scan. Fingerprint relevant files before
and after imports; if files change during collection, mark consistency `changed`
and do not let a gate consume that snapshot as current evidence. This is a
bounded consistency check, not a transaction over arbitrary application imports.
A subsequent request performs a fresh scan; do not cache by Git HEAD alone.

### 3. CLI and development MCP

Proposed additive interfaces:

```sh
bunx guren graph --json
bunx guren graph --json --no-introspect
```

`--no-introspect` uses static readers and marks registered-only coverage as
unavailable. It must not execute route registrars or import the application.
Default introspection follows RFC 0026; importing user modules may still execute
their top-level code. The graph command does not boot providers or start HTTP,
queue workers, migrations or tests on purpose.

JSON mode emits one graph document on stdout. Diagnostics belong inside its
coverage fields; incidental child output must not corrupt stdout. Return exit
code 0 for a complete, stable snapshot; 1 with a partial snapshot for incomplete
coverage or concurrent changes; and 1 with a versioned error object when collection
cannot produce a graph. Define and test that error union in the published schema.
A machine consumer must retain valid partial JSON even when the child exits 1.

Add `guren_get_application_graph` to the existing development MCP server. It
returns the same graph document, with a read-only annotation. Initially return
the full graph under a bounded output limit; refuse oversized responses explicitly
instead of silently truncating nodes or edges. Filtering and pagination may follow.
Keep `guren_get_context`, `guren_entity_context`, `guren_check`, `guren_gate` and
`guren_list_models` behavior unchanged. Do not duplicate those tools under new names.

Long-lived callers run the loader in a fresh child with explicit time and output
limits. One graph request shares one introspection result. MCP's graph adapter
must preserve partial output from a nonzero child exit, unlike a generic helper
that throws before parsing stdout. No new dependency on the MCP SDK enters the
server or deployed application bundles.

### 4. Runtime errors

Static graph reads cannot observe a request that failed in the running process.
Add an application-owned collector, passed into the development MCP handler
through an optional capability on the server/CLI integration seam. Do not use a
process-wide mutable buffer or serialize the Hono context.

Activation requires `GUREN_MCP=1` and non-production mode, using the existing
activation function. No production collection or endpoint is enabled by `debug`.
Store at most 100 events, expire after 15 minutes, limit each encoded event to
8 KiB and the buffer to 256 KiB. Evict oldest events to meet both limits. Clear
on application disposal; a replacement application gets a new session identifier.

```ts
interface RuntimeErrorEvent {
  sessionId: string
  sequence: number
  occurredAt: string
  method: string
  route?: { method: string; pattern: string; name?: string }
  status: number
  category: string
  code?: string
  frames: Array<{ file: string; line?: number; column?: number }>
}
```

v0 records framework-handled server request exceptions with status 500 or greater.
It does not capture browser errors, arbitrary console output, build failures,
background jobs or test output. Custom handling that bypasses the framework's
error path is outside coverage and must be documented. Collection failure must
never alter the response, call reporters twice or replace the original exception.
Respect `dontReport` exclusions. Integration tests must locate the actual shared
error path, including custom renderers, rather than assuming an extra reporter
receives request context.

The default event contains no request body, cookies, headers, query values,
concrete URL path, environment values, SQL parameters or arbitrary error message.
Exception messages and stacks can contain secrets. Retain only allowlisted
framework codes and parsed project-relative stack locations; drop external or
unresolvable paths and free-form stack text. Unknown error classes use a generic
category. A future explicit raw-debug mode needs separate review.

Add `guren_get_runtime_errors` with a session/sequence cursor and a capped limit
(default 20, maximum 100). Return collection start time, next cursor, dropped
count and whether the cursor predates retained events. Return `unavailable` with
reason when the installed server lacks the collector or the transport is offline;
never imply that an unavailable collector found zero errors. An empty successful
result means only that no matching retained event exists in that collector window.

Expose the same response through `guren runtime:errors --json --url <local-origin>`.
Use a read-only HTTP route `/_guren/runtime/errors` mounted by the dev provider
behind the existing peer/origin guard. Require an explicit HTTP loopback origin,
reject credentials in the URL and redirects, and never discover remote targets.
MCP and this route read the same collector with the same cursor semantics. An
older CLI ignores the optional collector; a newer CLI paired with an older
server reports unsupported capability. Capability detection must not disable
existing MCP tools.

Correlate events to graph routes by method, registered pattern and name. Include
the runtime session and capture time, and report ambiguity or source changes.
Never manufacture a snapshot ID for an event captured without a graph snapshot.

### Implementation notes

**Amended in implementation:** graph node IDs use the declaring class symbol
and source path, with export aliases used for identity resolution. Route nodes
also carry method, path, name, controller action and registration order. Graph-only introspection
can ask `Router.registeredModelBindings()` for actual classes and match them
to exports; ordinary introspection keeps its existing import scope. Older servers
without that capability leave bindings unresolved. The manifest adds optional
`bindingSources` without changing its version or existing fields.

The initial readers cover route/controller/model/page nodes and
handles/binds/renders edges. Other sections explicitly remain unavailable, so
v0 normally returns exit 1 with useful partial JSON. Static mode currently
leaves routes unavailable rather than inferring fluent route declarations.
The M3 readers below fill the remaining sections.

Runtime events carry a correlation status; duplicate or unknown routes are not
guessed. Their status is the exception status, before a custom renderer changes
the response. `stop()` resets the application buffer and its session; Guren has
no general provider disposal method. The existing peer guard's explicit
`GUREN_ALLOW_UNVERIFIED_PEER` override still applies.

### 5. Follow-on roadmap

| Stage | Deliverable | Completion boundary |
| --- | --- | --- |
| M0 | This RFC and fixture/acceptance design | Maintainer decides contract and scope. |
| M1 | Application Graph + Runtime Interface v0 | The acceptance cases below pass through CLI and MCP. |
| M2 | `/_guren` Dev Center | Routes, related symbols and errors render the same payloads; unknown coverage is visible. Existing Docs Graph and plans remain reachable. |
| M3 | Plan reader convergence | Adapt RFC 0030 readers to graph evidence incrementally; preserve approvals, baselines, scope, drift, waivers and command execution rules with parity tests. |
| M4 | Repair and onboarding | Build on existing `check --fix` and doctor suggestions; generated-file fixes first, no automatic dependency/config rewrites. Measure the first working feature. |
| M5 | Example and deployment paths | One documented example and one verified deployment path first; expand based on observed failures. |

This roadmap preserves the direction of the DX discussion without treating
already shipped Plan verification or MCP support as missing features.

### 6. Acceptance and measurement

- A fixture with a route, controller, bound model and literal Inertia page yields
  the expected supported edges. A name-only relationship stays unresolved.
- Root and module classes with the same name remain distinct. Duplicate routes,
  anonymous handlers and dynamic page names do not produce invented identities.
- Optional missing directories, unreadable directories, malformed source, failed
  introspection and unsupported constructs have distinct coverage outcomes.
- Editing a route/model while an MCP server stays running changes the next
  snapshot. Changes during a scan make the result unusable for a gate.
- CLI and MCP serialize identical graph content for identical inputs. Partial
  JSON survives nonzero child exit. Output and execution limits are tested.
- A fixture request produces one correlated event with the original response
  unchanged. Custom rendering, reporter failure and exclusions retain semantics.
- Two applications cannot see each other's events; expiration, byte limits,
  eviction, stale cursors, disposal and restart are deterministic under a fake clock.
- Production, disabled activation, remote peers, hostile origins and missing
  peer information cannot expose runtime data. Seeded secrets in URLs, bodies,
  messages and stack text are absent from serialized events.
- Older server/CLI pairings degrade to explicit capability information. Existing
  context, entity context, MCP, introspection and Plan suites retain their results.
- Build, typecheck, lint, package/example tests and required repository audits pass
  before implementation PRs are considered ready.

Before M1, record cold/warm context and graph timings on the same committed
fixture and runtime. Report p50/p95, source count, payload bytes and child count.
Run a repeatable route-debugging task before and after runtime access: record
successful repairs, time, manual context-copy steps, agent calls and cost.
Distinguish these internal measurements from adoption evidence. Set a regression
budget from the measured baseline before merging M1. Add no telemetry by default.

### 7. Non-goals for v0

No full request profiler, SQL execution tool, log collector, browser console
capture, queue/mail inspector, production observability, automatic repairs,
new plan format, arbitrary code execution endpoint or global migration of readers.
No claim that a static relationship proves runtime authorization or test success.

## Alternatives Considered

**Build the Dev Center first.** Attractive as a demo, but creates another consumer
that can assemble conflicting answers. Stabilize shared reads before the UI.

**Make ProjectContext the graph.** It is a useful compatibility view, but name-only
lists lose source identity and module disambiguation. Keep the existing contract
and add an evidence-bearing representation.

**Use PlanAppState as the public format.** It contains valuable detailed readers,
but its contract is shaped by plan comparisons and executable imports. Reuse its
readers without exposing every Plan implementation detail to all consumers.

**Introduce another package or MCP endpoint.** Existing CLI/server seams already
separate development tooling from deployment bundles. Extend those seams.

**Store all logs and sanitize later.** Arbitrary strings cannot be reliably made
secret-free with key matching. v0 stores only constrained structural events.

## Migration Path

This is additive. Existing context output, tools and Plan judgments stay stable.
Ship capability detection before relying on new server/CLI combinations. Each
implementation PR carries the appropriate package changeset and English/Japanese
usage documentation. Development runtime collection remains explicitly enabled.
An eventual migration of a consumer requires fixture parity and its own review;
this RFC does not authorize changing current gate verdicts.

## Decision

The maintainer accepted the v0 scope, proposed interfaces and CLI-owned schema
on 2026-09-27, and explicitly shortened the standard discussion period.
Implementation proceeds in the four reviewable changes listed in section 1.

## Initial implementation measurements

On Bun 1.4.2, ten built-CLI invocations per command against the five-file
fixture in `packages/cli/tests/application-graph-fixture.ts` produced:

| Command | First invocation | Subsequent p50 | Subsequent p95 | JSON bytes |
| --- | ---: | ---: | ---: | ---: |
| context | 427 ms | 138 ms | 149 ms | 636 |
| graph | 278 ms | 246 ms | 294 ms | 3255 |

Reproduce with `bun scripts/benchmarks/application-graph.ts` after building.
Every sample starts a CLI process and its registration child. The operating
system's filesystem cache is not cleared, and context runs before graph; the
first invocation is not a controlled cold-disk benchmark. No application-wide
performance or adoption claim follows from this small fixture.

For comparable runs on this fixture, investigate graph p95 above three times
context p95 or above one second. Payload growth must follow added evidence,
and remain below the explicit transport limit.

The repeatable failed-request test checks that HTTP and MCP return the same
retained event and that a cursor does not replay it. A controlled agent repair
experiment (completion, time, manual copying, calls and cost) remains a rollout
measurement; no agent-effectiveness result is claimed by this implementation.

## M2 implementation notes

The maintainer continued the accepted roadmap on 2026-09-29. The Dev Center
at `/_guren` reuses `GUREN_MCP=1`, its production exclusion and peer/origin guard.
The CLI owns its bundled page and graph reader through an optional factory on
the existing server/CLI seam. Older CLIs keep the existing MCP endpoint.

The page reads `/_guren/graph.json` through the same fresh child as MCP and reads
`/_guren/runtime/errors?limit=100` without another collector. Concurrent graph
requests share only an in-flight scan; completed results are never cached.
Opening the page reads once; refresh buttons initiate subsequent reads. There
is no automatic polling or verification command execution. Failed reads clear
the previous display. Coverage, unresolved references and changed snapshots
remain visible; event correlation describes the runtime reading, not a claim
that the displayed graph snapshot existed when the exception occurred.

Docs and plans remain reachable through `/_guren/docs`, preserving its separate
`GUREN_DOCS=1` activation. All project-authored labels are rendered as text. The
shell has a script-hash CSP, disallows framing, and all Dev Center responses
use no-store caching. Route filtering and symbol navigation are presentation
operations over the shared graph, not another parser or verification system.

## M3 graph readers

Toward plan reader convergence, the remaining node kinds and relations adapt
readers other commands already use, with no new parser:

| Section | Reader |
| --- | --- |
| `middleware`, `usesMiddleware` | The manifest's registered aliases and groups, and each route's resolved chain (RFC 0026). |
| `validator` | Validator-file exports by AST, as `plan:status` reads them. |
| `validates` | Validate calls in controller bodies resolved through imports, and route contract schemas matched to validator exports by object identity in the graph child. |
| `policy`, `authorizes` | Policy discovery, and a policy class an action imports and names. |
| `test`, `tests` | `TestApp` request resolution, hung off the answering route as Impact does. |

Evidence stays honest. Inline middleware, gate calls (the `gate.policy()`
binding is made at boot), authorization middleware, schemas outside validator
files, and test requests the reader cannot resolve are `unresolved` entries
that leave their section partial. A request no route answers is listed but does
not narrow coverage. Without introspection, route-only sections are unavailable
and `validates`/`authorizes` keep their source half as partial. The graph child
learns it is a graph run from `GUREN_INTROSPECT_GRAPH=1`, not a positional
argument, and the graph-only fields (`bindingSources`, `contractSources`) are
absent from ordinary introspection.

### Plan source identity convergence

The first Plan adapter uses the shared static Controller and Validator graph
readings. `readControllerGraph()` produces file-scoped graph nodes and retains
the same action scan for Plan detail and Impact. `readValidatorGraph()` produces
schema-export nodes and retains the same export list for detailed field imports.
Neither adapter imports application code. Callers supply their own ParseCache,
including the graph loader's captured-source cache.

The Plan compatibility view preserves existing order and collision rules from
RFC 0030. Its class and action maps still resolve a same-named collision by scan
order, while the graph retains all file-scoped declarations. This convergence
does not silently repair that legacy rule: changing approval facts requires a
separate migration. Partial controller scans remain unreadable for Plan; graph
readers can retain successfully read nodes. Validator readers likewise preserve
their caller's complete-or-partial policy.

Parity tests compare reference checks, status, approval context hashes and
freshness against the prior projection, including modules, aliases, class-field
actions, name collisions, captured sources and unreadable files or directories.

The Model and Page adapters also share their graph readings. Model graph nodes
retain every named top-level class, while the Plan view selects only the file's
first class, including its rule that an anonymous first class contributes no
name. Parse failures still omit the model from Plan's existence view; a source
that cannot be read now reports an unreadable section instead of aborting the
whole load. This preserves Plan's distinction between syntax errors and
unavailable source bytes.

Page IDs come from one component-file discovery. The Plan view retains duplicate
`.tsx`/`.jsx` IDs, root scope and its entire `contracts` prefix exclusion. Its
existence checks include malformed component sources, while graph nodes require
a parsed component and report partial coverage for failures. Page prop detail
and model property detail keep their existing readers and policies.

Model/Page parity tests cover checks, status, approval hashes and freshness for
root and module plans, multiple classes, anonymous defaults, malformed sources,
duplicate page IDs and unreadable directories. Captured-cache tests exercise
both adapters without importing app code.

Policy and Resource filename identities now share `sourceClassIdentities()`.
The Plan existence sections and class detail share its names, module scopes and
relative paths. Impact uses the same Resource metadata for column consumers and
Policy metadata for its references; the graph uses it before checking Policy
ability support. A declaration with a different name does not change that
filename identity. Discovery order, barrel exclusions and source twins remain
caller-visible, including the graph's first-supported-twin rule. Directory
failures retain each caller's unreadable or partial reporting.

Policy abilities and Resource payloads retain their existing readers. Resource
payloads still follow codegen's declared-class and payload-type rules, which
are distinct from the filename-based existence view. No Resource node kind is
added to the public graph contract. Parity tests cover root/module Plan checks,
status, approval hashes, freshness, detailed abilities and Impact, plus graph
Policy identities and failure coverage.

Route identities now share `readRouteGraph()`: module, method, path, name and
occurrence determine the node ID, while registration order remains explicit.
The Plan existence projection uses those node endpoints, retaining its name
and uppercase-method conventions. Source routes stay attached by reference so
Plan detail keeps live Zod schemas and graph relations keep controller, model
and validator export identities. Schemas are never serialized into route nodes.

`readRoutesFileGraph()` preserves Plan's registrar selection, explicit `--routes`,
legitimately absent default, directory provenance, skipped-module warnings and
unreadable-error handling. Graph reads still come from the fresh registered app
child. These remain distinct evidence sources: a module's declared name may
differ from its directory, and a provider's route or a different app registrar
must not silently change an approved Plan's facts. Source authority convergence
would require its own approval migration; this slice shares identity projection.

Route parity tests cover Plan checks, detailed status, approval hashes and
freshness, duplicate and unnamed routes, live schema references, module scope,
registrar overrides, unavailable sources and registrar exceptions. Graph tests
compare node IDs and snapshot hashes against the previous projection and keep
fresh registered reads separate from Plan's registrar import-cache behavior.


Model detailed status and Impact share `readModelSources()` within one Plan
load. It retains `discoverParsedModels()`'s first declared class selection, module scope,
relationship and fillable metadata, and the list of non-barrel files that did
not yield a model. A source discovery/read failure invalidates the whole source
reading and preserves its reason; detailed status still gives the existence
section's unreadable verdict precedence. Standalone consumers read afresh, and
an existence-only load does not request detailed metadata. No model code is
imported, and the captured-cache graph identity reader remains unchanged.

Parity coverage compares detailed status, Impact, approval hashes and freshness,
including module/name collisions, multiple and anonymous classes, dynamic
fillable, malformed sources, barrels and unavailable directories or source
bytes. Combined reads share the same model metadata; the next standalone read
observes source edits.
