# Agent Interface

AI agents call applications over MCP. Guren does not ask you to write a second
application for them: an agent tool is **derived from the contracts a route
already carries**. The route's `params`, `query` and `body` schemas become the
tool's input schema, its `output` schema becomes the tool's output schema, and
the policy its middleware chain checks becomes the tool's authorization.

There is no tool class to write and no second JSON Schema to keep in sync. A
tool cannot advertise a shape the endpoint does not validate, because there is
only one shape — and when a tool is called, the call re-enters your application
as a real HTTP request, so validation, middleware and policies run exactly
once, in the place they already run.

Exposure is opt-in per route. Nothing becomes a tool until you say so.

```ts
// routes/web.ts
import { Router, authorizeMiddleware } from '@guren/core'
import { PostController } from '@/app/Http/Controllers/PostController'
import { CreatePostSchema, PostListSchema, PostSchema } from '@/app/Http/Validators/PostValidator'

export function registerWebRoutes(router: Router): void {
  router
    .get('/posts', { output: PostListSchema }, [PostController, 'index'])
    .name('posts.index')
    .agent({ description: 'List published posts, newest first.' })

  router
    .post('/posts', { body: CreatePostSchema, output: PostSchema }, [PostController, 'store'])
    .name('posts.store')
    .middleware(authorizeMiddleware('create'))
    .agent({ description: 'Create a blog post as the authenticated user.' })
}
```

That is the whole change to the application. Everything below is about seeing
what it produced, serving it, and locking it down.

## Seeing what an agent sees

```bash
bunx guren tool:list
```

```
Tool        | Method | Path   | MCP | WebMCP | Auth   | Annotations
-----------------------------------------------------------------------------
posts.index | GET    | /posts | yes | yes    | -      | read-only, idempotent
posts.store | POST   | /posts | yes | yes    | create | destructive

Total: 2 tools
```

`tool:inspect` shows one tool's whole derivation — the merged input, the output
schema, the authorization ability, the annotations, and any warning that
applies to that tool:

```bash
bunx guren tool:inspect posts.store
```

```
posts.store  POST /posts
Description:   Create a blog post as the authenticated user.
Exposure:      mcp=yes webMcp=yes
Annotations:   destructive
Authorization: create

Input
  title: string
  body: string

Output
{
  "type": "object",
  "properties": {
    "id": { "type": "number" },
    "title": { "type": "string" }
  },
  "required": ["id", "title"]
}
```

Both commands derive live from your route graph rather than reading a
generated file, so they answer correctly even when `.guren/agents.gen.ts` is
missing or stale. Pass `--json` to either for the raw derivation.

