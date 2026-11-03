# RFC: MCP Apps — Rendering Agent Tool Results with the Application's Inertia Pages

**Author:** 7nohe
**Date:** 2026-11-03
**Status:** Accepted (2026-11-03; the standard two-week discussion window was
shortened by the deciding maintainer for this solo-driven change)

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
  cloning a function throws. What is stored is `{ page?: 'posts/Show',
  visibility? }`, plain data.
- The specification makes `resourceUri` optional, so a tool may carry only
  `visibility`. That is the shape of a write a view performs: `posts.update`
  ends in a redirect, renders nothing, and needs no template of its own.
- Presentation belongs to the page, not to the route, so two routes naming one
  page cannot disagree about it: `prefersBorder` is set per page in the plugin
  configuration (§3).
- A route that imports `pages` from `@/.guren/pages.gen` adds no new ordering
  constraint: controllers the routes file imports already import it, and
  `guren codegen` writes the pages artifact before it loads the routes file.

### 2. Derivation and codegen

`DerivedAgentTool` (`packages/server/src/agent/derive.ts`) gains:

```ts
interface DerivedAgentToolUi {
  /** The Inertia page id, verbatim. Absent for a tool that only a view calls. */
  page?: string
  visibility: Array<'model' | 'app'>
}

interface DerivedAgentTool {
  // ...existing fields
  ui?: DerivedAgentToolUi
}
```

`deriveAgentTools()` stays total. It does not know which pages exist, so it
never refuses a page id; it validates only shape (an empty id, a visibility
entry other than `model`/`app`, an empty visibility list, a `ui` object with
neither `page` nor `visibility`). **A malformed `ui` never widens a tool:**
dropping `ui` would turn an app-only tool into one the model sees, since the
specification defaults an omitted `visibility` to both audiences. So a tool
whose `ui` is malformed is left out of the derived set, with a warning naming
the route, and `guren check` fails on it.

`.guren/agents.gen.ts` carries `ui` like every other derived field, so
~~`guren tool:list` and `guren tool:inspect` show it and~~ the WebMCP client
ignores it. **Amended in implementation (Phase 1):** `tool:list` and
`tool:inspect` print `ui` in Phase 3, with the rest of the developer surface. Codegen also writes the set of UI pages the MCP App build needs (§4)
into the same file, as `agentUiPages`, so the build reads one generated input
and never loads the routes file. The manifest itself is never bundled into a
view (§5).

`guren check` gains, in `agent-route-check.ts`:

- **`agent-route-ui-page`** (fail): `ui.page` names no page in
  `.guren/pages.gen.ts`. The `PageContract` form makes this a type error first;
  the string form needs the check.
- **`agent-route-ui-shape`** (fail): the malformed `ui` the derivation left out.
- **`agent-route-ui-output`** (fail): `ui.page` together with an `output`
  schema. The router validates `output` against the whole JSON response
  (`Router.ts`, the output check that rebuilds the body from the parsed value),
  which for an Inertia action is the page envelope, not its props, and
  `unwrapInertiaProps()` returns the envelope unchanged whenever an output
  schema exists. The two cannot describe one response; the model's text for a
  `ui` tool is set by §6 instead.
- **`agent-route-ui-renders`** (warn): the action's `renders` edges (the
  Application Graph's `controller:<action>` evidence, RFC 0032) name pages and
  `ui.page` is not one of them. An action that only redirects (`store`) is the
  common case: its view would never receive a page. The suggestion is to drop
  `page` and keep `visibility` (§1).
- **`agent-route-ui-deferred`** (warn): the action passes a `defer()` prop. A
  tool call is not an Inertia request, so deferred props are never resolved for
  it (`readPartialReload()` in `mvc/inertia/props.ts` needs `X-Inertia` and the
  partial headers) and the view would wait for values that never arrive (§5).
- **`agent-route-ui-visibility`** (warn): `visibility: ['app']` on a route whose
  `expose.mcp` is `false`, which no host could ever call.
- `agent-route-inertia` keeps its wording for routes without `ui`. On a route
  with `ui.page`, an Inertia response is the declared design, so the finding is
  not raised.

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

**Configuration.** The plugin takes the built pages as a module (§4) and the
per-page presentation:

