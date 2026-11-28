# RFC: Skills and Confirmation on the App MCP Endpoint, with a Direction for Tasks

**Author:** 7nohe
**Date:** 2026-11-25
**Status:** Accepted (2026-11-28; the deciding maintainer explicitly approved the
proposal and shortened the standard discussion period before implementation.)

## Problem

`@guren/plugin-mcp` serves an application's `.agent()` routes as MCP tools, and
since RFC 0038 the Inertia pages some of them render. On 2026-11-24 Anthropic
announced that Claude and Claude Code accept three more things from a server,
each defined by the open MCP specification or one of its extensions, and named
a fourth as coming:

| Feature | Defined by | Identifier | Announced status |
| --- | --- | --- | --- |
| Skills | Skills extension, SEP-2640 | `io.modelcontextprotocol/skills` | Public beta |
| Elicitation | Base protocol `2026-07-28` | `elicitation/create` inside an `input_required` result | Generally available |
| Tasks | Tasks extension, SEP-2663 | `io.modelcontextprotocol/tasks` | Generally available |
| File uploads | Experimental extension, no SEP yet | `io.modelcontextprotocol/files` | Rolling out later |

Each status comes with host conditions (client version, transport, plan, kind
of session) that Claude Code's documentation lists and this RFC does not
repeat. What matters here is that a Guren application can serve none of the
four, and that the first three map onto gaps the codebase already works around.

**The endpoint has no skill catalogue.** A tool carries a name, annotations,
an input schema, and a description and output schema when the route declares
them. How to combine `orders_show`, `refunds_store` and `customers_update` into
a refund that follows the shop's policy lives in the application's docs, where
the agent calling the tools never reads it. RFC 0016 §7 planned generated MCP
prompts and a `guren skill:export`; the endpoint serves neither. With the
Skills extension the server publishes a skill beside the tools, the host loads
it only when the model needs it, and it changes when the application deploys.

**The caller cannot be asked.** `destructiveHint: true` is an annotation a host
may or may not act on. `approval: 'required'` is enforced, but it asks a third
party: the call is refused with a request id, an approver is notified out of
band, and the agent calls again later. There is no way to ask the person in
front of the agent "delete 214 orders?" and continue the same call when they
say yes.

**Waiting takes the model's turns.** A pending approval comes back as an error
result that tells the agent to poll `guren_approval_status` and to repeat the
call with the same arguments once it reads `approved`. That works, and it costs
model turns for bookkeeping a host could do. A route that takes a minute has no
answer beyond holding the request open.

### What the SDK gives and what it does not

Read from the published packages:

- `@modelcontextprotocol/server` 2.4.0 (2026-10-23) adds `./ext/skills` and
  `./ext/skills/node`. `SkillsExtension.load(files)` builds a `SkillCatalog`
  whose `entries` are the wire `Skill` objects (digests, sizes, verbatim
  frontmatter). `memorySkillFiles()` and `nodeSkillFiles()` are the two storage
  adapters, and `attach(mcp: McpServer)` wires the methods. Problems it finds
  are warnings unless `strict` is set; storage failures always throw. The
  version this repository resolves, 2.3.1, has none of it.
- `attach()` takes the high-level `McpServer` and is marked `@experimental`.
  `createAppMcpServer()` builds the low-level `Server` on purpose (RFC 0016
  §3.2), and registers `resources/list` and `resources/read` itself when a tool
  declares `ui`.
- The three-argument `setRequestHandler(method, { params, result }, handler)`
  registers a method the SDK does not know. It needs a runtime schema for
  `params`. The cache fields the SDK adds to its own list methods are not added
  to a custom one.
- 2.3.1 already carries the multi-round-trip surface elicitation rides on in
  `2026-07-28`: `inputRequired()`, `inputRequired.elicit()`,
  `acceptedContent()`, `ctx.mcpReq.inputResponses`, `ServerOptions.requestState`
  and `createRequestStateCodec()`.
