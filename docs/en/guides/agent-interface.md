# Agent Interface

AI agents call applications over MCP. Guren does not ask you to write a second
application for them: an agent tool is **derived from the contracts a route
already carries**. The route's `params`, `query` and `body` schemas become the
tool's input schema, its `output` schema becomes the tool's output schema, and
the policy its middleware chain checks becomes the tool's authorization.

There is no tool class to write and no second JSON Schema to keep in sync. A
tool cannot advertise a shape the endpoint does not validate, because there is
only one shape. When a tool is called, the framework's dispatcher rebuilds the
call as a real HTTP request into your application, so validation, middleware
and policies run exactly once, in the place they already run.

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

That is the whole change to the application. The rest of the page follows the
order you need it in: the declaration and the schemas it derives, checking and
calling the tools locally, and serving them over MCP. The tokens,
approvals and audit trail that lock them down are on their own page,
[Control and Audit Agent Tool Access](./agent-tool-governance.md).

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
  object by its keys, `agent` included, so an object carrying only `agent` is
  still options and not a handler.
- **Declare it once.** Passing `agent` in the route options *and* chaining
  `.agent()` throws. A merge would silently drop security-relevant fields
  (`approval`, `redact`) from whichever declaration lost.

**The tool name is the route name, verbatim.** The MCP name grammar
(`^[A-Za-z0-9._-]{1,128}$`) permits dots, so `posts.store` is a legal tool
name. Not every client accepts one, though: the Claude and OpenAI tool APIs
restrict names to `^[A-Za-z0-9_-]{1,64}$`, and Claude Managed Agents applies
that grammar to MCP tools and skips every tool outside it. The skip is silent
on your side: `tools/list` is answered correctly and the client drops the
entry. Give such a route a portable spelling with
`agent: { toolName: 'posts_store' }`. The route name, `route()` helpers and
the HTTP path stay as they are; only the advertised tool name changes.
`guren check` warns on a tool name that a client would drop.

`toolName` overrides the spelling, not the requirement: a route with no
`.name()` cannot become a tool, because the name is the tool's identity.
`guren check` fails on one.

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
absent from the controller) throws. A tool that cannot exist is a wiring
mistake, not a no-op.

### Metadata fields