```ts
mcpPlugin({
  ui: {
    pages: () => import('@/.guren/mcp-app/index.gen'),
    presentation: { 'posts/Show': { prefersBorder: true } },
  },
})
```

**Resource URIs carry the build.** A page's URI is
`ui://<server>/pages/<page id>?v=<hash>`, where the hash is the content hash of
its built document, taken from the generated module. Hosts may cache a template
per URI, and the bridge inside it speaks a contract with this server
(`dev.guren/*`, §6); a new build is a new URI, so a cached template never
outlives the server it was built for.

**`tools/list`.** `describeTool()` adds, for a tool with `ui.page`:

```json
"_meta": {
  "ui": { "resourceUri": "ui://blog/pages/posts/Show?v=3f9a1c2e", "visibility": ["model", "app"] },
  "ui/resourceUri": "ui://blog/pages/posts/Show?v=3f9a1c2e"
}
```

The flat key is written for the same reason `registerAppTool()` writes it:
hosts that predate the nested form read only that. It is dropped when the
specification removes it ("before GA"). A tool with `visibility` and no `page`
gets `"_meta": { "ui": { "visibility": ["app"] } }` and no flat key. The tool is
listed only if `gateToolCall()` admits it, as today; `visibility` changes
nothing about that filter (§7).

**Always annotated, never negotiated.** The specification says servers
"SHOULD check client capabilities before registering UI-enabled tools". The App
MCP endpoint cannot do that on both eras: on 2025-era connections the SDK hands
each request to a fresh, stateless server (`createMcpHandler()`, RFC 0028 §3),
so the server answering `tools/list` never saw that client's `initialize`. Only
2026-07-28 requests carry the client's capabilities, on the per-request
envelope. The specification also defines the fallback: a host without
MCP Apps ignores `_meta.ui` and reads `content`. So the annotation is
unconditional, and every UI tool keeps a meaningful text `content` (§6). One
consequence is stated in the guide: a host without the extension also ignores
`visibility`, so it shows an app-only tool to its model like any other. That is
acceptable only because `visibility` is not authorization (§7).

**`resources/list`.** One entry per distinct UI page among the tools the
caller's `tools/list` would show, with the listing-level `_meta.ui`
(`prefersBorder` from `presentation`, the CSP of §7), plus the bridge catalogue
(§5). The specification lets a server omit UI-only resources from the list;
listing them is what lets a host prefetch and review templates at connect time.

**`resources/read`.** For a page URI the caller's listing would contain:

```json
{
  "contents": [{
    "uri": "ui://blog/pages/posts/Show?v=3f9a1c2e",
    "mimeType": "text/html;profile=mcp-app",
    "text": "<!DOCTYPE html>…",
    "_meta": { "ui": { "csp": {}, "prefersBorder": true } }
  }]
}
```

Any other URI, including a page URI with a stale `v`, answers the SDK's
`ResourceNotFoundError`, which the installed SDK sends as `-32602` with the URI
in its data on every protocol revision (it maps a handler's `-32002` to
`-32602` at the era seam). Resource reads go through the same authentication
the endpoint already applies before any MCP framing, through the rate limiter,
~~and into the audit trail as their own event (`AgentResourceRead`), since a
template read is not a tool invocation.~~ **Amended in implementation (Phase 1):**
the audit event is not written yet. It needs a record kind beside the two the
trail stores today (`AgentToolInvoked`, `AgentToolDenied`) and a reader for it,
which is its own change; a resource read is authenticated and metered meanwhile.

**`tools/call`.** Unchanged for the pipeline. Only the result metadata differs
(§6).

**A missing build removes the template, never the visibility.** The
specification says the resource "MUST exist on the server". If a tool declares
`ui.page` and the app has no built HTML for its page, the plugin warns at boot
naming the route and the build command, and lists the tool without
`resourceUri` (and without the flat key) but **with** its `visibility`. A host
then falls back to text for that tool, and an app-only tool stays app-only.

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
`img-src 'self' data:`, `media-src 'self' data:` and `connect-src 'none'`, and
`'self'` is the sandbox's origin, not the app's. A page that loads
`/build/assets/app-1a2b.js` from the application cannot run there. Inline
scripts and styles are the one layout that works under the default with
nothing declared.

**Fonts are the exception.** The default has no `font-src`, so `default-src
'none'` governs fonts and a `data:` font is refused as well. A view uses the
system font stack unless the app declares a font origin in `resourceDomains`,
which §7 treats as a trust grant. The build does not inline web fonts.

