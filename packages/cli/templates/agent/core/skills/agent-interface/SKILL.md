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

| Field | Meaning |
|-------|---------|
| `description` | What the tool does. Falls back to the route's OpenAPI `description` ?? `summary`. Write it for an agent that has never seen your app. |
| `toolName` | Overrides the route name as the tool name. |
| `expose` | `{ mcp?, webMcp? }` — which surfaces the tool appears on. Both default to exposed. |
| `readOnlyHint` | The tool changes nothing. Defaults to true for GET and QUERY routes. |
| `destructiveHint` | `false` is the strong claim "additive updates only". Unset keeps the spec default (destructive for a non-read-only tool). |
| `idempotentHint` | Repeat calls with the same arguments add no effect. Defaults to true for PUT and DELETE. |
| `approval` | `'required'` routes the invocation through a server-side approval queue instead of executing. |
| `redact` | Argument field names masked in the agent audit log. |

Annotations are untrusted hints for client UX. **They enforce nothing** — enforcement lives in policies and the approval queue.

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

## Give the tool its schemas

The tool's input schema is derived from the route's `params`, `query`, and `body`; its output schema from `output`, or a `resource` hint for the description. A route missing them still works over HTTP but leaves an agent guessing:

- No `body` schema on a body-carrying route → the agent cannot see what the action expects, and every call it composes is rejected by the validation inside the action.
- No `output` schema and no `resource` hint → the result reaches the agent as untyped text.
- An action that returns `this.inertia(...)` → the tool returns whatever the page passes its component, a shape nothing checks and any UI change can move. Prefer `output` + `this.json(...)` for agent-facing routes.

## Check the wiring

```bash
bunx guren check    # agent-route rules run in the normal suite
bunx guren audit    # validation rules are stricter for agent-exposed routes
```

`guren check` reports: a nameless agent route, a tool name outside `^[A-Za-z0-9._-]{1,128}$`, two routes resolving to one tool name, a non-read-only tool with no authorization (fail); and missing output/body schemas or an Inertia response (warn). `guren audit` warns when `destructiveHint: false` sits on an action that deletes records.

Full routing reference: `__RULES_DIR__/routes-codegen.md`.
