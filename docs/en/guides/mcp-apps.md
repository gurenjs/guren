# MCP Apps

An MCP App renders a tool's result as a page inside the agent's host. With Guren, the page is the Inertia page the route already renders: add `ui` to a route's `.agent()` declaration, build the views, and a host that supports MCP Apps, such as Claude on the web, shows `posts/Show` where it would otherwise print the post as text. Links and forms inside the view keep working: each Inertia visit becomes a call to the matching tool.

This builds on the [Agent Interface](./agent-interface.md): the route must already be an agent tool served by `mcpPlugin()`.

## Declaring a view

Pass the page to `ui`. The generated page contract is the usual form, and a page id string works too:

```ts
import { Router } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { PostController } from '@/app/Http/Controllers/PostController'

export function registerWebRoutes(router: Router): void {
  router.get('/posts', [PostController, 'index']).name('posts.index')
    .agent({ description: 'List the latest posts.', ui: pages.posts.Index })
  router.get('/posts/:id', [PostController, 'show']).name('posts.show')
    .agent({ description: 'Show one post.', ui: pages.posts.Show })
}
```

The page receives exactly the props the controller passes to `this.inertia()`, so nothing in the controller changes.

A tool can also be one only the view calls. An `update` route that redirects renders no page of its own, but the edit form inside `posts/Show` submits to it. Declare it with `visibility` and no page:

```ts
router.put('/posts/:id', [PostController, 'update']).name('posts.update')
  .agent({ description: 'Update a post.', ui: { visibility: ['app'] } })
```

`visibility` defaults to `['model', 'app']`. With `['app']` the model never sees the tool in its tool list; only a view can call it.

`bunx guren tool:list` shows the declaration in its `UI` column, and `bunx guren tool:inspect posts.show` prints it on a `UI:` line:

```text
UI:            page posts/Show; visible to model, app
```

## Building the views

A host loads each view as one self-contained HTML document with nothing to fetch, so the views are a build of their own. Install the MCP Apps client once:

```bash
bun add @modelcontextprotocol/ext-apps
```

Then build:

```bash
bunx guren codegen
bunx vite build --mode mcp-app
```

The build writes one document per page that a `ui` route names, and `.guren/mcp-app/index.gen.ts`, the module the plugin serves them from. A scaffolded app's `build` script already ends with this step, and with no `ui` route it builds nothing.

The first build also writes `resources/js/mcp-app.tsx`, the setup every view mounts with. It imports the app's stylesheet and wraps the page in an error boundary. The file is yours from then on: keep its providers in step with `resources/js/app.tsx`.

## Serving the views

Point `mcpPlugin()` at the built module:

```ts
import { mcpPlugin } from '@guren/plugin-mcp'

mcpPlugin({
  serverInfo: { name: 'blog', version: '1.0.0' },
  ui: {
    pages: () => import('@/.guren/mcp-app/index.gen'),
    presentation: { 'posts/Show': { prefersBorder: true } },
    sharedProps: ['_i18n'],
  },
})
```

| Option | What it does |
|---|---|
| `pages` | The built module. Imported, so every deploy bundler inlines the views. |
| `presentation` | Per page. `prefersBorder` asks the host to draw a frame around the view. |
| `sharedProps` | The shared Inertia props a tool call carries. None by default, so a `share()` resolver does not run for a tool call; name the ones the layout needs, such as translations. |
| `csp` | Origins the views may load from or connect to (`resourceDomains`, `connectDomains`, `frameDomains`, `baseUriDomains`). |

`tools/list` now carries each view's `ui://` address, versioned by the build's content hash, and the endpoint serves the documents through `resources/read`. A page the build has not produced is listed without a view, and the server warns once at startup.

The views run under an empty CSP by default: no network access and no external images, fonts or scripts. Everything the build inlines works. An image the app serves itself, such as an uploaded cover, does not load until its origin is in `resourceDomains`. Each origin you add widens what every view may reach.

## Inside a view

The view renders the page with the props from the tool's result, then answers each Inertia visit itself:

