---
name: agent-interface
description: Expose an existing route to AI agents as an MCP tool via route `.agent()` metadata. Use when the user asks to "expose this to agents", "make an MCP tool", "agent tool", "agent interface", "let Claude call this endpoint", or asks which of the app's routes agents can already reach.
---

# Agent Interface Skill

Guren derives agent tools from the contracts a route already carries — its schemas, its model bindings, its authorization. Nothing is written twice: **there is no tool class and no second JSON schema to hand-write.** Your whole job is deciding which routes to expose and making sure the contracts they already have are complete.

## Exposing a route

Declare `agent` metadata on the route. Either form works:

```typescript
import { Router } from '@guren/core'

router.post('/posts', {
  name: 'posts.store',
  body: CreatePostSchema,
  output: PostOutputSchema,
  agent: { description: 'Create a blog post as the authenticated user.' },
}, [PostController, 'store'])

router
  .post('/posts', { body: CreatePostSchema }, [PostController, 'store'])
  .name('posts.store')
  .agent({ description: 'Create a blog post as the authenticated user.' })
```

**Argument order trap:** the options object is the **second** argument and the handler is the **last** — `router.post(path, options, handler)`. Writing `router.post(path, handler, options)` registers the options object as the handler. The router recognizes an options object by its keys, `agent` included, so an object carrying only `agent` is still options and not a handler.

**One declaration per route.** Declaring `agent` in the route options *and* chaining `.agent()` throws at registration ("already carries agent metadata"). It is a refusal rather than a merge on purpose: a silent overwrite would drop security-relevant fields (`approval`, `redact`) the first declaration carried.

The tool name is the route name, used verbatim — the MCP name grammar allows dots, so `posts.store` needs no transformation. **A route with no `.name()` cannot be a tool** (the name is the tool's identity); `guren check` fails on it.

## Exposing resource() actions

`resource()` takes per-action metadata, and an action not listed is **not exposed**:

```typescript
router.resource('/posts', PostController, {
  agent: {
    index: { description: 'List posts.' },
    store: { description: 'Create a post.' },
    // show/update/destroy are registered as routes but are not agent tools
  },
})
```

Deny by default is the point: never spread one metadata object across every action to "save typing". Auto-converting every endpoint into a tool is the known anti-pattern — it produces oversized catalogs that degrade the agents reading them. Expose the few routes an agent actually needs.

Declaring metadata for an action that was not registered (excluded via `only`/`except`, or missing from the controller) throws — a tool that cannot exist is a wiring mistake.

## Metadata fields

Everything below is **declared metadata** on the route — there is still no tool definition to write. The metadata is read by `guren check`, `guren audit` and `guren context <Entity>`, and it is honoured at runtime by `@guren/plugin-mcp`, which serves the derived tools at `/mcp`: the annotation defaults are resolved during derivation, `expose.mcp` filters the served catalog, `redact` masks arguments in the audit events, and `approval: 'required'` fails closed. Two things in this table still describe surfaces that have not shipped, and both rows say so: `expose.webMcp` and the approval *queue*.

Serving is a separate, app-level step: the endpoint mounts only when the app installs the plugin and configures a bearer token store. A route carries `.agent()` metadata whether or not it does — declaring it is your job, mounting the endpoint is the app's.

| Field | Meaning |
|-------|---------|
| `description` | What the tool does. Falls back to the route's OpenAPI `description` ?? `summary`. Write it for an agent that has never seen your app. |
| `toolName` | Overrides the route name as the tool name. |
| `expose` | `{ mcp?, webMcp? }` — which protocol surfaces the tool appears on; both default to true. `mcp: false` keeps a tool out of the MCP endpoint's catalog today. `webMcp` is recorded for a browser surface that has not shipped. |
| `readOnlyHint` | The tool changes nothing. On a mutating verb this is an explicit override — and it exempts the route from the authorization rule below, so `guren check` holds it against the action's body. |
| `destructiveHint` | `false` is the strong claim "additive updates only" — `guren audit` checks it against the action. Unset keeps the spec default (destructive for a non-read-only tool). |
| `idempotentHint` | Repeat calls with the same arguments add no effect. The derivation defaults it to true for PUT and DELETE; declaring it records your own claim. |
| `approval` | `'required'` marks the tool as needing server-side approval before it executes. There is no approval queue yet, so the MCP endpoint **fails closed** on it: the tool is neither listed nor callable. |
| `redact` | Argument field names to mask in the `AgentToolInvoked` / `AgentToolDenied` events the endpoint emits. Unioned with a built-in fragment list (`password`, `secret`, `token`, `apikey`, …), so it *adds* to a default rather than being the whole mask. Matching is lowercased, separator-stripped containment — `redact: ['id']` also masks `userId`. |

Annotations are untrusted hints for client UX. **They enforce nothing** — enforcement lives in your policies (evaluated inside the dispatched request, exactly as for a browser) and in the calling token's tool scopes (evaluated before the request is synthesized); the approval queue is still to come. That is exactly why the two hints that *weaken* a check are held against the controller body.

## Authentication is not authorization

An agent calls with a token, not a browser session. `this.auth.userOrFail()` proves *who* is calling; it does not decide whether that caller may perform *this* action. A non-read-only tool protected only by authentication hands every authenticated principal — every agent holding any token — the whole action.

So every non-read-only tool needs one of:

```typescript
// on the route
router.delete('/posts/:id', { name: 'posts.destroy', agent: {} }, [PostController, 'destroy'])
  .middleware(authorizeMiddleware('posts.destroy'))

// or in the action
await this.authorize('delete', [Post, post])
```

`this.can(...)` is not enough: it returns a boolean and enforces nothing. `guren check` **fails** a non-read-only agent route with neither.

Do not reach for `agent: { readOnlyHint: true }` to quiet that failure. Being read-only is what exempts a route from this rule, so `guren check` holds the claim against the action's body and warns when the action deletes, updates, or force-writes — for the GET/QUERY default just as much as for a hint you wrote. Declare it only when the tool truly changes nothing.

## Give the tool its schemas

A tool's input schema comes from the route's `params`, `query`, and `body`; its output schema from `output`, or a `resource` hint for the description. A route missing them still works over HTTP but leaves an agent guessing:

- No `body` schema on a body-carrying route → the agent cannot see what the action expects, and every call it composes is rejected by the validation inside the action. On an **inline handler** it is worse: there the route schema is what validates at request time, so nothing checks the payload either.
- No `output` schema and no `resource` hint → the result reaches the agent as untyped text. This applies to write tools as much as read tools.
- An action that returns `this.inertia(...)` → the tool returns whatever the page passes its component, a shape nothing checks and any UI change can move. Prefer `output` + `this.json(...)` for agent-facing routes.

## Check the wiring

```bash
bunx guren check    # agent-route rules run in the normal suite
bunx guren audit    # validation rules are stricter for agent-exposed routes
```

`guren check` **fails** on: a nameless agent route, a tool name outside `^[A-Za-z0-9._-]{1,128}$`, two routes resolving to one tool name, and a non-read-only tool whose controller action shows no authorization. It **warns** on: a missing output or body schema, an Inertia response, a read-only tool whose action mutates (declared or GET/QUERY-default), a controller file it could not read, and any verdict it could not reach because the handler body was one it does not read (an inline handler, or a controller outside `app/Http/Controllers/`).

`guren audit` warns when `destructiveHint: false` sits on an action that deletes, updates, or force-writes records, and treats an unverifiable body validation on an agent route as a failure rather than a warning. Suppress an audit finding you have judged safe by its exact key in `config/audit.ts`.

Full routing reference: `__RULES_DIR__/routes-codegen.md`.