| Field | Meaning |
|-------|---------|
| `description` | What the tool does. Falls back to the route's OpenAPI `description`, then its `summary`. Write it for an agent that has never seen your app. |
| `toolName` | Overrides the route name as the tool name. Use it to give a dotted route name a spelling every client accepts (`posts_store`). |
| `expose` | `{ mcp?, webMcp? }` — which protocol surfaces the tool appears on. Both default to true; `expose: { mcp: false }` keeps a tool out of the MCP endpoint, and `expose: { webMcp: false }` out of the in-browser surface `@guren/plugin-webmcp` registers (experimental). |
| `readOnlyHint` | The tool changes nothing. See [Annotations](#annotations). |
| `destructiveHint` | `false` is the strong claim "additive updates only". |
| `idempotentHint` | Repeat calls with the same arguments add no effect. |
| `approval` | `'required'` means a call becomes a pending request for a human to approve instead of executing. See [Approval-gated tools](./agent-tool-governance.md#approval-gated-tools). With no queue configured the endpoint fails closed: the tool is neither listed nor callable. |
| `redact` | Argument field names to mask in the audit trail. See [The audit trail](./agent-tool-governance.md#the-audit-trail). |

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
  modifier, `/posts/:id?`, is advertised as required too, the same rendering
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

`output` outranks the hint whenever both are declared: the `output` schema is
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

The framework's auth guards never answer a tool with a redirect.
`requireAuthenticated`, `requireGuest` and `requireVerifiedEmail` recognize the request the dispatcher
builds (it carries `X-Guren-Agent-Surface`) and, where a browser would be sent
to their `redirectTo`, answer JSON instead: `401` for no user, `403` for a
signed-in user on a guest-only route or an unverified address. The call comes
back as an error result rather than a success naming `/login`. The header only
chooses the refusal's shape and grants nothing. A redirect the handler itself
returns, such as `store` answering `this.redirect('/posts')`, is still a
success.

`createForceHttpsMiddleware()` lets a tool call through rather than redirecting
it to https. The dispatcher builds the request on the origin its caller reached:
`http://` for an MCP endpoint behind a TLS-terminating proxy, and
`http://localhost` for durable agents, `guren tool:call`, `TestApp.agent()` and
in-process AI agents with no `APP_URL`. It never leaves the process, so there
is no transport to upgrade. Unlike the guards above, the
middleware does not read the header: it lets through only the request object
the dispatcher built, so an outside HTTP request that copies its headers is
still redirected.

An action answering with `this.inertia(...)` returns whatever the page happens
to pass its component, a shape nothing checks and any UI change can move.
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
a browser) and in [token scopes](./agent-tool-governance.md#tokens-and-scopes) (evaluated before the request is even
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
every caller holding any token the whole action.

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

`tool:inspect` shows one tool's whole derivation (the merged input, the output
schema, the authorization ability, the annotations, and any warning that
applies to that tool):

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

`tool:list` describes the surface. `tool:call` uses it, with no MCP client, no
token and no running server:

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
is scoped to reach it: [`guren token:issue`](./agent-tool-governance.md#issuing-a-token) is where that is decided.

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
credential (the same mechanism `@guren/testing` uses). The command says so every
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
The handler did not run. The route's own middleware did run, so any effect a
middleware on this route has of its own has already happened. No authorization
middleware was found on this route, so any check inside the handler itself was
not evaluated.
```

The request runs the route's middleware and validates the contract the tool
advertises, then stops before the handler. `unverified` names what a real call
would still evaluate: a check made inside the action is one a rehearsal never reaches, because it
stops before the handler.

**A rehearsal is not a dry run of the whole request.** It stops at a point
mounted after every other middleware, so that every gate in front of it is the real one, which is what makes the
verdict worth having. It also means the route's middleware genuinely ran: a
middleware that increments a quota, consumes a rate-limit bucket, touches a
session, or calls something else has already done so. Only the handler is
skipped.

MCP reaches the same rehearsal through a companion tool rather than a flag (see
[Rehearsing a call over MCP](#rehearsing-a-call-over-mcp)). A tool that
advertises an `outputSchema` must answer with `structuredContent` conforming to
it, and a verdict conforms to no route's output, so the verdict needs a tool of
its own. `tool:call` and `@guren/testing` are not bound by that rule and ask
for a verdict on the call itself.

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
  is no token here, so `assertDenied()` means "the application refused": its
  authentication or its policies. Bearer scopes belong to the MCP endpoint and
  are not reachable from a test. A call without `{ as }` to a route behind
  `requireAuthenticated({ redirectTo: '/login' })` answers `401`, not the
  redirect.
- **Mount CSRF or skip it, deliberately.** A dispatched tool call carries no
  cookie and no bearer, so an app created with `auth` refuses a mutating call
  with `403` before any policy is consulted, which `assertDenied()` cannot tell
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
server per request, no session to keep. It serves both the MCP 2026-07-28
protocol and clients that still open with the 2025-era `initialize` handshake
(2025-11-25 and earlier), from the same path. **Bearer authentication is required**,
so the app must configure an [API token store](./api-tokens.md):

- no bearer, or one that is invalid, expired or revoked → `401` with
  `WWW-Authenticate: Bearer`, before any MCP framing
- no token store configured at all → `500` naming `auth.useTokens(store)`, so a
  misconfiguration reads as a misconfiguration rather than a rejected token
- an authenticated `GET` or `DELETE` → `405`, since there is no session stream to
  open or close
- an authenticated `POST` whose `Content-Type` is not `application/json` → `415`
- a `subscriptions/listen` request → a JSON-RPC error, since the tool list never
  changes while the server runs and a held stream would serve nothing

A valid token is not enough to see a tool. The token also needs a `tool:` or
`tools:` scope, and the default `['*']` an `ApiToken` carries grants none, so a
token issued without one gets an empty `tools/list`. Issue one with
[`guren token:issue --tools`](./agent-tool-governance.md#issuing-a-token).

You do not need to write a CSRF exemption for it. A request carrying
`Authorization: Bearer` and no `Cookie` header at all skips CSRF verification
framework-wide, since with no cookie there is no ambient authority to protect,
and the dispatcher builds cookie-less bearer requests by construction. The plugin also declares its own configured path as authenticating
without cookies, so a request that misses that rule (one with no bearer, or one
a browser attached cookies to) is answered by the `401` above rather than by a
CSRF `403` that hides the real reason. Neither skip authenticates anything: both
ways in are a bearer token and the identity an in-process caller (such as a
durable agent) installs, and a browser can present neither.

`bunx guren audit` reports that declaration, and any other package's, under
**Plugin CSRF exemptions** (the audit's only view into an exemption made from
inside `node_modules`). It names packages rather than paths: each path is an
argument computed at boot from that package's own configuration. A declaration
from a package outside the `@guren/` scope is a warning, since only this
repository can vouch for its own. The packages it reads are the ones your
`package.json` declares, so a plugin reached only through another dependency is
outside its view.

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
| `approvals` | none | The approval queue: `{ store, notify, ttlMs? }`. See [Approval-gated tools](./agent-tool-governance.md#approval-gated-tools) |
| `audit` | none | Where the audit trail is written: `{ file?, days? }` or `{ sink }`. See [Writing the trail down](./agent-tool-governance.md#writing-the-trail-down) |
| `auth` | bearer tokens | `'external'` trusts an authority in front of the app to verify each request instead; no token store is consulted |

Rate limits are keyed on the **token id**, not an IP: budgets follow
credentials. They are enforced in process memory, so one long-running server
enforces them exactly while a fleet or a serverless deployment enforces them
per instance. A global budget still needs a shared store and your app's own
[rate-limit middleware](./rate-limiting.md).

> Your app's own rate-limit middleware on an agent route cannot substitute for
> this one. Its default key comes from the socket peer, and the request the
> dispatcher builds never arrived over a socket, so every MCP caller collapses into that
> route's shared bucket.

### Rehearsing a call over MCP

The endpoint adds one tool of its own, `guren_preflight`. It answers whether a
call to another tool would be allowed, and never performs it:

```json
{
  "name": "guren_preflight",
  "arguments": { "tool": "posts.store", "input": { "title": "Rehearsal" } }
}
```

```json
{
  "tool": "posts.store",
  "allowed": true,
  "status": 200,
  "validated": ["body"],
  "unverified": ["authorization"],
  "message": "Preflight only: the request passed this route's middleware and its body schema. …"
}
```

It stops at the same point `--preflight` does: the checked tool's own
middleware runs, its advertised contract is validated, and the request stops
before the handler. The action itself does not happen, but the middleware
really did run, so anything it does of its own accord has taken effect.

A refusal is a **successful** result, not an error. The caller asked whether
the call would be allowed, and "no, here is why" answers that:

```json
{
  "tool": "posts.store",
  "allowed": false,
  "status": 422,
  "message": "The given data was invalid.",
  "errors": { "title": ["Required"] }
}
```

`validated` and `unverified` are present only when the request reached that
point. A call refused earlier (by authentication or authorization middleware)
has no answer to give about checks it never reached, so those fields are
absent rather than empty.

Four rules worth knowing:

- **Checking a tool needs the same scope as calling it.** Otherwise the
  companion would be a way to probe the authorization surface of tools the
  token cannot call. An ungranted name is refused as an error result, the way a
  direct call to it is.
- **A tool that requires approval can still be checked.** Its real call files
  a request for a human, so a rehearsal is how you ask "would this be
  accepted?" without filing one, and the rehearsal executes nothing.
- **`guren_preflight` is listed only for a token that grants at least one
  tool.** A token that can call nothing has nothing to rehearse.
- **The name is reserved.** A route whose `.agent()` tool name claims it fails
  `bunx guren check`, and the endpoint refuses to serve it. Two tools under
  one name makes an MCP client reject the whole catalogue.

Rehearsing is not requesting. Preflighting an approval-gated tool creates no
pending request and notifies nobody.

## Locking the tools down

[Control and Audit Agent Tool Access](./agent-tool-governance.md) covers the
token scopes every MCP caller needs, plus two optional controls: approval gates
for tools a person should confirm, and the audit trail.

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
grammar, a tool name reserved by the framework (`guren_preflight`), two routes
resolving to one tool name, and a non-read-only tool whose
middleware chain carries no authorization capability and whose action never
calls `this.authorize(...)`.

`check` **warns** on a tool name some clients drop (a dot, or more than 64
characters, which is where `agent.toolName` comes in; advisory, so `check --ci`
and `guren gate` stay green), a missing output shape,
an Inertia response, a body-carrying route with no `body` schema, a read-only
tool whose action mutates, and any verdict it could not reach (an inline
handler, an unreadable controller file, two controller classes sharing a name).

`bunx guren audit` treats the same routes more strictly: a body-validation
finding that is a warning for an ordinary route becomes a **failure** for an
agent-exposed one, and `destructiveHint: false` on an action that deletes,
updates or force-writes warns.

The full finding-key tables are in
[Checks and Audits in Depth: Agent-exposed routes](./cli-checks.md#agent-exposed-routes).

## Related

- [Routing — Agent tools](./routing.md#agent-tools): where `.agent()` sits among the other route contracts
- [Control and Audit Agent Tool Access](./agent-tool-governance.md): token scopes, approval gates and the audit trail
- [API Tokens](./api-tokens.md): the store the MCP endpoint verifies bearers against
- [Authorization](./authorization.md): the policies that decide what a principal may do
- [CLI](./cli.md): `tool:list` and `tool:inspect`
- [Checks and Audits in Depth](./cli-checks.md#agent-exposed-routes): the check/audit finding keys for agent routes
- [AI Agents](./ai-agents.md): an agent class in your app that calls a model with these tools
- [Durable Agents](./durable-agents.md): hosting an agent of your own that calls this surface