**The application's setup.** Pages assume what the app's client entry provides:
its stylesheet (the blog imports `resources/css/app.css` from
`resources/js/app.tsx`), an `ErrorBoundary`, any providers. The build therefore
does not guess an import path. The first build writes
`resources/js/mcp-app.tsx`, owned by the app like `resources/js/ssr.tsx`, which
imports the stylesheet and exports the same `setup` the app entry passes to
`startInertiaClient()`; each generated page entry imports it. The Vite plugin
option `mcpApp.entry` names another file.

**The build.** The Guren Vite plugin gains a third mode beside the ordinary and
prototype builds, `vite build --mode mcp-app`:

- Reads `agentUiPages` from `.guren/agents.gen.ts`.
- Builds **one HTML document per page**, each from a generated entry that imports
  the app's `mcp-app.tsx` setup, that one page module, and the bridge of §5. Code
  splitting is off and every script and stylesheet is inlined, so each document
  stands alone.
- Writes `.guren/mcp-app/pages/<id>.html` and a generated module,
  `.guren/mcp-app/index.gen.ts`, mapping each page id to its HTML and content
  hash.

One document per page rather than one for the whole app follows from §7: a
document holds the code of every page it bundles, and a token that may call one
tool should receive one page's code. The cost is that React and the bridge are
repeated in every document, which matters little because a host caches per URI.

The app's `build` script gains `bunx vite build --mode mcp-app` after the
ordinary and SSR builds. `guren codegen` must run first, since the build reads
`agentUiPages`; the scaffold's `build` script already starts with it.

**Serving it on every deploy target.** Workers, Lambda and Vercel have no
filesystem to read `.guren/mcp-app/` from at runtime, which is why the plugin
takes the generated module (§3). The dynamic import lets every bundler (Bun.build
in the Lambda and Vercel plugins, wrangler's esbuild for Cloudflare per RFC 0035)
inline the strings into the server bundle, and costs an app without `ui`
nothing. This is a claim to prove, not a property of the design: Phase 2 builds
and deploys `examples/blog` on each target and records the bundle size. The first
route that declares `ui` is the moment to add the option: `guren check` reports
a `ui` route in an app whose `mcpPlugin()` call has no `ui.pages` option (read
through `plugin-calls.ts`, the reading `guren check` already uses for
`mcpPlugin()` options), with this line as the fix.

### 5. Inside the iframe: Inertia over the host

The generated entry calls `startMcpApp()` from a new browser-only subpath,
`@guren/inertia-client/mcp-app`, which mounts the page through the same internal
path `startInertiaClient()` uses (`mountInertiaApp()` in `src/app.tsx`).
Inertia 3 takes a custom `HttpClient`, and the prototype mode (RFC 0021)
already passes one there to answer visits from a fixture
(`createPrototypeHttpClient()`). The MCP App mode passes one that answers
visits through the host. An `HttpClient` replaces the transport only, so the
bridge also has to own the parts of a visit Inertia hands to the browser.

**Two URLs.** Inertia writes each page's `url` into `window.history`
(`replaceState()`/`pushState()`) and reloads from `window.location.href`. In the
iframe those address the sandbox document, and a history entry on another origin
throws. So the page object the bridge gives Inertia carries the app-relative
path (`/posts/12`) as its `url`, and the application's absolute URL travels
beside it in `dev.guren/response` (§6), used only for a hand-off to the browser.
Relative links resolve against that logical path, back and forward move within
the view's own visits, and `router.reload()` re-runs the tool call that produced
the current page. **Phase 2 starts by proving this** in a real sandbox (the
ext-apps reference host and Claude): initial mount, `router.reload()`, a
relative `<Link>`, back and forward. If Inertia 3 cannot run without writing
history in a sandboxed document, the bridge keeps an in-memory history and the
RFC is amended before anything else is built on it.

**The bridge catalogue.** To turn a visit into a tool call the bridge needs the
method, path and input sources of the tools the caller may call. It does not
bundle `agents.gen.ts`: that manifest names every tool, its description,
schemas, policy ability and approval and redaction settings, and a template is
handed to every token that can see one page. Instead the view reads
~~`ui://<server>/bridge?v=<hash>`~~ `ui://<server>/bridge` with
`readServerResource()` after connecting. **Amended in implementation (Phase 1):**
no build hash, since the catalogue is computed per request and never cached as
a template. The server answers it per caller, from the same filter as `tools/list`, with
`{ toolName, method, path, inputSources }` per tool in route registration
order (**amended:** plus `inputBodyNested` and `bridgeable`, false for a tool
whose derivation reported an input-name collision, `DerivedAgentTool.inputCollisions`). What this discloses beyond `tools/list` is the method and path of tools
the caller can already call, which the guide states.

1. **Initial page.** The bridge connects `App` from
   `@modelcontextprotocol/ext-apps`, reads the host's capabilities from the
   `ui/initialize` result, and waits for `ontoolresult`. The result's
   `_meta["dev.guren/inertia-page"]` (§6) becomes `initialPage`. Until it arrives
   the document shows the page's skeleton state. An error result shows its
   message; `ui/notifications/tool-cancelled` shows that the call was cancelled
   rather than waiting for a result that will not come.
2. **Which visits it takes.** The bridge answers a visit only when all of these
   hold, and otherwise treats it as unmatched (step 5):
   - its URL is relative or on the application's origin;
   - a catalogue tool matches its method and path, the first in registration
     order, as the router would pick it (`PATH_PARAM_PATTERN`, today in
     `packages/server/src/internal/route-path.ts`, exported through the
     browser-safe `@guren/core/agent` subpath);
   - the tool's derivation reported no input-name collision (`derive.ts` lets
     the later source win, so a path `id` and a body `id` cannot both travel in
     one flat argument object);
   - the body is JSON-representable: no `File` or `Blob`. Query strings are
     read back with the conventions `buildToolRequest()` writes them in.
   The visit is then `app.callServerTool({ name, arguments })`, the inverse of
   `buildToolRequest()`.