`bunx guren codegen` writes the same derivation to `.guren/agents.gen.ts` for
apps that expose at least one tool, and removes the file for apps that expose
none. See [CLI — Agent Tool Commands](./cli.md#agent-tool-commands).

## Calling a tool yourself

`tool:list` describes the surface. `tool:call` uses it — no MCP client, no
token, no running server:

```bash
bunx guren tool:call posts.store --input '{"title":"Hello agents"}'
```

```
posts.store  POST /posts
Status:   201

Result
{
  "id": 1,
  "title": "Hello agents"
}
```

The command boots your application and dispatches through the same contract an
MCP client's call goes through: the tool is found by `deriveAgentTools`, the
HTTP request is rebuilt by the framework's dispatcher, and the response is
mapped back the same way. There is no CLI-only code path for any of that, so
the tool a call resolves to, the request it becomes, and the result you read
are what an agent gets.

What differs is how the caller proves who it is. An MCP client presents a
bearer token, which is scope-checked before the request is built and which
skips CSRF verification because it carries no cookies; `tool:call`
authenticates with `--as` and fetches a CSRF token the way a browser does. So
a green `tool:call` run tells you the tool works, not that a particular token
is scoped to reach it: `guren token:issue` is where that is decided.

Its tools come from the **booted** app's route graph, which is why there is no
`--routes` flag: a routes file cannot change what the running app serves, and a
tool you could name but not reach would be worse than no flag at all. Use
`--app <dir>` to point at an application root that is not the current
directory.

An unknown name answers with the names that exist, and a call that fails
reports the application's own failure and exits non-zero:

```bash
bunx guren tool:call posts.store --input '{"title":"no"}' --json
```

```json
{
  "tool": "posts.store",
  "method": "POST",
  "path": "/posts",
  "status": 422,
  "isError": true,
  "content": "{\"errors\":{\"title\":\"Too small: expected string to have >=3 characters\"}}"
}
```

### `--as` bypasses authentication

`--as user:42` runs the call as that user. It works by setting `GUREN_TESTING=1`
for the process, which makes the app accept an injected user instead of a real
credential — the same mechanism `@guren/testing` uses. The command says so every
time it is passed.

This is a development flag on the same trust boundary as `bunx guren console`:
it assumes whoever runs it can already execute code in this project. Never run
it against a shared or production database.

### `--preflight` rehearses a call

```bash
bunx guren tool:call posts.store --input '{"title":"Rehearsal"}' --preflight
```

```
posts.store  POST /posts
Status:   200

Preflight  allowed (the handler did not run)
Validated: body
Unverified: authorization

Preflight only: the request passed this route's middleware and its body schema.
The handler did not run, so nothing was created, changed, or deleted. No
authorization middleware was found on this route, so any check inside the
handler itself was not evaluated.
```

The request runs the route's middleware and validates the contract the tool
advertises, then stops before the handler. `unverified` names what a real call
would still evaluate — a route that authorizes inside its action is a check this
seam structurally cannot reach.

The MCP endpoint does not offer preflight. A tool that advertises an
`outputSchema` must answer with `structuredContent` conforming to it, and a
verdict conforms to no route's output; `tool:call` and `@guren/testing` are not
bound by that rule, so they offer what the seam supports.

## Testing a tool

`app.agent()` calls the tools of an app under test, through the same dispatch:

```ts
import { TestApp } from '@guren/testing'

const app = await TestApp.create({ routes: registerWebRoutes })

const result = await app.agent().call('posts.store', { title: 'Hello' }, { as: user })
result.assertOk()

const post = result.assertStructured<{ id: number; title: string }>()
expect(post.title).toBe('Hello')
```

Assertions chain on the pending call as well, like every other `TestApp`
request:

```ts
await app.agent().call('posts.index').assertOk()
await app.agent().call('posts.store', { title: 'no' }).assertStatus(422)
await app.agent().call('secret.show').assertDenied()
```

| Assertion | Passes when |
|-----------|-------------|
| `assertOk()` | the call did not come back as an error result (any 2xx/3xx status) |
| `assertStatus(code)` | the dispatch resolved to exactly that HTTP status |
| `assertDenied()` | the application answered `401` or `403` |
| `assertStructured<T>()` | the tool advertises an object output schema and returned one — awaited, it returns the payload |

`await app.agent().tools()` lists the tools the app exposes, exactly as
`tool:list` derives them.

Three things worth knowing:

- **`{ as: user }` is `actingAs(user)`,** the `X-Testing-User` envelope. There
  is no token here, so `assertDenied()` means "the application refused" — its
  authentication or its policies. Bearer scopes belong to the MCP endpoint and
  are not reachable from a test.
- **Mount CSRF or skip it, deliberately.** A dispatched tool call carries no
  cookie and no bearer, so an app created with `auth` refuses a mutating call
  with `403` before any policy is consulted — which `assertDenied()` cannot tell
  apart from a policy refusal. Dispatch through
  `(await app.withCsrf()).agent()`, or test against an app that mounts no CSRF.
- **The app must carry a route graph.** `TestApp.create({ routes })` and
  `TestApp.fromApp(app)` do; `TestApp.fromFetch()` and `TestApp.fromWorkers()`
  are handed a bare fetch function and have none, so `agent()` says which
  constructor to use rather than reporting an empty tool list.

`{ preflight: true }` works here too, and answers the same verdict:

```ts
const result = await app.agent().call('posts.store', { title: 'x' }, { preflight: true })
result.assertOk()
expect(result.json<{ allowed: boolean }>().allowed).toBe(true)
```

## Declaring `.agent()`

Two spellings, and they are equivalent. Use whichever reads better beside the
rest of the route:

```ts
// Fluent, after the route is registered
router
  .post('/posts', { body: CreatePostSchema }, [PostController, 'store'])
  .name('posts.store')
  .agent({ description: 'Create a blog post as the authenticated user.' })

// As a route contract key
router.post('/posts', {
  name: 'posts.store',
  body: CreatePostSchema,
  agent: { description: 'Create a blog post as the authenticated user.' },
}, [PostController, 'store'])
```

Two rules the router enforces at registration:

- **The options object is the second argument, the handler the last.**
  `router.post(path, options, handler)`. The router recognizes an options
  object by its keys — `agent` included — so an object carrying only `agent` is
  still options and not a handler.
- **Declare it once.** Passing `agent` in the route options *and* chaining
  `.agent()` throws. A merge would silently drop security-relevant fields
  (`approval`, `redact`) from whichever declaration lost.

**The tool name is the route name, verbatim.** The MCP name grammar
(`^[A-Za-z0-9._-]{1,128}$`) permits dots, so `posts.store` needs no
transformation. `agent: { toolName: 'blog.createPost' }` overrides the
spelling, not the requirement: a route with no `.name()` cannot become a tool,
because the name is the tool's identity. `guren check` fails on one.

### Resource routes

`resource()` takes per-action metadata, and **an action not listed is not
exposed**:

```ts
router.resource('/posts', PostController, {
  agent: {
    index: { description: 'List posts.' },
    show: { description: 'Fetch one post by id.' },
    // create/store/edit/update/destroy are registered as routes,
    // but they are not agent tools
  },
})
```

Deny by default is the point. Auto-converting every endpoint into a tool is the
known anti-pattern: it produces oversized catalogs that degrade the agents
reading them. Expose the few routes an agent actually needs. Declaring metadata
for an action this call did not register (excluded via `only`/`except`, or
absent from the controller) throws — a tool that cannot exist is a wiring
mistake, not a no-op.

### Metadata fields

| Field | Meaning |
|-------|---------|
| `description` | What the tool does. Falls back to the route's OpenAPI `description`, then its `summary`. Write it for an agent that has never seen your app. |
| `toolName` | Overrides the route name as the tool name. |
| `expose` | `{ mcp?, webMcp? }` — which protocol surfaces the tool appears on. Both default to true; `expose: { mcp: false }` keeps a tool out of the MCP endpoint. `webMcp` is recorded for a browser surface that is not shipped yet. |
| `readOnlyHint` | The tool changes nothing. See [Annotations](#annotations). |
| `destructiveHint` | `false` is the strong claim "additive updates only". |
| `idempotentHint` | Repeat calls with the same arguments add no effect. |
| `approval` | `'required'` marks the tool as needing server-side approval. Until an approval queue ships, the MCP endpoint fails closed on it: the tool is neither listed nor callable. |
| `redact` | Argument field names to mask in the audit trail. See [The audit trail](#the-audit-trail). |

## The input schema

MCP requires a tool input to be a single object, so the route's `params`,
`query` and `body` are merged into one, in that order:

```ts
router
  .get('/posts/:id/comments', {
    params: PostIdParamSchema,      // { id: number }
    query: CommentListQuerySchema,  // { page?: number, perPage?: number }
  }, [CommentController, 'index'])
  .name('posts.comments.index')
  .agent({ description: 'List the comments on one post.' })
```

```
Input
  id: number
  page?: number
  perPage?: number
```

The details worth knowing:

- **Path parameters are always required.** A parameter the path declares but
  the `params` schema does not describe is supplemented as a required string;
  one the schema *does* describe stays required whatever the schema says, since
  the URL cannot be built without it. (Known limitation: Hono's optional
  modifier, `/posts/:id?`, is advertised as required too — the same rendering
  the OpenAPI document uses.)
- **A non-object body nests.** If `body` is an array, a primitive, a union or a
  record, it lands under a single `body` property rather than flattening,
  because the tool input has to have an object root.
- **A key collision is reported, not merged.** When two sources declare the
  same key, the later one wins (params → path → query → body) and the
  derivation emits a warning naming both. You will see it in `tool:list`, in
  `tool:inspect` for that tool, and in the server log when the MCP plugin
  boots. Rename one of the two: merged tool input has one namespace.
- **The advertised type is the input side of the schema.** `z.coerce`,
  `.default()` and `.transform()` are rendered as the type an agent *writes*,
  not the type your controller receives. The real validation still happens once,
  at the application boundary.

A body-carrying route with no `body` schema derives its input from the path and
query alone, which leaves the agent guessing at the payload. `guren check`
warns about it.

## The output

Three rungs, in order:

| Priority | Source | What the tool gets |
|---|---|---|
| 1 | the route's `output` schema | a JSON Schema `outputSchema`, and `structuredContent` on every successful call |
| 2 | a [`resource` hint](./routing.md#resource-response-hints) | no schema; `bunx guren codegen` embeds the Resource's extracted payload type into the tool description |
| 3 | neither | no output shape at all; `guren check` warns |

`output` outranks the hint whenever both are declared — the `output` schema is
the one shape validated at runtime, and carrying both would leave two
descriptions of one response with nothing keeping them in agreement.

`structuredContent` is offered only for an **object** `outputSchema`; MCP
allows no other root. A route whose `output` is an array or a primitive still
advertises nothing structured, and its result rides as text.

How a response becomes a tool result:

| Response | Result |
|---|---|
| 2xx JSON | serialized as text, plus `structuredContent` when the tool advertises an object output schema |
| 2xx Inertia page JSON | unwrapped to `page.props` — only for a tool with no output schema, so the advertised shape can never disagree with the result |
| 204 / 3xx | a text line naming the status and `Location`; not an error |
| 4xx / 5xx | `isError: true` carrying the exception handler's JSON body — a 422's `{ message, errors }` is an application failure the agent should read, not a protocol fault |
| non-JSON | capped text |

One rule overrides that table: a tool advertising an object output schema whose
route answers with something that cannot fill it (a 204, a redirect, a JSON
array, a non-JSON body) comes back as an error result naming the mismatch,
rather than a success the client would reject after the route has already run.

An action answering with `this.inertia(...)` returns whatever the page happens
to pass its component — a shape nothing checks and any UI change can move.
Prefer `output` plus `this.json(...)` on agent-facing routes; `guren check`
warns about the Inertia case.

## Annotations

MCP annotations describe a tool to its client. Guren resolves all three to
explicit values so nothing downstream has to reapply a default:

| Annotation | Default |
|---|---|
| `readOnlyHint` | true for GET and QUERY, false otherwise |
| `destructiveHint` | the inverse of `readOnlyHint` — the MCP spec default for anything not read-only is `true` |
| `idempotentHint` | true for GET, QUERY, PUT and DELETE |

**Annotations are hints for client UX. They enforce nothing.** Enforcement
lives in your policies (evaluated inside the dispatched request, exactly as for
a browser) and in token scopes (evaluated before the request is even
synthesized). That is precisely why the two claims that *weaken* a check are
held against the controller body:

- `readOnlyHint: true` is what exempts a route from the authorization rule, so
  `guren check` warns when a read-only tool's action deletes, updates or
  force-writes — for the GET/QUERY default as much as for a hint you wrote.
- `destructiveHint: false` claims "additive updates only", so `guren audit`
  warns when the action deletes, updates or force-writes.

### Authentication is not authorization

An agent calls with a token, not a browser session. `this.auth.userOrFail()`
proves *who* is calling; it does not decide whether that caller may perform
*this* action. A non-read-only tool protected only by authentication hands
every principal holding any token the whole action.

So every non-read-only tool needs one of:

```ts
// on the route — the ability is then derivable, and tool:list shows it
router
  .delete('/posts/:id', { params: PostIdParamSchema }, [PostController, 'destroy'])
  .name('posts.destroy')
  .middleware(authorizeMiddleware('posts.destroy'))
  .agent({ description: 'Delete a post.' })
```

```ts
// or in the action
await this.authorize('delete', [Post, post])
```

`this.can(...)` is not enough: it returns a boolean and enforces nothing.
`guren check` **fails** a non-read-only agent route with neither.

## Serving the tools

The tools are served by `@guren/plugin-mcp`, a separate package so that apps
which do not expose an agent surface never carry the MCP transport.

```bash
bunx guren plugin @guren/plugin-mcp
bun add @guren/plugin-mcp
```

```ts
// src/app.ts
import { createApp, EventServiceProvider, DatabaseApiTokenStore } from '@guren/core'
import { mcpPlugin } from '@guren/plugin-mcp'
import { apiTokens } from '@/db/schema'
import { registerWebRoutes } from '@/routes/web'

const app = createApp({
  routes: registerWebRoutes,
  providers: [EventServiceProvider, mcpPlugin()],
})

// Required: the endpoint verifies bearers against this store.
app.auth.useTokens(new DatabaseApiTokenStore(apiTokens))

export default app
```

The endpoint mounts at `/mcp` and speaks streamable HTTP, stateless: one MCP
server per request, no session to keep. **Bearer authentication is required**,
so the app must configure an [API token store](./api-tokens.md):

- no bearer, or one that is invalid, expired or revoked → `401` with
  `WWW-Authenticate: Bearer`, before any MCP framing
- no token store configured at all → `500` naming `auth.useTokens(store)`, so a
  misconfiguration reads as a misconfiguration rather than a rejected token

You do not need a CSRF exemption for it. A request that carries
`Authorization: Bearer` and no `Cookie` header at all skips CSRF verification
framework-wide — there is no ambient authority to defend, and the dispatcher
synthesizes cookie-less bearer requests by construction.

### Configuration

```ts
mcpPlugin({
  path: '/mcp',
  serverInfo: { name: 'blog', version: '1.0.0' },
  rateLimit: { max: 60, writeMax: 20, windowMs: 60_000 },
  updateLastUsed: true,
})
```

| Option | Default | Meaning |
|---|---|---|
| `path` | `'/mcp'` | Where the endpoint mounts |
| `serverInfo` | `{ name: 'guren-app', version: '1.0.0' }` | Server identity advertised to clients |
| `rateLimit` | `{ max: 60, writeMax: 20, windowMs: 60_000 }` | Per-token budget; `false` disables it |
| `updateLastUsed` | `true` | Whether verifying a bearer writes the token's `lastUsedAt` |

Rate limits are keyed on the **token id**, not an IP: budgets follow
credentials. They are enforced in process memory, so one long-running server
enforces them exactly while a fleet or a serverless deployment enforces them
per instance. A global budget still needs a shared store and your app's own
[rate-limit middleware](./rate-limiting.md).

> Your app's own rate-limit middleware on an agent route cannot substitute for
> this one. Its default key comes from the socket peer, and the re-entrant
> request never arrived over a socket — so every MCP caller collapses into that
> route's shared bucket.

## Tokens and scopes

**An existing `['*']` token grants no agent tools.** Only `tool:` and `tools:`
abilities are read as tool scopes; every other ability — including the default
`['*']` an `ApiToken` carries — matches nothing here. This is deliberate: an
app declaring its first `.agent()` route must not hand its whole agent surface
to every token issued before agent tools existed. Access to the agent surface
is granted explicitly or not at all.

Four scope forms, and no more:

| Scope | Grants |
|---|---|
| `tool:posts.store` | exactly that one tool |
| `tools:read` | every tool whose resolved `readOnlyHint` is true |
| `tools:posts.*` | every tool named `posts.…` (the dot is part of the match, so not `posts` itself) |
| `tools:*` | every tool |

Scopes are additive and there is no deny form. A tool the token's scopes do not
cover is not merely refused — it is **absent from `tools/list`**, so an
ungranted catalog cannot map your write surface for a read-only agent.

### Issuing a token

```bash
bunx guren token:issue --name blog-reader --user 42 --tools 'tools:read' --expires 30d
```

```
✔ Issued token "blog-reader" for user 42.

Token (shown once — it is stored hashed and cannot be recovered)
  1|xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

Expires  2026-09-29T09:00:00.000Z
Abilities  tools:read
Granted tools
  read: posts.index, posts.show
  write: (none)
```

An agent that also writes gets its own token, rather than a wider scope on
this one:

```bash
bunx guren token:issue --name blog-writer --user 42 --tools 'posts.store' --expires 30d
```

`--tools` accepts shorthand: a bare name becomes `tool:<name>`, `posts.*`
becomes `tools:posts.*`, `read` becomes `tools:read`, `*` becomes `tools:*`.

| Option | Meaning |
|---|---|
| `--name` | Required. How the token is identified when someone revokes it. |
| `--user` | Required. The user ID the token authenticates as. |
| `--tools` | Required. Comma-separated scopes. |
| `--read-only` | Restrict the grant to read-only tools. |
| `--expires` | `30d`, `12h`, `45m`. Omit for a non-expiring token. |
| `--allow-unmatched` | Accept a scope matching no current tool. |
| `--yes` | Required to accept `tools:*`. |
| `--json` | Emit the issued token as JSON, warnings included. |

The command refuses more than it warns, because a typo on a credential command
line is cheapest to fix while you are still looking at it:

- **A scope matching no current tool is refused.** It is either a typo or a
  *latent grant* — a stored pattern that would activate, with nobody's consent,
  the moment a matching tool is added. `--allow-unmatched` overrides it and
  warns about exactly that.
- **`tools:*` needs `--yes`.** It grants every tool the app exposes now and
  every one it gains later, destructive ones included.
- **`--read-only` stores concrete entries.** The grant is expanded at issuance
  and written as `tool:<name>` entries, never as the pattern — the grammar has
  no "read-only subset of `posts.*`" form. That is fail-closed: a write tool
  added to the `posts.` family later joins no stored entry. Under `--read-only`
  an unmatched scope is refused even with `--allow-unmatched`, since it could
  never grant anything at any later point.

Two issuance-time warnings, neither of them a refusal:

- a token that never expires stays valid until someone revokes it by hand
- a token granting **both** read and write tools is the shape the known
  injection incidents took: an agent that reads attacker-influenced content and
  can also write it back can be steered by that content. Split the two across
  separate tokens where you can.

## The audit trail

Every invocation and every denial is emitted as a framework event, so you
forward them wherever you already forward events.

| Event | When | Carries |
|---|---|---|
| `AgentToolInvoked` | the call reached the application | `principal`, `tool`, `arguments`, `status`, `durationMs`, `surface` |
| `AgentToolDenied` | the adapter refused before any HTTP happened | `principal`, `tool`, `arguments`, `reason`, `surface` |

`reason` is one of `'auth'`, `'scope'`, `'approval'`, `'rate-limit'` — exactly
the checks that precede the request. **A policy denial is not one of them:**
policies evaluate inside the dispatched request, so it arrives as an
`AgentToolInvoked` with status `403`. A denial carries no status or duration
because nothing ran.

```ts
// app/Providers/EventServiceProvider.ts (or wherever you register listeners)
import { AgentToolInvoked, AgentToolDenied, createFacades } from '@guren/core'

const { Events, Log } = createFacades(app.container)

Events.on(AgentToolInvoked, (event) => {
  Log.info('agent tool invoked', {
    tool: event.tool,
    principal: event.principal?.id,
    status: event.status,
    durationMs: event.durationMs,
    arguments: event.arguments,
  })
})

Events.on(AgentToolDenied, (event) => {
  Log.warn('agent tool denied', { tool: event.tool, reason: event.reason })
})
```

An event manager has to be bound for any of this to happen — register
`EventServiceProvider` (or your app's own event provider) alongside
`mcpPlugin()`. Without one the plugin warns at boot and emits nothing.

### Writing the trail down

The events fire whether or not anything records them. To keep a durable trail,
configure a sink on the plugin:

```ts
import { mcpPlugin } from '@guren/plugin-mcp'

createApp({
  providers: [
    EventServiceProvider,
    mcpPlugin({
      audit: { file: 'storage/logs/agent-audit.log', days: 30 },
    }),
  ],
})
```

One JSON record per line, rotated daily into `agent-audit-YYYY-MM-DD.log`
beside the path you name, with files older than `days` swept on rotation
(14 by default). `file` is resolved by the filesystem, so give an absolute path
or one relative to the process's working directory — it is not resolved against
an application root.

For anywhere other than a file, pass a function instead:

```ts
mcpPlugin({
  audit: {
    sink: async (record) => {
      await auditStream.write(record)
    },
  },
})
```

A sink that throws is warned about and does not fail the tool call it was
recording.

**The sink is opt-in on purpose.** The endpoint runs on Workers, where there is
no writable filesystem, and on Lambda, where it is ephemeral — a framework that
started appending on its own would give you a trail that quietly degrades per
deployment while the configuration looks identical. An audit trail is only
worth something if you know whether it is complete, so Guren makes you say
where it goes.

### Reading the trail

```bash
# The last 50 records
bunx guren tool:log

# Follow, including the rollover into tomorrow's file
bunx guren tool:log --tail

# Only denials, only this tool, only the last two hours
bunx guren tool:log --denied
bunx guren tool:log --tool posts.store --since 2h -n 200

# Raw records, one per line, for piping
bunx guren tool:log --json | jq 'select(.status >= 400)'
```

| Option | Meaning |
|---|---|
| `--file <path>` | Base path of the trail (default `storage/logs/agent-audit.log`) |
| `--tail`, `-f` | Follow as records arrive |
| `--tool <name>` | Only this tool |
| `--surface <s>` | Only `mcp`, `dev-mcp`, `cli`, or `webmcp` |
| `--denied` | Only denials |
| `--since <duration>` | Only records newer than `30m`, `2h`, `7d`… |
| `-n <count>` | How many records (default 50) |
| `--app <dir>` | Application root the base path is resolved against |
| `--json` | One raw record per line |

`tool:log` boots nothing — an audit trail has to be readable when the
application it records is not startable. It reads across the rotation set
newest-file-first, so `-n` spanning a midnight boundary works, and applies
`-n` **after** filtering: `--denied -n 50` is the last fifty denials, not the
denials among the last fifty records.

If there is no trail, the command says so and prints the configuration line to
add rather than an empty list — an empty listing here would read as "no agent
touched this application", which is exactly the wrong conclusion to draw from a
sink that was never wired.

### Redaction

`event.arguments` is masked before the event is constructed. Two sources are
unioned: a built-in list of sensitive key fragments every app gets without
asking (`password`, `passphrase`, `secret`, `token`, `apikey`, `authorization`,
`credential`, `cookie`, `session`) and the route's own `redact` metadata.

```ts
router
  .post('/integrations', { body: CreateIntegrationSchema }, [IntegrationController, 'store'])
  .name('integrations.store')
  .agent({
    description: 'Connect an external integration.',
    redact: ['webhookUrl'],
  })
```

Matching is blunt on purpose, in the safe direction:

- a key matches when its **lowercased, separator-stripped name contains** a
  fragment, so `apiKey`, `api_key` and `x-api-key` are all covered by `apikey`
- the same containment applies to entries you declare, so `redact: ['id']` also
  masks `userId`
- the key decides before the value's shape does: a nested object under a key
  named `token` is masked whole, not walked

Masked values are replaced with `[REDACTED]`. The walk is total — a cycle
becomes `[Circular]` and an absurdly deep payload `[Truncated]` — because it
runs while recording that something happened, including denials taken before
your route's own validation.

## Dev MCP is a different endpoint

Guren has shipped an MCP endpoint for a while, and it is not this one. Keep
them apart:

| | Dev MCP | App MCP |
|---|---|---|
| Path | `/_guren/mcp` | `/mcp` (configurable) |
| Ships in | the framework | `@guren/plugin-mcp` |
| Operates on | your project on disk | your application's data |
| Audience | your coding agent | agents your users point at the app |
| Gate | `GUREN_MCP=1` **and** a verified loopback peer; fails closed | a bearer token, then its tool scopes |
| Tools | fixed framework tools (context, checks, scaffolding) | the routes you gave `.agent()` |
| In production | absent — the gate is settled at bundle time by every deploy plugin | mounted |

Never put a tunnel in front of a dev server running with `GUREN_MCP=1`: that
endpoint can write files into your project. See
[Spec-Anchored Development](./spec-anchored.md) for the dev-side story.

## What the checks enforce

The rules run in the normal `bunx guren check` suite and are
content-activated: an app with no agent routes produces no findings and has no
controller scanned.

`check` **fails** on a nameless agent route, a tool name outside the MCP
grammar, two routes resolving to one tool name, and a non-read-only tool whose
middleware chain carries no authorization capability and whose action never
calls `this.authorize(...)`.

`check` **warns** on a missing output shape, an Inertia response, a
body-carrying route with no `body` schema, a read-only tool whose action
mutates, and any verdict it could not reach (an inline handler, an unreadable
controller file, two controller classes sharing a name).

`bunx guren audit` treats the same routes more strictly: a body-validation
finding that is a warning for an ordinary route becomes a **failure** for an
agent-exposed one, and `destructiveHint: false` on an action that deletes,
updates or force-writes warns.

The full finding-key tables are in
[CLI — Agent-exposed routes](./cli.md#agent-exposed-routes).

## Related

- [Routing — Agent tools](./routing.md#agent-tools) — where `.agent()` sits among the other route contracts
- [API Tokens](./api-tokens.md) — the store the MCP endpoint verifies bearers against
- [Authorization](./authorization.md) — the policies that decide what a principal may do
- [Events](./events.md) — listener registration and the event manager
- [CLI](./cli.md) — `tool:list`, `tool:inspect`, and the check/audit finding keys