- A visit whose method and path match a tool runs that tool through the host, and the page it returns replaces the current one. Validation errors come back as the form's `errors`, as in the browser.
- A redirect is followed through the matching tool, up to five hops.
- A visit to a page this view does not bundle, or to a route that is not a tool, opens in the browser instead. Each document holds one page, so a link from `posts/Index` to `posts/Show` leaves the view.
- A tool that needs [approval](./agent-tool-governance.md) leaves the page as it is and reports the pending request.

`useMcpApp()` from `@guren/inertia-client/mcp-app` tells a page or layout where it is running:

```tsx
import { useMcpApp } from '@guren/inertia-client/mcp-app'

export default function Layout({ children }: { children: React.ReactNode }) {
  const app = useMcpApp()
  return (
    <>
      {app.isMcpApp ? null : <Navigation />}
      {app.refusal ? <p>{app.refusal.message}</p> : null}
      {children}
    </>
  )
}
```

| Field | Meaning |
|---|---|
| `isMcpApp` | The page is running inside a host. False in the browser. |
| `interactive` | Visits can become tool calls. False when the host offers no tool calls or the server speaks another version of the view protocol. |
| `pendingApproval` | The request a visit is waiting on, while an approver decides. |
| `refusal` | The last visit the view could not carry out, with a `url` to open the page in the application. |
| `hostContext` | What the host reports about itself: theme, display mode, container size. |
| `sendMessage()`, `updateModelContext()`, `openLink()` | Ask the host to post a message, add context for the model, or open a link. |

A tool call is not an Inertia request, so [deferred props](./inertia.md) are never resolved inside a view. Keep the props a `ui` page needs on the first response.

## Previewing in the Dev Center

With the dev server running under `GUREN_MCP=1` (the scaffolded `dev` script sets it), open `http://localhost:3333/_guren/mcp-apps`. The preview is a host of its own: it calls the tool through your app's App MCP endpoint and renders the view through a sandbox on a second origin, under the view's CSP, as a web host does.

1. Issue a token for the user the tools should run as:

   ```bash
   bunx guren token:issue --name dev-center --user 1 --tools tools:read --expires 12h
   ```

2. Paste the token and select **List tools**. The page lists every tool with a view that the token can see. The token stays in the page's memory and is sent only to the endpoint on the same origin.
3. Enter the tool's arguments as JSON and select **Call and render**.

The **Messages** list beside the view shows everything the host and the view exchange: the tool input and result, each visit's tool call, size changes. A link the view asks to open and a message it drafts for the conversation are listed there rather than opened or sent.

The sandbox is served on `127.0.0.1` for a Dev Center opened on `localhost`, so the two never share an origin. Opened on any other host, the page asks you to switch to `localhost`.

## Trying a real host

A remote host reaches your endpoint over HTTPS, so a local app needs a tunnel in front of it. Two things trip up a first run:

- The host signs in with whatever its connector supports. A connector that offers only OAuth or no authentication cannot send the bearer token the endpoint expects; see [Serving the tools](./agent-interface.md#serving-the-tools) for the options.
- A host may cache the tool list for the life of a connection. After a new build, reconnect so it reads the new `ui://` addresses.

## What the checks enforce

`bunx guren check` reads every `ui` declaration:

| Check | Fails or warns when |
|---|---|
| `agent-route-ui-page` | `ui` names a page that `.guren/pages.gen.ts` does not have. |
| `agent-route-ui-shape` | `ui` is malformed (an empty page id, an unknown or empty `visibility`). The tool is left out rather than shown to the model. |
| `agent-route-ui-output` | The route declares both a page and an `output` schema. The two cannot describe one response. |
| `agent-route-ui-renders` | The action never renders the named page, so the view would never receive it (warning). |
| `agent-route-ui-deferred` | The action passes a deferred prop, which a view never resolves (warning). |
| `agent-route-ui-visibility` | `visibility: ['app']` on a route not exposed over MCP, which no host could call (warning). |
| `agent-route-ui-pages-module` | Routes declare pages but `mcpPlugin()` has no `ui` option (warning). |

## Related

- [Agent Interface](./agent-interface.md): declaring tools and serving them over MCP
- [Control and Audit Agent Tool Access](./agent-tool-governance.md): scopes, approval and audit for the calls a view makes
- [API Tokens](./api-tokens.md): issuing and revoking the tokens a host uses
- [Inertia](./inertia.md): pages, props and visits