3. **Partial reloads and deferred props.** A tool call is a full request:
   `buildToolRequest()` sends `Accept: application/json` and no `X-Inertia`, so
   `only`/`except` reloads are sent as full visits (correct, heavier) and
   deferred props are never resolved. Phase 2 supports exactly that, and
   `agent-route-ui-deferred` (§2) warns on the pages it breaks. A channel for
   the partial headers is Open Question 5.
4. **The answer.** The bridge reads `_meta["dev.guren/response"]` (§6), never
   the text `content`, which is written for people and models and has no
   format anyone promised. Every tool call settles the visit:
   - `executed` with an Inertia page: the page is handed back to Inertia, which
     clears the previous validation errors.
   - `executed` with a redirect: 301, 302 and 303 are followed as `GET`, 307
     and 308 with the same method and body, each through step 2 again, at most
     five hops (the prototype's `MAX_REDIRECT_HOPS`). A location off the
     application's origin is a hand-off, not a visit.
   - `executed` with 422: the bridge builds an Inertia response for the current
     component with `props.errors` set, one message per field as Inertia
     expects (the server's JSON 422 carries arrays, as
     `InertiaServiceProvider` answers a non-Inertia request), under the visit's
     error bag, exactly as the prototype's `errors()` answer does. The form
     keeps its state and `onError` runs.
   - `executed` with anything else (a JSON body, 204): the visit cannot be
     rendered as a page and becomes a hand-off for a `GET`, an error for
     anything else.
   - `denied` with a pending approval: the visit settles without changing the
     page, and `useMcpApp().pendingApproval` holds the request. While the view
     is open the bridge polls `guren_approval_status`; once it reads
     `approved`, `pendingApproval.resubmit()` repeats the call with the same
     arguments, which is what the gate requires (approval executes nothing by
     itself). `rejected` and `expired` settle it as a form error.
   - `denied` for any other reason, or `failed`: the visit fails with the
     message, and `onError` runs.
5. **Unmatched visits.** A `GET` no tool answers opens the application in the
   browser through `ui/open-link`, at the absolute URL. A mutation no tool
   answers is never handed off as if it could succeed: the visit fails with
   "not available here", and the view offers a link to the current page in the
   application. A page component the document does not bundle is handled like
   an unmatched `GET`.
6. **Host capabilities.** `serverTools` and `openLinks` are optional host
   capabilities. Without `serverTools` the view is read-only: every visit is
   unmatched, and forms say so. Without `openLinks` a hand-off shows the URL as
   text to copy.

**Pages written for the browser mostly just work.** What does not: anything
that reads `window.location`, uses cookies, or calls `fetch` directly, because
the iframe has no network and no session. The `useMcpApp()` hook from the
subpath exposes `isMcpApp`, the host context (theme, display mode, locale),
`pendingApproval`, and `sendMessage()` / `updateModelContext()` for pages that
want to talk to the conversation. Pages opt into those deliberately; the bridge
never sends a message or updates the model context on its own.

### 6. The tool result

The text `content` and `structuredContent` keep their current rules. What
changes is the props that reach them, and the result's `_meta`, which MCP Apps
hands to the view and the host does not put in the model's context. Two keys,
under Guren's reverse-DNS prefix as the MCP `_meta` key rules ask of a vendor:

```json
{
  "content": [{ "type": "text", "text": "{\"post\":{\"id\":12,\"title\":\"…\"}}" }],
  "_meta": {
    "dev.guren/response": {
      "outcome": "executed",
      "status": 200,
      "url": "https://blog.example.com/posts/12"
    },
    "dev.guren/inertia-page": {
      "component": "posts/Show",
      "props": { "post": { "id": 12, "title": "…" } },
      "url": "/posts/12",
      "version": "a1b2c3"
    }
  }
}
```

**`dev.guren/response` on every route tool.** The bridge must be able to settle
any visit it sends, so the envelope is not limited to tools with `ui`: the
plugin's `tools/call` handler writes it on every result for a route tool,
whichever of the pipeline's three results it is. A denial and a failure never
reach `mapToolResponse()` (the pipeline refuses approval and scope before
dispatch, and `denial()` in `server.ts` renders text blocks), so the envelope is
built at the adapter boundary, from the pipeline's result:

```ts
type GurenToolResponse =
  | { outcome: 'executed'; status: number; url?: string; location?: string; errors?: Record<string, string[]> }
  | { outcome: 'denied'; reason: AgentToolDenialReason; message: string; approval?: { requestId: string; status: AgentApprovalStatus } }
  | { outcome: 'failed'; message: string }
```

`ToolCallOutcome` gains the HTTP facts `mapToolResponse()` already reads
(`location`, the 422 `errors` object) as fields, so the adapter never parses
its own text. `url` and `location` are made absolute in the adapter, from the
~~app's configured URL~~ origin the MCP request reached the endpoint on
(**amended in implementation:** the same origin the re-entrant request is
already dispatched with, so a host-authorization middleware and the hand-off
agree on the app's address); `mapToolResponse()` cannot, since it also runs in the
browser for the WebMCP client (through `@guren/core/agent`) and has no
application URL. The text stays as it is, so a reworded message never breaks a
view, the same reason `DerivedAgentTool.warnings` exists beside the prefixed
lines.

**`dev.guren/inertia-page`** is present when the response carries
`X-Inertia: true`, with the app-relative `url` of §5. **Amended in
implementation (Phase 1):** only for a tool whose `ui` names a page. A page no
view renders is not handed to a third-party frame.

**What props leave the application.** The page object goes to the host and into
a third-party iframe, and today the same props already reach the model as text.
Shared props (`Controller.inertia()` merges every resolved shared prop into the
page) are the part an author does not see at the call site: `auth.user`, flash
messages, the `_i18n` catalogue. One policy governs both destinations, decided
here rather than left to `share()`:

- On a request the agent dispatch makes ~~(the agent surface header, which App MCP
  sets on its own in-process request)~~, `Controller.inertia()` resolves **only
  the shared props named in `mcpPlugin({ ui: { sharedProps: [...] } })`**,
  default none. ~~Unlisted lazy shared props are never evaluated.~~
  **Amended in implementation (Phase 1):** the allowlist is installed by the
  agent pipeline (`AgentInvocationOptions.sharedProps`) on the exact `Request`
  it dispatches, the seam the principal handoff uses (RFC 0017 §2), not read
  from the surface header: `buildToolRequest()` defaults that header to `mcp`,
  so `TestApp.agent()` and `guren tool:call` would have been narrowed too, and
  nothing on the wire can now set or widen it. An empty allowlist runs no
  `share()` resolver; a non-empty one runs them all, since one resolver returns
  several keys, and drops the unlisted keys afterwards.
- The action's own props are sent; the controller chose them for that page.
- The text `content` is the same projected `page.props`, so the model reads no
  more than the view receives.

~~The header can be sent by a browser on a WebMCP call, but sending it only
withholds shared props from the response, so a forged one discloses nothing.~~
A shorter model-facing summary for `ui` tools (a Resource or a function of the
props) is an additive option for later; the default is the projected props.

### 7. Authentication, authorization and security

**One principal, one pipeline.** A call from the view travels view → host →
server over the host's existing MCP connection, with the bearer token (or the
external-auth identity) the host already holds. Guren receives an ordinary
`tools/call`. Scopes, the tool's policy ability, the approval queue, rate
limits and the audit trail apply exactly as they do to a call the model makes,
because they are the same code path (`AgentInvocationPipeline`). Nothing new is
trusted.

**The server cannot tell the view from the model.** The host proxies both, and
nothing in the request distinguishes them in a way the server could verify:

- `visibility: ['app']` hides a tool from the model's list in a compliant
  host. It is not authorization. Any client holding the token can call the
  tool, and a host without the extension lists it to the model (§3), so it must
  be guarded by the same scopes and policies as any other write. `guren audit`
  treats an app-only tool exactly like a model-visible one.
- The audit trail records the call on the `mcp` surface. Whether a person
  clicked a button or the model chose the tool is not recorded, because it is
  not known. A host-supplied hint (if one is standardized) would be recorded as
  a client claim, as `X-Guren-Agent-Surface: webmcp` is today.

**Template access is a publication rule, not route authorization.** A page's
HTML contains its component code and its layout. The listing filter of §3 is
the scope gate `tools/list` uses (`gateToolCall()`): it admits a token whose
scopes reach a tool naming the page. Route middleware and controller policies
run only when a call is dispatched, with a record to judge, so a token whose
call a policy would refuse can still read the template. That is the rule, stated
as such: **scope admission publishes the page's code to the token**. Templates
carry no data (the data comes in results, which the full pipeline guards), and
the build is per page (§4) so one admission publishes one page.

**CSP.** Guren declares an empty `csp` by default: the inlined document needs no
external origin. Under that default `connect-src` is `'none'` and no external
script, style, image or font loads, so the view reaches nothing except through
the host's tool calls. Every origin an app adds widens that, and `guren audit`
warns on each (**amended in implementation:** the audit warnings land in Phase 3
with the rest of the developer surface; Phase 1 passes the declared origins
through):

```ts
mcpPlugin({
  ui: {
    pages: () => import('@/.guren/mcp-app/index.gen'),
    csp: { resourceDomains: ['https://cdn.example.com'] },
  },
})
```

- `resourceDomains` is not an image allowance. The specification maps it to
  `script-src`, `style-src`, `img-src`, `font-src` and `media-src` together, so
  the origin is trusted to run code in the view, and every image request to it
  can carry data out. A shared CDN or a storage bucket other tenants can write
  to is the risky case the warning names.
- `connectDomains` warns more strongly: a view with network access to the
  application can bypass the tool pipeline entirely if a session or token is
  reachable.
- `frameDomains`, `baseUriDomains`, `permissions` (camera, microphone,
  geolocation, clipboard) and `domain` are passed through as declared; `domain`
  is host-specific in the specification, so Guren does not validate it.

**Production.** UI is opt-in per route, served only on the App MCP endpoint,
which is already a production endpoint guarded by bearer or external auth and
mounted only when the app registers the plugin. `createMcpAccessGuard()` and
its loopback rules stay where they are, on the development endpoint, which
serves no UI. The development preview (§8) is the one place they meet.

### 8. Development preview

Testing a view today needs a real host. `@modelcontextprotocol/ext-apps/app-bridge`
is the host half of the protocol, so the Dev Center (`/_guren`) can render a
tool's view, call the tool through the local App MCP endpoint with a development
token, and show the messages exchanged. A sandboxed iframe is not enough: the
specification requires a web host to load the view through a sandbox proxy on
**a different origin** from the host page. So:

- The host page is the Dev Center on the app's origin. The proxy is served from a
  second origin the dev server binds only for this (the same port on
  `127.0.0.1` when the app is opened on `localhost`, otherwise a second loopback
  port), and loads the view with the CSP of §7 applied.
- Every message is checked for its source window and origin at the host and at
  the proxy, and the proxy forwards only what the specification lets it forward.
- The development token stays in the host page. Neither the proxy nor the view
  ever holds it; tool calls go host → endpoint, as in a real host.
- Both origins mount only under the Dev MCP endpoint's guard (`NODE_ENV` not
  `production`, loopback peer). That guard limits who can reach the preview; the
  separate origin is what isolates the view.