- Neither version has a server half for the Tasks extension. `tools/call` is
  among the methods allowed a `resultType` other than `complete`, but its
  result still passes the `tools/call` result schema, which expects `content`.
  The SDK's `tasks/get | tasks/result | tasks/list | tasks/cancel` types are
  the `2025-11-25` experiment. `@modelcontextprotocol/ext-tasks` 0.2.3 is a
  requester package with a `2025-11-25` receiver; its `core/v2` entry exports
  the generated wire schemas and nothing that stores or runs a task.

### Prior art

- **Laravel MCP** registers skill directories on the server class
  (`protected array $skills = ['skills/code-review', …]`). The extension's
  implementation list marks it in progress (laravel/mcp#410).
- **xmcp** serves `src/skills/` by default since 1.10.0: a directory
  convention with no registration.
- **Cloudflare's API MCP server** serves full manifests and does not declare
  `directoryRead`. Salesforce's B2C DX server and Tableau's ship without it
  too.
- **Capgo** and the FastMCP gateway add `list_skills` / `read_skill` tools for
  clients without the extension.

## Proposed Solution

Accepting this RFC accepts two phases. Tasks (§3) and file uploads (§4) are
recorded as directions with the reasons they are not phases yet.

| | Adds | New persistent state |
| --- | --- | --- |
| Phase 1. Skills | `resources/skills/`, a generated module, `mcpPlugin({ skills })`, `skills/list`, `skills/get` | None |
| Phase 2. Confirmation | `.agent({ confirm })`, an `input_required` answer on `tools/call` | None (signed `requestState`) |
| Direction. Tasks | Requirements for a later RFC | To be designed |
| Direction. File uploads | A mapping onto attachments | To be designed |

### 1. Skills

#### 1.1 Where a skill lives

```
resources/skills/
  refunds/
    SKILL.md
    references/policy.md
modules/billing/resources/skills/
  dunning/
    SKILL.md
```

A skill is a directory holding a `SKILL.md`, in the format the
[Agent Skills specification](https://agentskills.io/specification) defines:
YAML frontmatter with at least `name` and `description`, `name` equal to the
directory name. The extension delegates the format entirely, and so does this
RFC.

A root skill is served at `skill://refunds/SKILL.md`. A module's skill takes
the module's name as its organizational prefix,
`skill://billing/dunning/SKILL.md`, which the extension allows ("preceding
segments are a server-chosen organizational prefix").

The two namespaces must stay disjoint, since the extension treats a `SKILL.md`
below another skill's directory as a nested skill whose files belong to the
enclosing one. Two rules, both failures in `guren check` (§1.6):

- A root skill may not carry the name of a module that has skills.
- A skill directory may not contain another `SKILL.md`. Nested skills are not
  supported in this phase.

These are skills for the agents of the application's *users*. They are
unrelated to `.claude/skills/`, which the agent harness installs for the
developer's own coding agent.

`resources/skills/` was chosen over `app/Mcp/Skills/` before phase 1 (Open
Question 1).

#### 1.2 A generated module

`guren codegen` writes `.guren/mcp-skills.gen.ts`:

```ts
// .guren/mcp-skills.gen.ts (generated)
export const files: Readonly<Record<string, string>> = {
  'refunds/SKILL.md': '---\nname: refunds\ndescription: …\n---\n…',
  'refunds/references/policy.md': '…',
  'billing/dunning/SKILL.md': '…',
}

/** Files that are not valid UTF-8, base64. */
export const binary: Readonly<Record<string, string>> = {}
```

The two exports are annotated rather than `as const`: nothing reads a key or a
file's text as a type, and a literal type per file is weight the application's
typecheck would carry for no reader.

Codegen publishes every regular file below a directory that holds a regular
`SKILL.md` at its top. It reads no dotfile or dot directory and follows no
symlink, the skills directory's own included, so nothing outside the directory
is published through a link. A directory with no `SKILL.md` of its own is not
read at all. It warns about a manifest spelled in another case and about a
`SKILL.md` below another skill's directory, and still writes the module: the
endpoint's refusal at boot (§1.4) is what stops the second.

It is written when at least one `SKILL.md` exists, or when the application's
source names the module, and it is never deleted: with no skill it is written
with empty objects, so the `import()` the application configures resolves on a
checkout whose `.guren/` is git-ignored and whose last skill was removed. RFC
0038 keeps an empty `.guren/mcp-app/index.gen.ts` for the same reason.

The keys are paths under the skill namespace, which is the shape
`memorySkillFiles()` takes. The module holds file contents only. Digests, sizes
and the parsed frontmatter are computed by the SDK when the catalog is built
(§1.4), so the code that hashes a file and reads its frontmatter is the
reference implementation and never a second one in the CLI.

Reading the directories from disk at boot does not survive the deploy targets.
A Workers, Lambda or Vercel bundle has no application directory to read. The
Docker recipe copies `modules/` and `.guren/` into the production stage and not
the top-level `resources/`, so a container would serve module skills and lose
root ones. `ui: { pages: () => import('@/.guren/mcp-app/index.gen') }` solved
the same problem for RFC 0038. The Vite plugin adds the skills directories to
the paths that trigger codegen.

#### 1.3 Configuration

```ts
// config/mcp.ts
mcpPlugin({
  skills: {
    files: () => import('@/.guren/mcp-skills.gen'),
  },
})
```

```ts
export interface McpSkillsConfig {
  /** The generated module. Loaded once per plugin registration, at boot. */
  files: () => Promise<{
    files: Readonly<Record<string, string>>
    binary: Readonly<Record<string, string>>
  }>
}
```

Without `skills`, the endpoint advertises exactly what it does today.

#### 1.4 What the endpoint serves

**The catalog.** Built at boot, where the plugin already awaits `loadUi()`,
once per plugin registration and never in a module-level variable: two
applications in one process (as under `bun test`) must not share one.
`SkillsExtension.load(memorySkillFiles(…))` runs without `strict`, each warning
goes to `console.warn` once with the plugin's prefix, and a load that throws
fails the boot with the file it names. `skills/list`, `skills/get` and file
reads all answer from that one snapshot, so an entry and the bytes behind it
cannot disagree.

**The handlers.** `createAppMcpServer()`:

- declares `resources: {}` and merges
  `'io.modelcontextprotocol/skills': {}` into `extensions`, beside the MCP Apps
  identifier when both apply. `directoryRead` is not declared.
- registers `skills/list` and `skills/get` through the three-argument
  `setRequestHandler`, with a params schema for each. The results are the
  extension's shapes: `skills` or `skill`, `ttlMs`, `cacheScope`, and
  `resultType: 'complete'` on the wire. `skills/list` pages at 100 with an
  opaque cursor. `skills/get` for a URI that names no skill answers `-32602`.
- registers `resources/list` and `resources/read` when the application has
  skills *or* a `ui` tool, where today it does so only for the latter.
  `skill://` reads come from the catalog's snapshot; an unknown file answers
  `-32602`. `ui://` reads keep their per-caller scope check unchanged.
- lists each `SKILL.md`, and no supporting file, in `resources/list`, with
  `mimeType: 'text/markdown'` and the frontmatter's `name` and `description`.

**Caching.** `ttlMs: 0` and `cacheScope: 'private'`, fixed. The endpoint is
authenticated, the SDK's cache hints say nothing about partitioning by
credential, and a host that reads a skill once per session loses little.
Positive freshness waits for a design that says what a revoked token's cache
entry is worth.

**Protocol eras.** The extension is specified against `2026-07-28`. On a
request of that era the capability is declared and the two methods answer. On
the `2025` era neither happens, and `skill://` files remain readable as
ordinary resources. How the per-request factory learns the era is Open
Question 2, and `protocol-eras.test.ts` gains a case for each.

All skill reads take from the same read budget as `ui://` resources and
`guren_approval_status` (`takeReadBudget`), since none of them enters the
invocation pipeline.

`attach()` is not used. It wants an `McpServer`, registers its own resource
template through it, and throws on a server that already handles one of the
skills methods.

#### 1.5 Who sees a skill

Every authenticated caller of the endpoint sees every skill, including the
names of tools a skill mentions. That is deliberate: a skill is static text the
application's author wrote for all of its users, and it grants nothing. The
tools are still filtered per token by `gateToolCall`, so a skill can describe a
call its reader's token will be refused.

The guide states the two consequences. Whatever is in a skills directory is
published to the endpoint's whole token population. And a skill must not be the
only place a rule is enforced.

Per-scope visibility is a follow-up, not a default that happens to be missing:
it makes the listing per caller, which the fixed `private` cache scope already
allows for.

#### 1.6 CLI

```bash
bunx guren make:mcp-skill refunds --description "Process a refund per shop policy"
bunx guren make:mcp-skill dunning --module billing
```

`make:mcp-skill` writes `SKILL.md` with the frontmatter filled in, both values
quoted since a valid name such as `no` or `123` is another type to YAML, and prints
the `skills` line to add when it can establish that the `mcpPlugin()` call
lacks one. It is a single-file generator, registered in `PLAN_COMMAND_CLASSES`
and `PLAN_GENERATOR_TARGETS`, and in `plan/command-files.ts` among the
generators whose output no source-file declaration can coincide with, as
`make:adr` is: a `SKILL.md` is published text, so a change that adds one stays
for a person to read.

`guren check` gains a content-activated group, silent for an app with no skill,
no generated module and no import of one:

| Key | Severity | Condition |
| --- | --- | --- |
| `mcp-skill-frontmatter:<path>` | fail | The catalog refuses the skill: no frontmatter, no `name`, no `description`, or `name` differs from the directory |
| `mcp-skill-manifest:<path>` | fail | A directory's manifest is spelled in another case (`skill.md`), so it is not published |
| `mcp-skill-namespace:<path>` | fail | A root skill named like a module that has skills, or a `SKILL.md` below another skill |
| `mcp-skill-limit:<path>` | fail | More than 512 files or 16 MiB in one skill |
| `mcp-skills-stale` | fail, `fix: codegen` | `.guren/mcp-skills.gen.ts` is missing or differs from what codegen would write, a module still holding deleted skills included |
| `mcp-skills-unserved` | warn | Skills exist and the `mcpPlugin()` call, read whole, carries no `skills` |
| `mcp-skill-host-limit:<path>` | warn, advisory | A text file over 100 KB, a skill over 400 KB, or more than 100 skills |

`mcp-skill-frontmatter` is not a reading of the frontmatter by the CLI. The
check hands the contents codegen publishes to `SkillsExtension.load()`, from the
SDK `@guren/cli` already depends on, and reports what it refuses, so the verdict
is the one the endpoint reaches at boot (§1.4). The SDK's own size limits are
lifted for that call, since `mcp-skill-limit` judges them and a skill over them
is still served.

The 512-file and 16 MiB figures are what the extension requires every host to
accept and recommends servers stay under; failing on them is Guren's
publication policy. The last row restates what Claude Code documents (the size
limits for skills it scans, the count per server) and is advisory because those
move without this repository knowing. `mcp-skills-unserved` is reported as
unverifiable, never as a pass, when `plugin-calls.ts` cannot read the call
whole (a spread, a computed key).

`guren audit`'s secrets scan reads `.ts` and `.js` sources today. This phase
adds the files codegen publishes, found by the same discovery, to that scan. It
is a heuristic over text, and it does not replace reading what a skills
directory holds before deploying it.

`guren tool:list` prints the skills under the tools, including for an app that
has skills and no tools, and `--json` carries them as `skills`. It lists what
that same catalog call would serve from the files on disk, with what it
refused as warnings; whether `mcpPlugin()` is given the module is the check's
to say.

### 2. Confirmation by elicitation

#### 2.1 Declaration

```ts
router
  .delete('/orders', [OrderController, 'destroyMany'])
  .name('orders.destroyMany')
  .agent({ destructiveHint: true, confirm: true })

router
  .post('/projects', [ProjectController, 'store'])
  .name('projects.store')
  .agent({ confirm: { message: 'This creates a paid project.' } })
```

```ts
export interface AgentRouteMetadata {
  // …existing fields
  /**
   * Ask the calling user before the call runs. A surface that cannot ask
   * refuses the call.
   */
  confirm?: true | { message?: string }
}
```

`confirm` and `approval: 'required'` answer different questions and may both
be set. Confirmation asks the person the agent is working for, in their
client, now. Approval asks someone the application chose, elsewhere, later.

#### 2.2 In the pipeline

Confirmation is a pipeline step, so its position is one guarantee for every
surface built on `createAgentInvocationPipeline`:

```
scope gate → interposition (rate limit) → confirmation → approval → dispatch
```

A call that needs confirmation and does not carry one is a **denial**, with a
new reason and the question attached:

```ts
export type AgentToolDenialReason = 'auth' | 'scope' | 'approval' | 'rate-limit' | 'confirmation'

export interface AgentInvocationDenial {
  // …existing fields
  /** Present when `reason` is `'confirmation'`: what a surface may ask. */
  confirmation?: AgentConfirmationRequest
}

export interface AgentConfirmationRequest {
  tool: string
  /** The route's message, else `Run "<toolName>"?`. */
  message: string
  /** The call's arguments after the tool's `redact` rules, for display. */
  input: Record<string, unknown>
  /** `agentApprovalFingerprint` of the raw arguments. */
  fingerprint: string
}

export interface AgentInvocation {
  // …existing fields
  /** The fingerprint a surface obtained a confirmation for. */
  confirmed?: string
}
```

A denial is the shape that fails closed everywhere without a change. In-process
agents (`appTools()`), durable agents and the MCP Apps bridge already turn any
denial into a refusal; a surface that knows how to ask reads `confirmation` and
does. A new result status would have been read as "executed" by every caller
that tests for `failed` and `denied` and falls through.

Before it denies, the step runs the rehearsal `guren_preflight` runs (the
route's middleware and validation, never its action). A call that would be
refused there is refused with that reason and no question, so a malformed call
does not put a prompt in front of a person. Refused means a 4xx or 5xx, or a
request that cannot be built. Any other answer is asked about, a middleware's
own 2xx or 3xx included: returning it would hand a result to a caller nobody
asked. What the rehearsal cannot see still runs after the answer: the action's
own authorization may refuse a confirmed call.

A rehearsal requested by the caller (`preflight: true`) skips the step, as it
skips approval. `guren_preflight`'s verdict gains `confirmation: 'required'`
in its advertised output schema, with a description saying `allowed` covers the
rehearsal only.

#### 2.3 On the MCP surface

The server is constructed with `requestState: { verify: codec.verify }`. On a
`confirmation` denial, `tools/call` answers with the `2026-07-28`
multi-round-trip result:

```ts
const answer = z.object({ confirm: z.boolean() })

return inputRequired({
  inputRequests: {
    confirm: inputRequired.elicit({
      message: describe(request), // the message plus the redacted arguments, bounded
      requestedSchema: answer,
    }),
  },
  requestState: await codec.mint({ tool: request.tool, fingerprint: request.fingerprint }, ctx),
})
```

The client shows the form and repeats the same `tools/call` with
`inputResponses` and the `requestState` it was handed. A state that fails
verification never reaches the handler: the SDK answers `-32602`. On a retry
that does, the handler requires both of:

1. The decoded state (`ctx.mcpReq.requestState<T>()`) names this tool and the
   fingerprint of this retry's arguments.
2. `acceptedContent(ctx.mcpReq.inputResponses, 'confirm', answer)` is
   `{ confirm: true }`.

Then it calls `pipeline.invoke({ tool, args, confirmed: fingerprint })`. A
declined or cancelled form, or `confirm: false`, ends the call as a
`confirmation` denial. A retry whose arguments changed is refused; the changed
call starts over and is asked about again.

The codec is `createRequestStateCodec({ key, bind })`. The key is derived from
the application key (`hmac()` over a fixed label). `bind` returns the principal
key, the method and the endpoint's path, so a state minted for one caller, or
by another application sharing the key, does not verify. Nothing is stored, and
any instance can verify what another minted. Rotating the application key
invalidates confirmations in flight, a ten-minute window.

**What this does and does not establish.**

- The answer comes from the client. A host that fabricates `inputResponses`
  passes check 2, and check 1 only proves the server asked about these exact
  arguments within the last ten minutes. Elicitation is a promise from a
  cooperating host that a person saw the question. It is not authorization: a
  call its caller must not be able to approve stays on `approval: 'required'`.
- A confirmation is not single-use. Within its ten minutes the same state and
  answer verify again, so a host that repeats the retry runs the call twice.
  Making it single-use needs a store on every deployment for a property only a
  misbehaving host violates, and that host can fabricate the answer anyway.
- With `approval: 'required'` on the same route, the person is asked on each
  call: once before the request is queued, and again when the agent repeats the
  call after approval, which may be an hour later.

The guide says the first point in its opening paragraph.

**Audit.** The challenge is recorded as `AgentToolDenied` with reason
`confirmation`, and so is a declined answer. A state the SDK rejects before the
handler runs is not recorded, since no tool was resolved. Neither the signed
state nor the form payload is written to the trail. A declined answer never
enters the pipeline, so the endpoint writes that record itself and meters the
answer as a read.

#### 2.4 A client that cannot be asked

The question is sent only on a `2026-07-28` request whose client capabilities
include form-mode elicitation, spelled `elicitation: { form: {} }` or the bare
`elicitation: {}`. A client that declares URL mode only, or no elicitation, is
refused with the `confirmation` denial and a message naming the capability.

Every request on the `2025` era is refused the same way. That is a property of
this endpoint, which builds a stateless server per request and so cannot send
the server-to-client request elicitation is on that era; it says nothing about
whether the client could have answered.

The tool stays listed in both cases. Running the call instead would make
`confirm` a setting that silently stops applying. An author who prefers reach
over the prompt removes `confirm`.

#### 2.5 Every surface

| Surface | Path | With `confirm` |
| --- | --- | --- |
| App MCP endpoint | Pipeline | Asks (§2.3), or refuses (§2.4) |
| In-process agents (`appTools()`) | Pipeline | Refused |
| Durable agents (`@guren/plugin-agents`) | Pipeline | Refused |
| MCP Apps views | Pipeline, through the endpoint | As the endpoint; a refusal settles the view's visit as `denied` with reason `confirmation` |
| `guren tool:call` | Its own `buildToolRequest` and `app.fetch` | Prompts on a TTY; otherwise refuses unless `--confirm` is passed |
| `TestApp.agent().call()` | Its own `buildToolRequest` and the app's dispatch | Throws unless the test passes `{ confirm: true }` |
| WebMCP | The browser fetches the route | The tool is not registered, and the route answers a `webmcp` request with 403 |

Three of these do not pass through the pipeline, so each needs its own change:

- `guren tool:call` checks `tool.confirm` before it dispatches.
- `TestApp.agent().call()` does the same, so a test cannot show a call
  succeeding that every agent surface would ask about or refuse.
- `deriveAgentTools` resolves `expose.webMcp` to `false` for a tool that
  declares `confirm`, whatever the route says. The WebMCP client already skips
  a tool that is not exposed, so a client built before this RFC skips it too,
  and no version of the client has to learn the field for the guarantee to
  hold. A page loaded before `confirm` was declared still holds the tool, so
  the route itself refuses a request announcing the `webmcp` surface. `guren
  check` warns when a route sets both `confirm` and `expose: { webMcp: true }`.

A person to ask on behalf of an in-process or durable agent is a follow-up
(Open Question 5). URL-mode elicitation, for a step that must happen in a
browser such as a payment, is not part of this phase.

### 3. Tasks: a direction

An approval-gated call is the natural first task: the host would poll instead
of the model, and the result would arrive without a second call. The draft of
this RFC proposed exactly that, with the server running the approved call on
the first `tasks/get` after approval. That design does not hold, and what
replaces it is large enough to be its own RFC.

**Why not run on a poll.** The extension separates reads from writes so that
`tasks/get` stays idempotent and cacheable. A status read that performs a
mutation breaks that, an approved task never runs if the client stops polling,
and a slow route holds the poll open. Execution has to be scheduled when the
approval resolves, or when a long-running call is accepted, by something that
outlives the request. So approval tasks and long-running routes are one design
with one prerequisite, a durable worker, and not two.

**What the later RFC has to settle.**

1. *Execution.* A queue job runs the call. `tasks/get` reads a record and
   nothing else. What a Workers deployment without a queue binding does.
2. *One spend.* A single atomic transition that claims the task and consumes
   its exact approval, so that the ordinary retry path cannot spend an approval
   a task owns, and cancellation, expiry and a crash between dispatch and
   completion each have a defined outcome.
3. *Authority at execution time.* The worker runs later, without the caller's
   request. Captured abilities would outlive a revoked token. The call has to
   be authorized again through the pipeline against the credential's current
   state, and fail terminally when that is gone, including under
   `auth: 'external'`.
4. *Arguments at rest.* `AgentApprovalRequest.input` is redacted and
   `fingerprint` is a hash, on purpose: RFC 0016 kept the approval store from
   becoming "a second place secrets live". A worker needs the raw arguments.
   Whether an encrypted, short-lived copy is acceptable is the first question
   that RFC opens with.
5. *The record.* Explicit task states, a handle returned only once the record
   is durably readable, results kept for an hour or more independent of the
   approval's expiry, and `ttlMs` computed from that.
6. *The protocol.* The capability check on every task method, the SEP-2663
   envelopes, the same answer for a foreign id as for an unknown one, and a
   task answer the SDK emits unmodified (it currently applies the `tools/call`
   result schema), verified with the extension's conformance scenarios.
7. *Confirmation.* A route that declares both completes the elicitation before
   a handle is returned.

Until then nothing changes: an approval-gated call is refused with its request
id, and `guren_approval_status` reports on it.

### 4. File uploads: a direction

The extension is a working-group draft with open questions of its own, has not
been proposed as a SEP, and has not rolled out in Claude. Nothing is built for
it under this RFC.

What a later RFC starts from:

- `x-mcp-file` marks an object-shaped file argument in a tool's input schema.
  A route's body schema has no such field today, and `buildToolRequest` sends
  JSON, so a route that takes a multipart file needs an adapter either way.
- The draft allows three transfers: bytes inline in the call, an upload to a
  path on the server itself, and an upload to a storage URL. Only the last
  needs presigned direct uploads, which RFC 0013 deferred.
- A download target must serve bytes directly. Clients are required to treat a
  redirect as a failed transfer, so RFC 0015's delivery route in its `redirect`
  mode does not qualify; its proxy mode does.

### 5. Packages and versions

| Package | Change | Bump |
| --- | --- | --- |
| `@guren/plugin-mcp` | `skills`; the `input_required` answer; `@modelcontextprotocol/server` range raised from `^2.0.0` to `^2.4.0` | minor per phase |
| `@guren/server` | `confirm` on `AgentRouteMetadata`; the `confirmation` denial reason and its request; `expose.webMcp` resolved to `false` for a `confirm` tool | minor |
| `@guren/core` | Re-exports the above through `export *` | minor |
| `@guren/cli` | Skills codegen, `make:mcp-skill`, the check group, the audit scan, `tool:list` output, `tool:call --confirm` | minor |

The workspace root resolves the SDK from `^2.3.1`; phase 1 raises that and the
lockfile with it.

`AgentToolDenialReason` gains a member. Code keyed on it exhaustively stops
compiling until it names `'confirmation'`; in this repository that is the
audit record's `DENIAL_REASONS` table. The changeset says so.

## Alternatives Considered

**Read skills from disk with `loadSkills()`.** One line, and what the SDK's
example does. It fails on every bundled deploy target and loses root skills in
a container (§1.2).

**Use `McpServer` and `skills.attach()`.** It would hand the handlers, the
resource template and the capability declaration to the SDK. It also reverses
RFC 0016 §3.2 for the whole endpoint, collides with the endpoint's own
`resources/read`, and rests on wiring the SDK marks experimental. Worth
revisiting once `attach()` accepts a low-level `Server`.

**Compute digests in codegen.** Entries would be static data. A host compares
the entry's `frontmatter` field by field against its own parse of the
`SKILL.md` and refuses the skill on any difference, so the CLI's YAML-subset
reader would be a second frontmatter parser whose every disagreement with the
SDK's is a skill that silently fails to load.

**Mirror skills as tools** (`list_skills`, `read_skill`) for clients without
the extension. Two more reserved tool names in every catalogue, for hosts that
can already read `skill://` files as resources. Open Question 4.

**Generate a skill from the route manifest** (RFC 0016's `skill:export`). The
tool list is per token, so a generated skill is either per caller (digests
computed per request, or `resources: "dynamic"`, which hosts may refuse to
load) or leaks the names of tools the caller cannot list. Open Question 3.

**A `cacheHint` option.** Dropped from the first draft: `cacheScope: 'public'`
on an authenticated endpoint is a mistake the option would only make
reachable.

**Confirmation as a fourth invocation result.** See §2.2. It reads as
"executed" to code written before it existed.

**A single-use confirmation.** See §2.3.

**Turn `destructiveHint: true` into confirmation automatically.** It would
change every existing destructive tool on upgrade and refuse them all on
clients without elicitation. `confirm` is opt-in per route.

**Fall through when the client cannot be asked.** See §2.4.

**Reuse the approval queue for confirmation**, auto-approving when the caller
confirms. It would write a record and notify approvers for a question the
caller answers in seconds, and would let a caller approve its own request,
which is the one thing the queue exists to prevent.

**Run an approved call on the next `tasks/get`.** See §3.

## Migration Path

Additive. An application that changes nothing declares the same capabilities
and gives the same answers, on both protocol eras, which
`protocol-eras.test.ts` asserts before and after.

- `@guren/plugin-mcp` requires `@modelcontextprotocol/server` 2.4.0 or later.
  An application that pins the SDK itself raises the pin.
- Adopting skills: create `resources/skills/<name>/SKILL.md`, run
  `guren codegen`, add `skills` to `mcpPlugin()`.
- Adopting `confirm`: add it to a route. From then on the tool is refused to
  clients on the `2025` era and to clients that do not declare form-mode
  elicitation, is no longer registered over WebMCP, and is refused to
  in-process and durable agents.

No deprecation.

## Open Questions

Needed before phase 1:

1. ~~**Where skills live.** `resources/skills/` sits beside `resources/js/` and
   reads as frontend. `app/Mcp/Skills/` is the alternative. The namespace rules
   of §1.1 hold either way.~~
   **Decided before phase 1: `resources/skills/`.** A skill is prose, and `app/`
   is what lint, the architecture check and the Docker recipe treat as code. A
   module keeps the same shape at `modules/<name>/resources/skills/`.
2. ~~**Learning the protocol era in the per-request factory**, so the Skills
   capability and methods exist on `2026-07-28` requests only.~~
   **Resolved in implementation.** The SDK hands the factory the era
   (`McpRequestContext.era`, `'legacy' | 'modern'`), which `createAppMcpServer()`
   takes as its second argument.

Follow-ups that do not block either phase:

3. **A generated skill** derived from the caller's own tool list, with
   per-request digests or as `"dynamic"`.
4. **Mirror tools** for clients without the Skills extension.
5. **A confirmer for in-process and durable agents**, which have no person to
   ask.
6. **`directoryRead`**, if a host turns out to need
   `resources/directory/read` despite a complete manifest.
7. **A size cap in codegen**, below the 16 MiB per skill, given that the
   module lands in the server bundle.

To measure during phase 1:

8. **The cost of `ext/skills` on Workers**: bundle size on a packed tarball,
   as `wrangler-bundle.test.ts` does, and the time the catalog adds to a cold
   start.
   **Measured in implementation, outside workerd.** Bundled with esbuild 0.28.1
   under the `workerd` conditions, minified with `keepNames`, importing
   `SkillsExtension` and `memorySkillFiles` beside `Server` and
   `createMcpHandler` adds 34.7 kB (12.9 kB gzipped) to 342.4 kB (92.5 kB).
   `SkillsExtension.load()` over an in-memory record took a median of 1.2 ms
   for 10 skills in 30 files (120 kB) and 8.7 ms for 100 skills in 400 files
   (1.6 MB), on Bun 1.4.5 and Apple silicon. Both numbers come from an
   SDK-only fixture; the plugin's own bundle through wrangler, and the cold
   start on workerd itself, remain to be measured.
