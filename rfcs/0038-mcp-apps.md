# RFC: MCP Apps — Rendering Agent Tool Results with the Application's Inertia Pages

**Author:** 7nohe
**Date:** 2026-11-03
**Status:** Draft

## Problem

[MCP Apps](https://github.com/modelcontextprotocol/ext-apps) is the MCP extension
for interactive user interfaces (SEP-1865, extension id `io.modelcontextprotocol/ui`,
specification version `2026-01-26`, status Stable). A server declares an HTML
template as a resource under the `ui://` scheme, links a tool to it through
`_meta.ui.resourceUri`, and the host (Claude, ChatGPT, Goose, VS Code and others)
renders the template in a sandboxed iframe. The iframe receives the tool's
arguments and result over `postMessage` and can call the server's tools back
through the host.

Guren already holds both halves of this:

- **The tools.** `.agent()` routes (RFC 0016) derive MCP tools from route
  contracts, and `@guren/plugin-mcp` serves them on the App MCP endpoint with
  bearer or external auth, scopes, policies, the approval queue, rate limits and
  the audit trail (RFC 0016 §4–§5, RFC 0028).
- **The screens.** The same routes' controllers usually answer with
  `this.inertia(pages.posts.Show, props)`, a React page with typed props
  (`.guren/pages.gen.ts`).

Today the two never meet. A tool whose action renders an Inertia page reaches
the agent as `JSON.stringify(page.props)` (`mapToolResponse()` →
`unwrapInertiaProps()` in `packages/server/src/agent/dispatch.ts`), and
`guren check` warns about exactly that (`agent-route-inertia`): the tool returns
"whatever the page happens to pass its component". The user asking Claude
"show me post 12" gets a JSON dump while the application has a page that shows
post 12 properly.

Building an MCP App by hand around a Guren app means writing a second UI (a
standalone HTML file per tool), a second data contract (what the tool result
carries for that UI), a second build (a single-file bundle the host can load
with no network), and wiring a second protocol (the iframe's `postMessage`
JSON-RPC). Every one of those already exists in the app under another name. No
part of `rfcs/0028-mcp-sdk-v2.md` mentions the extension, and nothing in the
repository serves a `ui://` resource.

### What the SDK gives and what it does not

Checked against the code Guren installs, not against the README:

- `@modelcontextprotocol/server` 2.3.1 (the version `bun.lock` resolves for
  `@guren/plugin-mcp` and `@guren/cli`, range `^2.0.0`) has no MCP Apps helper.
  What it has is the generic `extensions` field on both `ClientCapabilities` and
  `ServerCapabilities` (SEP-1724), and, on 2026-07-28 requests, the client's
  declared capabilities on the per-request envelope (`ctx.mcpReq.envelope`).
  `Server.getClientCapabilities()` is deprecated in favour of that envelope.
- The extension ships separately as `@modelcontextprotocol/ext-apps` (2.1.0,
  published 2026-10-27; peer `@modelcontextprotocol/{core,client,server}` `^2.0.0`
  and `zod` `^4.2.0`, so it targets the same SDK line as RFC 0028). Its
  `./server` entry is 561 bytes: `registerAppTool()` and `registerAppResource()`
  take `Pick<McpServer, 'registerTool' | 'registerResource'>`, and the only logic
  is copying `_meta.ui.resourceUri` to the deprecated flat key
  `_meta["ui/resourceUri"]` and back, plus the constants `EXTENSION_ID`,
  `RESOURCE_MIME_TYPE` (`text/html;profile=mcp-app`) and `getUiCapability()`.
  `@guren/plugin-mcp` deliberately uses the low-level `Server`
  (`packages/plugin-mcp/src/server.ts`, RFC 0016 §7), so it cannot call these
  helpers and has no reason to: it writes the same `_meta` itself.
- The iframe side is the package root: `App` (`callServerTool()`,
  `readServerResource()`, `sendMessage()`, `updateModelContext()`, `openLink()`,
  `requestDisplayMode()`, `ontoolinput`/`ontoolresult`), about 38 KB plus
  `@modelcontextprotocol/client`, `core` and `zod`, or 546 KB as the
  dependency-bundled `./app-with-deps`. `./react` wraps it in hooks, and
  `./app-bridge` is the host half, which a development preview can use.

### Prior art

Hosts that render MCP Apps today, per the extension's
[launch post](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/):
Claude (web and desktop), Goose, VS Code (Insiders at launch) and ChatGPT, with
JetBrains, Kiro and Antigravity saying they are exploring it. Three server-side
integrations show the shapes this RFC chooses between:

- **Laravel MCP** ([docs, "Apps"](https://laravel.com/docs/mcp)), the closest in
  spirit. `php artisan make:mcp-app-resource` writes an `AppResource` class and a
  Blade view; a tool links to it with
  `#[RendersApp(resource: X::class, visibility: [Visibility::App])]`
  (`Visibility` has the two cases `Model` and `App`, both by default); CSP
  domains, permissions and CDN libraries (`Library::Tailwind`, `Library::Alpine`,
  whose origins are merged into the CSP) go in `#[AppMeta]`. The view renders
  through `<x-mcp::app>`, which bundles the client SDK as a `createMcpApp`
  global, and the package advertises the `io.modelcontextprotocol/ui`
  extension on the server once any `AppResource` is registered. The view is a
  second UI written for the host: the tool and the app's own pages share
  nothing. In this RFC the Inertia page, built into one inlined HTML document,
  takes the place of the Blade view, so the screen is the one the application
  already has.
- **Vercel's Next.js starter**
  ([template](https://vercel.com/templates/next.js/mcp-apps-next-js-starter))
  renders an ordinary Next.js page, has the MCP route fetch that page's HTML
  from itself and serve it as the resource, and uses `assetPrefix` plus CORS
  headers so the iframe loads scripts from the application's origin. That
  works only where the resource declares the application's origin in its CSP,
  which is the coupling §4 avoids by inlining.
- **The AI SDK** is the host side
  ([docs](https://ai-sdk.dev/docs/ai-sdk-core/mcp-apps)): `@ai-sdk/mcp` exports
  `mcpAppClientCapabilities`, `splitMCPAppTools` (model-visible and app-visible
  tools) and `readMCPAppResource`, and `@ai-sdk/react` exports `MCPAppRenderer`,
  which renders tool parts as sandboxed MCP App iframes. That is relevant to
  `@guren/plugin-ai` (RFC 0029), which builds on the AI SDK: a Guren app's own
  chat UI could become an MCP Apps host for remote servers (Open Question 8).

## Proposed Solution

One declaration on the route, `.agent({ ui: pages.posts.Show })`, makes the
tool an MCP App whose view is the page the controller already renders. The
framework owns the four pieces a hand-built MCP App needs: the tool metadata,
the `ui://` resource, the single-file build, and the bridge that turns Inertia
visits inside the iframe into tool calls through the host.

```ts
import { Router } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { PostController } from '@/app/Http/Controllers/PostController'
import { PostIdParamSchema, UpdatePostSchema } from '@/app/Http/Validators/PostValidator'

export function registerPostRoutes(router: Router): void {
  router
    .get('/posts/:id', [PostController, 'show'], { params: PostIdParamSchema })
    .name('posts.show')
    .agent({ description: 'Show one blog post.', ui: pages.posts.Show })

  router
    .put('/posts/:id', [PostController, 'update'], { params: PostIdParamSchema, body: UpdatePostSchema })
    .name('posts.update')
    // Called by the Show page's edit form inside the host; not offered to the model.
    .agent({ ui: { visibility: ['app'] } })
}
```

The scope is the App MCP endpoint (`@guren/plugin-mcp`) and the stable
specification `2026-01-26`. The development MCP endpoint (`GUREN_MCP=1`) serves
no UI.

### 1. Route declaration

`AgentRouteMetadata` (`packages/server/src/mvc/Router.ts`) gains one field:

```ts
/** Anything carrying a page id: a generated `PageContract`, or the id itself. */
type AgentUiPage = { readonly id: string } | string

interface AgentRouteUi {
  /** Absent for a tool a view calls but that renders no view of its own. */
  page?: AgentUiPage
  /** MCP Apps `_meta.ui.visibility`. Default `['model', 'app']`. */
  visibility?: ReadonlyArray<'model' | 'app'>
  /** MCP Apps `_meta.ui.prefersBorder` on the resource. Unset leaves it to the host. */
  prefersBorder?: boolean
}

interface AgentRouteMetadata {
  // ...existing fields
  /** Render this tool's result in the host with an Inertia page (RFC 0038). */
  ui?: AgentUiPage | AgentRouteUi
}
```

- `@guren/server` cannot import `@guren/inertia-client`, so the page is taken
  structurally, as `Controller.inertia()` already does with
  `InertiaPageContractLike`: anything with a string `id`.
- The router **normalizes at attach**, before `cloneAgentMetadata()` runs
  `structuredClone()`: a generated `PageContract` carries a `props()` method, and
  cloning a function throws. What is stored is
  `{ page?: 'posts/Show', visibility?, prefersBorder? }`, plain data.
- The specification makes `resourceUri` optional, so a tool may carry only
  `visibility`. That is the shape of a write a view performs: `posts.update`
  ends in a redirect, renders nothing, and needs no template of its own. A
  `ui` object with neither `page` nor `visibility` is a derivation warning.
- A route that imports `pages` from `@/.guren/pages.gen` adds no new ordering
  constraint: controllers the routes file imports already import it, and
  `guren codegen` writes the pages artifact before it loads the routes file.

### 2. Derivation and codegen

`DerivedAgentTool` (`packages/server/src/agent/derive.ts`) gains:

```ts
interface DerivedAgentToolUi {
  /** The Inertia page id, verbatim. Absent for a tool that only a view calls. */
  page?: string
  /** `pages/<page id>`, one per page, shared by every tool that names it. Present exactly when `page` is. */
  resourcePath?: string
  visibility: Array<'model' | 'app'>
  prefersBorder?: boolean
}

interface DerivedAgentTool {
  // ...existing fields
  ui?: DerivedAgentToolUi
}
```

`deriveAgentTools()` stays total. It does not know which pages exist, so it
never refuses a page id; it validates only shape (an empty id, a visibility
entry other than `model`/`app`, an empty visibility list) and turns a bad shape
into a per-tool warning with `ui` left off. The `<server>` segment of the
`ui://<server>/pages/<id>` URI is not known at derivation time either, so the
derived value is the path (`pages/posts/Show`) and the adapter prefixes it.

`.guren/agents.gen.ts` carries `ui` like every other derived field, so
`guren tool:list` and `guren tool:inspect` show it and the WebMCP client
ignores it. Codegen also writes the set of UI pages the MCP App build needs (§4)
into the same file, as `agentUiPages`, so the build reads one generated input
and never loads the routes file.

`guren check` gains, in `agent-route-check.ts`, all advisory except the first:

- **`agent-route-ui-page`** (fail): `ui.page` names no page in
  `.guren/pages.gen.ts`. The `PageContract` form makes this a type error first;
  the string form needs the check.
- **`agent-route-ui-renders`** (warn): the action's `renders` edges (the
  Application Graph's `controller:<action>` evidence, RFC 0032) name pages and
  `ui.page` is not one of them. An action that only redirects (`store`) is the
  common case: its view would never receive a page. The suggestion is to drop
  `page` and keep `visibility` (§1), so the write is reached from a page that
  some read tool renders. A `ui` without `page` is outside this rule.
- **`agent-route-ui-visibility`** (warn): `visibility: ['app']` on a route whose
  `expose.mcp` is `false`, which no host could ever call.
- `agent-route-inertia` keeps its wording for routes without `ui`. On a route
  with `ui`, an Inertia response is the declared design, so the finding is not
  raised; the output-shape warning for the model's text still applies (§6).

### 3. What `@guren/plugin-mcp` serves

When at least one tool declares `ui`, `createAppMcpServer()` declares one more
capability and the extension, and registers two handlers (an app with no `ui`
tool serves exactly what it serves today):

```ts
new Server(serverInfo, {
  capabilities: {
    tools: {},
    resources: {},
    extensions: { 'io.modelcontextprotocol/ui': {} },
  },
})
```

**`tools/list`.** `describeTool()` adds, for a tool with `ui`:

```json
"_meta": {
  "ui": { "resourceUri": "ui://blog/pages/posts/Show", "visibility": ["model", "app"] },
  "ui/resourceUri": "ui://blog/pages/posts/Show"
}
```

The flat key is written for the same reason `registerAppTool()` writes it:
hosts that predate the nested form read only that. It is dropped when the
specification removes it ("before GA"). A tool with `visibility` and no `page`
gets `"_meta": { "ui": { "visibility": ["app"] } }` and no flat key. The tool is listed only if
`gateToolCall()` admits it, as today; `visibility` changes nothing about that
filter (§5).

**Always annotated, never negotiated.** The specification says servers
"SHOULD check client capabilities before registering UI-enabled tools". The App
MCP endpoint cannot do that on both eras: on 2025-era connections the SDK hands
each request to a fresh, stateless server (`createMcpHandler()`, RFC 0028 §3),
so the server answering `tools/list` never saw that client's `initialize`. Only
2026-07-28 requests carry the client's capabilities, on the per-request
envelope. The specification also defines the fallback: a host without
MCP Apps ignores `_meta.ui` and reads `content`. So the annotation is
unconditional, and every UI tool keeps a meaningful text `content` (§6). The
server's `extensions` entry is advertised for clients that look for it; the
specification only requires the client side, so this is listed under Open
Questions.

**`resources/list`.** One entry per distinct UI page among the tools the
caller's token can see, with the listing-level `_meta.ui` (`prefersBorder`, the
CSP of §7). A token that can call no tool naming a page is not shown that page,
for the same reason `tools/list` filters: a resource is a map of the surface
(§7). The specification lets a server omit UI-only resources from the list;
listing them is what lets a host prefetch and review templates at connect time.

**`resources/read`.** For a `ui://<server>/pages/<id>` URI that the caller's
listing would contain:

```json
{
  "contents": [{
    "uri": "ui://blog/pages/posts/Show",
    "mimeType": "text/html;profile=mcp-app",
    "text": "<!DOCTYPE html>…",
    "_meta": { "ui": { "csp": {}, "prefersBorder": true } }
  }]
}
```

Any other URI, or a page whose built HTML the app does not have, answers the
resource-not-found error (`-32602` on 2026-07-28, `-32002` on earlier
revisions). Resource reads go through the same authentication the
endpoint already applies before any MCP framing, through the rate limiter, and
into the audit trail as their own event (`AgentResourceRead`), since a template
read is not a tool invocation.

**`tools/call`.** Unchanged for the pipeline. Only the result mapping differs
(§6).

**A missing build is a boot warning, not a broken link.** The specification
says the resource "MUST exist on the server". If a tool declares `ui` and the
app has no built HTML for its page, the plugin warns at boot naming the route
and the build command, and lists the tool **without** `_meta.ui`. A host then
falls back to text, which is better than an iframe with nothing in it.

### 4. Building a page as a self-contained HTML document

**Why no SSR.** A UI resource is a template the host may fetch once, review,
cache and reuse for every call of every tool that names it; the data arrives
afterwards in `ui/notifications/tool-result`. The specification chose this
(Design Decision 1, "Predeclared Resources vs. Inline Embedding") so templates
can be prefetched and reviewed. Rendering the page on the server per call would
put data into the template and lose all of that. The existing SSR bundle
(`.guren/ssr`) is therefore not used, and the view renders on the client from
the result.

**Why one file with everything inlined.** The host builds the iframe's CSP from
`_meta.ui.csp`. Without it the CSP is `default-src 'none'` with
`script-src 'self' 'unsafe-inline'`, `style-src 'self' 'unsafe-inline'`,
`img-src 'self' data:` and `connect-src 'none'`, and `'self'` is the sandbox's
origin, not the app's. A page that loads `/build/assets/app-1a2b.js` from the
application cannot run there. Inlining scripts, styles and fonts (as `data:`
URIs) is the one layout that works under the default with nothing declared.

**The build.** The Guren Vite plugin gains a third mode beside the ordinary and
prototype builds, `vite build --mode mcp-app`:

- Reads `agentUiPages` from `.guren/agents.gen.ts`.
- Builds **one HTML document per page**, each from a generated entry that imports
  the app's `resources/js/app.css` (so Tailwind and the RFC 0036 tokens apply),
  that one page module, and the bridge of §5. Code splitting is off and every
  asset is inlined, so each document stands alone.
- Writes `.guren/mcp-app/pages/<id>.html` and a generated module,
  `.guren/mcp-app/index.gen.ts`, mapping each page id to its HTML as a string.

One document per page rather than one for the whole app follows from §7: a
document holds the code of every page it bundles, and a token that may call one
tool should receive one page's code. It also keeps each template proportional
to what it renders. The cost is that React and the bridge are repeated in every
document, which matters little because a host caches per URI.

The app's `build` script gains `bunx vite build --mode mcp-app` after the
ordinary and SSR builds. `guren codegen` must run first, since the build reads
`agentUiPages`; the scaffold's `build` script already starts with it.

**Serving it on every deploy target.** Workers, Lambda and Vercel have no
filesystem to read `.guren/mcp-app/` from at runtime. The plugin therefore
takes the HTML as a module, not a path:

```ts
mcpPlugin({
  ui: { pages: () => import('@/.guren/mcp-app/index.gen') },
})
```

The dynamic import lets every bundler (Bun.build in the Lambda and Vercel
plugins, wrangler's esbuild for Cloudflare per RFC 0035) inline the strings
into the server bundle, and costs an app without `ui` nothing. The first route
that declares `ui` is the moment to add it: `guren check` reports a `ui` route
in an app whose `mcpPlugin()` call has no `ui.pages` option (read through
`plugin-calls.ts`, the reading `guren check` already uses for `mcpPlugin()`
options), with this line as the fix.

### 5. Inside the iframe: Inertia over the host

The generated entry calls `startMcpApp()` from a new browser-only subpath,
`@guren/inertia-client/mcp-app`, which mounts the page through the same internal
path `startInertiaClient()` uses (`mountInertiaApp()` in `src/app.tsx`).
Inertia 3 takes a custom `HttpClient`, and the prototype mode (RFC 0021)
already passes one there to answer visits from a fixture
(`createPrototypeHttpClient()`). The MCP App mode passes one that answers
visits through the host:

1. **Initial page.** The bridge connects `App` from
   `@modelcontextprotocol/ext-apps` and waits for `ontoolresult`. The result's
   `_meta["dev.guren/inertia-page"]` (§6) is the Inertia page object
   (`component`, `props`, `url`, `version`) and becomes `initialPage`. Until it
   arrives the document shows the page's skeleton state; if the result is an
   error, it shows the error text from `content`.
2. **A visit.** `router.visit()`, `<Link>`, `useForm().put()` and partial reloads
   all reach the `HttpClient` as a method and a URL (and a body). The bridge
   matches them against the tools in `agents.gen.ts` with the path lexer the
   derivation and `buildToolRequest()` already share (`PATH_PARAM_PATTERN`,
   today in `packages/server/src/internal/route-path.ts`, which would be
   exported through the browser-safe `@guren/core/agent` subpath). The match is
   the inverse of `buildToolRequest()`: path parameters, query and body become the flat
   arguments `inputSources` describes. A match becomes
   `app.callServerTool({ name, arguments })`.
3. **The answer.** The bridge reads `_meta["dev.guren/response"]` (§6), never
   the text `content`, which is written for people and models and has no
   format anyone promised. A result carrying an Inertia page is handed back to
   Inertia as the visit's response. A redirect (`location`) is followed by
   matching it as a `GET` visit. A 422 (`errors`) becomes Inertia's validation
   errors on the current page. An approval-gated tool answers with its request
   id (`approval`, RFC 0016 §5.4); the bridge surfaces it through a hook
   (`useMcpApp().pendingApproval`) rather than as a failure.
4. **No matching tool.** A visit no tool answers (another page, an external
   link) opens the application itself through `ui/open-link`, using the
   absolute URL the server put in the page object. A page component that the
   document does not bundle is handled the same way: the bridge never shows a
   blank frame.

**Pages written for the browser mostly just work.** What does not: anything
that reads `window.location`, uses cookies, or calls `fetch` directly, because
the iframe has no network and no session. The `useMcpApp()` hook from the
subpath exposes `isMcpApp`, the host context (theme, display mode, locale), and
`sendMessage()` / `updateModelContext()` for pages that want to talk to the
conversation. Pages opt into those deliberately; the bridge never sends a
message or updates the model context on its own.

**Visibility.** `visibility: ['app']` is how the edit form's `posts.update`
stays out of the model's tool list while the Show page can still call it. It
is enforced by the host, not by Guren (§7).

### 6. The tool result for a UI tool

`mapToolResponse()` keeps its current rules and its current text for every
tool. For a tool with `ui` (with or without `page`), it also fills the result's
`_meta`, which MCP Apps hands to the view and the host does not put in the
model's context. Two keys, under Guren's reverse-DNS prefix as the MCP `_meta`
key rules ask of a vendor:

```json
{
  "content": [{ "type": "text", "text": "{\"post\":{\"id\":12,\"title\":\"…\"}}" }],
  "_meta": {
    "dev.guren/response": { "status": 200 },
    "dev.guren/inertia-page": {
      "component": "posts/Show",
      "props": { "post": { "id": 12, "title": "…" } },
      "url": "https://blog.example.com/posts/12",
      "version": "a1b2c3"
    }
  }
}
```

- `dev.guren/response` is the HTTP outcome in structured form:
  `{ status, location?, errors?, approval?: { requestId } }`. Today those reach
  the result only inside human-readable text (`HTTP 303 (Location: …)`, the raw
  422 body, the denial message). The bridge reads this object, so rewording the
  text never breaks a view, the same reason `DerivedAgentTool.warnings` exists
  beside the prefixed lines.
- `dev.guren/inertia-page` is present when the response carries
  `X-Inertia: true`.
- `structuredContent` is untouched: it is still emitted only when the tool
  advertises an object `outputSchema` (`advertisesStructuredOutput()`), so the
  invariant that `describeTool()` and `mapToolResponse()` share holds.
- `url` and `location` are made absolute in `@guren/plugin-mcp`'s adapter, from
  the app's configured URL, so `ui/open-link` has somewhere real to go.
  `mapToolResponse()` cannot do it: it also runs in the browser for the WebMCP
  client (through `@guren/core/agent`), which has no application URL to read.
- The text `content` is what a host without MCP Apps, and the model, reads. It
  stays `page.props`, which is the case `agent-route-inertia` warns about. A
  `ui` route can still declare an `output` schema to give the model a checked
  shape; the page then still arrives through `_meta`, since the response is
  Inertia either way.
- `ToolCallOutcome` gains an optional `meta` field to carry this, and the
  `tools/call` handler copies it to `CallToolResult._meta`.

### 7. Authentication, authorization and security

**One principal, one pipeline.** A call from the view travels view → host →
server over the host's existing MCP connection, with the bearer token (or the
external-auth identity) the host already holds. Guren receives an ordinary
`tools/call`. Scopes, the tool's policy ability, the approval queue, rate
limits and the audit trail apply exactly as they do to a call the model makes,
because they are the same code path (`AgentInvocationPipeline`). Nothing new is
trusted.

**The server cannot tell the view from the model.** The host proxies both, and
nothing in the request distinguishes them in a way the server could verify.
This has two consequences the documentation must state plainly:

- `visibility: ['app']` hides a tool from the model's list in a compliant
  host. It is not authorization. Any client holding the token can call the
  tool, so it must be guarded by the same scopes and policies as any other
  write. `guren audit` treats an app-only tool exactly like a model-visible
  one.
- The audit trail records the call on the `mcp` surface. Whether a person
  clicked a button or the model chose the tool is not recorded, because it is
  not known. A host-supplied hint (if one is standardized) would be recorded as
  a client claim, as `X-Guren-Agent-Surface: webmcp` is today.

**Templates are code, and a map.** A page's HTML contains its component code,
its layout, and any string literals in them. Listing and reading a page's
resource is therefore limited to tokens that can call at least one tool naming
that page (§3), which is also why the build is per page (§4).

**Props leave the application's origin.** The page object in `_meta` goes to the
host and into a third-party iframe. Shared props come with it: `auth.user`,
flash messages, the `_i18n` catalogue. Today the same props already reach the
model as text; with `ui` they also reach the host's renderer. The rule for
authors is the existing one (props are public to whoever renders the page),
and the Inertia `share()` documentation gains a note. A `share` option to strip
named shared props from MCP App results is listed under Open Questions.

**CSP.** Guren declares an empty `csp` by default: the inlined document needs no
external origin, and `connect-src` stays `'none'`, so a compromised view cannot
reach the application or anywhere else except through the host's tool calls.
An app whose pages show images from its own storage or a CDN declares those
origins once:

```ts
mcpPlugin({
  ui: {
    pages: () => import('@/.guren/mcp-app/index.gen'),
    csp: { resourceDomains: ['https://cdn.example.com'] },
  },
})
```

`connectDomains` is accepted but `guren audit` warns on it: a view with network
access to the application can bypass the tool pipeline entirely if the session
or a token is reachable. `permissions` (camera, microphone, geolocation,
clipboard) and `domain` are passed through as declared, unvalidated, since the
specification makes `domain` host-specific.

**Production.** UI is opt-in per route, served only on the App MCP endpoint,
which is already a production endpoint guarded by bearer or external auth and
mounted only when the app registers the plugin. `createMcpAccessGuard()` and
its loopback rules stay where they are, on the development endpoint, which
serves no UI. The one place they meet is the development preview below: a
local host page that renders an app's MCP App views is a development surface
and mounts only under the same `NODE_ENV` and loopback guard as the Dev MCP
endpoint.

### 8. Development preview

Testing a view today needs a real host. `@modelcontextprotocol/ext-apps/app-bridge`
is the host half of the protocol, so the Dev Center (`/_guren`) can render a
tool's view in a sandboxed iframe of its own, call the tool through the local
App MCP endpoint with a development token, and show the messages exchanged.
It is guarded like the Dev MCP endpoint (`NODE_ENV`, loopback peer), lists only
tools with `ui`, and comes after the protocol pieces (Phase 3).

### 9. Where this sits beside WebMCP and AG-UI

- **WebMCP (`@guren/plugin-webmcp`)** registers tools on the application's own
  pages, in the user's browser, as the signed-in user over the session and CSRF
  token. MCP Apps renders the application's pages inside the agent's host,
  with no session and no network. They point in opposite directions and share
  only the derivation (`DerivedAgentTool`, `buildToolRequest()`). The WebMCP
  client must not start inside an MCP App document: its `fetch` would fail the
  CSP, and its tools would duplicate the host's. The MCP App entry does not
  import it.
- **App-provided tools** (in the specification's draft, not in `2026-01-26`) let
  a view expose its own tools to the host and define their mapping to WebMCP's
  `document.modelContext`. Guren follows that once it is stable; the likely
  shape is that `@guren/plugin-webmcp`'s page-level registration and the view's
  app tools share one declaration.
- **AG-UI** streams agent events to an application's own frontend, the direction
  RFC 0029 (in-process agents) and RFC 0017 (durable agents) cover. It is out of
  scope here. What carries over is the route → page binding this RFC adds: a
  later integration that renders a tool call in the app's own chat UI can use
  `DerivedAgentTool.ui.page` to pick the same page.

## Alternatives Considered

**Use `registerAppTool()` / `registerAppResource()` from ext-apps.** They need
`McpServer`, which wants live Zod and validates arguments a second time, which
RFC 0016 §3.2 rejected for the App MCP endpoint. What they add over writing
`_meta` directly is two constants and the legacy key copy.

**Serve the page from the application URL (`text/uri-list`, an external URL).**
The simplest for the server, and the specification deferred it: hosts cannot
screenshot or review such content, and it would need a session in a
third-party iframe. Not available in `2026-01-26`.

**Return the HTML inline in the tool result (MCP-UI's embedded resources).**
Rejected by the specification for prefetching, caching and review. It would also
put a full document into every call.

**One HTML document for the whole application.** Smaller total build and
working cross-page navigation inside the frame. Rejected for §7: every token
would receive every page's code, including admin pages its scopes never reach.
Revisit if hosts gain a way to scope resources, or if an app opts in.

**Declare a separate UI component per tool (`ui: './mcp/PostCard.tsx'`).** More
freedom over layout for the narrow frame, and no conflict with the app's
navigation. It is allowed by the shape (a page id is any file under
`resources/js/pages`), so an app that wants a compact variant writes a page for
it. Making a bespoke component the primary path would drop the point of the
proposal, which is that the screen already exists.

**Gate `_meta.ui` on the client's declared capability.** Correct per the
specification's SHOULD, but implementable only on 2026-07-28 requests: a
2025-era `tools/list` reaches a stateless server that never saw the client's
`initialize` (§3). Gating on one era only would make the same host see
different catalogues depending on the protocol version it negotiated, for no
gain, since a host without MCP Apps already ignores the annotation.

## Migration Path

Additive. No existing route, tool, or endpoint changes behaviour:

- A route without `ui` derives the same tool, the same `tools/list` entry, and
  the same result as today.
- `@guren/plugin-mcp` advertises `resources` and the extension only when at least
  one tool declares `ui`; an app with none serves the same capabilities as today.
- `@modelcontextprotocol/ext-apps` becomes a dependency of
  `@guren/inertia-client` behind the browser-only `./mcp-app` subpath (an
  optional peer of the root), so apps that never build an MCP App install
  nothing new.

Phases:

1. **Server half.** `AgentRouteMetadata.ui`, its normalization, `DerivedAgentTool.ui`,
   `agents.gen.ts` and the `guren check` rules (§1–§2); `_meta.ui` in
   `tools/list`, `resources/list` / `resources/read`, the result `_meta`, the boot
   warning for a missing build (§3, §6). Testable with a hand-written HTML string.
2. **Build and bridge.** The `mcp-app` Vite mode, the generated module, the
   `@guren/inertia-client/mcp-app` subpath with the Inertia `HttpClient` and
   `useMcpApp()`, the deploy bundling check on each target (§4–§5). Proven
   end to end on `examples/blog` against a real host.
3. **Developer surface.** The Dev Center preview (§8), `guren tool:inspect`
   output, the scaffold `build` script, and a guide under `docs/en/guides/` and
   `docs/ja/guides/`.

## Open Questions

1. **Server-side extension advertisement.** SEP-1865 specifies the client's
   `extensions["io.modelcontextprotocol/ui"]` but says nothing about the
   server's. Laravel MCP advertises it on the server too. Advertising an empty
   object is harmless; is there a value hosts expect (supported MIME types, a
   version)?
2. **Bundle size.** Each document carries React, the page, the bridge and the
   `App` client (about 38 KB before its `@modelcontextprotocol/client`, `core` and
   `zod` dependencies). Is a size budget worth enforcing in the build, and should
   the bridge talk the protocol directly over `postMessage` (the specification
   shows it needs no SDK) to drop `zod` from every view?
3. **Layout in a narrow frame.** Pages usually sit inside an app layout with
   navigation. Should the bridge render the page without its persistent layout
   by default, with a way for a page to opt back in?
4. **Host theming.** Hosts pass standardized CSS variables (colours, fonts,
   radii). Mapping them onto the RFC 0036 tokens in the generated entry would
   make views match the host; is that the right default, or should views keep
   the app's own look?
5. **Shared props.** Should `mcpPlugin({ ui })` take a list of shared props to
   strip from MCP App results (`_i18n` is large and rarely needed), or is that the
   app's job in `share()`?
6. **The model's text for a UI tool.** With a view showing the page, the model
   may need much less than `page.props`. Should a `ui` route be able to declare
   a short text summary (a Resource, or a function of the props) for `content`?
7. **Display modes and `ui/update-model-context`.** Which of these should the
   bridge drive automatically (for example, request fullscreen for an edit
   form), and which stay explicit calls through `useMcpApp()`?
8. **Guren as a host.** This RFC makes a Guren app an MCP Apps *server*. The AI
   SDK's host pieces (`splitMCPAppTools`, `readMCPAppResource`,
   `MCPAppRenderer`) would let `@guren/plugin-ai` (RFC 0029) render the views of
   remote MCP servers its in-process agents call, inside the app's own chat UI.
   That is a separate proposal; the question here is only whether anything in
   this one (the `dev.guren/*` result keys, the bridge) should be shaped now so
   a Guren-hosted view of a Guren server needs no second path.