It lists only tools with `ui.page` and comes after the protocol pieces (Phase 3).

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

**Bundle the agent manifest into each view.** Simpler than a catalogue
resource, and it would let the bridge match visits offline. Rejected: every
token that can see one page would receive the description, schemas, policy
ability and approval settings of every tool (§5).

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

Additive for an app that declares no `ui`. One change reaches every App MCP
result: `dev.guren/response` in `_meta` (§6), which existing clients ignore,
as `_meta` is defined to be ignorable. Otherwise:

- A route without `ui` derives the same tool, the same `tools/list` entry, and
  the same text and structured content as today.
- `@guren/plugin-mcp` advertises `resources` and the extension only when at least
  one tool declares `ui`; an app with none serves the same capabilities as today.
- The shared-prop projection (§6) applies to agent-dispatched requests only, so
  an app's browser responses are unchanged. It does narrow what an agent
  already receives from an Inertia action today; the changeset says so, and an
  app that relied on a shared prop in a tool's text lists it in `sharedProps`.
- `@modelcontextprotocol/ext-apps` becomes a dependency of
  `@guren/inertia-client` behind the browser-only `./mcp-app` subpath (an
  optional peer of the root), so apps that never build an MCP App install
  nothing new.

Phases:

1. **Server half.** `AgentRouteMetadata.ui`, its normalization, `DerivedAgentTool.ui`,
   `agents.gen.ts` and the `guren check` rules (§1–§2); `_meta.ui` in
   `tools/list`, `resources/list` / `resources/read` with versioned URIs, the
   bridge catalogue, `dev.guren/response` on every route tool, the shared-prop
   projection, and the missing-build behaviour (§3, §6). Testable with a
   hand-written HTML string.
2. **Build and bridge.** First the sandbox spike of §5 (history, reload,
   relative links). Then the `mcp-app` Vite mode with the app's `mcp-app.tsx`,
   the generated module, the `@guren/inertia-client/mcp-app` subpath with the
   Inertia `HttpClient` and `useMcpApp()`, and a deployed build of
   `examples/blog` on each deploy target (§4–§5), proven end to end against a
   real host.
3. **Developer surface.** The Dev Center preview with its separate-origin proxy
   (§8), `guren tool:inspect` output, the scaffold `build` script, and a guide
   under `docs/en/guides/` and `docs/ja/guides/`.

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
   radii). Mapping them onto the RFC 0036 tokens in `mcp-app.tsx` would make
   views match the host; is that the right default, or should views keep the
   app's own look?
5. **Partial reloads and deferred props.** Supporting them means sending the
   Inertia partial headers on the dispatched request. That cannot ride in the
   tool's arguments (they are the route's input), and adding `X-Inertia` also
   switches the server to version negotiation and to the session-flash path for
   validation errors (`InertiaServiceProvider`), neither of which a stateless
   tool call has. Is a bounded request context in `tools/call`'s `_meta` (which
   a host may not forward from a view) worth specifying, or do `ui` pages simply
   not defer?
6. **Display modes and `ui/update-model-context`.** Which of these should the
   bridge drive automatically (for example, request fullscreen for an edit
   form), and which stay explicit calls through `useMcpApp()`?
7. **The approval wait.** The bridge polls `guren_approval_status` only while
   the view is open. Should a host-side notification (a `ui/message` drafted for
   the user to send, or a server notification once subscriptions exist) cover
   the case where the view is closed before approval?
8. **Guren as a host.** This RFC makes a Guren app an MCP Apps *server*. The AI
   SDK's host pieces (`splitMCPAppTools`, `readMCPAppResource`,
   `MCPAppRenderer`) would let `@guren/plugin-ai` (RFC 0029) render the views of
   remote MCP servers its in-process agents call, inside the app's own chat UI.
   That is a separate proposal; the question here is only whether anything in
   this one (the `dev.guren/*` result keys, the bridge) should be shaped now so
   a Guren-hosted view of a Guren server needs no second path.
