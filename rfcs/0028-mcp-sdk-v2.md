# RFC: MCP 2026-07-28 Support Through SDK v2

**Author:** 7nohe
**Date:** 2026-09-15
**Status:** Accepted (2026-09-15; the standard two-week discussion window was
shortened by the deciding maintainer for this solo-driven change)

## Problem

The MCP specification revision
[2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28) removes the
`initialize` handshake and `Mcp-Session-Id`. Every request now carries its protocol
version, client identity and capabilities in `_meta`, Streamable HTTP requests must
send `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name`, and servers must implement
`server/discover`. The spec calls revisions up to 2025-11-25 *legacy* and the new one
*modern*, and its
[compatibility matrix](https://modelcontextprotocol.io/specification/2026-07-28/basic/lifecycle)
is explicit about one pairing: a modern-only client against a legacy server fails.

Both of Guren's MCP endpoints are legacy servers:

| Endpoint | Code | SDK |
|---|---|---|
| Dev MCP (`GUREN_MCP=1`, `/_guren/mcp`) | `packages/server/src/mcp/create-mcp-server.ts`, `McpServiceProvider.ts` | `@modelcontextprotocol/sdk@1.30.0` |
| App MCP (`@guren/plugin-mcp`, RFC 0016 §7) | `packages/plugin-mcp/src/server.ts`, `plugin.ts` | `@modelcontextprotocol/sdk@1.30.0` |

SDK 1.30.0 declares `LATEST_PROTOCOL_VERSION = '2025-11-25'`, and the 1.x line is
maintenance-only. The modern revision is implemented by the replatformed SDK v2
(`@modelcontextprotocol/server`, `core`, `client` 2.0.0), which serves both eras from
one endpoint. RFC 0017 recorded this migration as future work and kept it out of its
scope (`rfcs/0017-durable-agent-runtime.md:337-344`).

Dual-era clients fall back to `initialize` today, so nothing is broken yet for them.
What is missing is the modern half: modern-only clients, `server/discover`, cacheable
list results, and the extensions framework.

### Why this is more than a dependency bump

**The APIs Guren calls are gone or reshaped.**

- v2's `McpServer` no longer has the variadic `tool()`, `resource()` and `prompt()`
  methods. The Dev MCP registers through them at 17 call sites (12 tools, 3
  resources, 2 prompts in `create-mcp-server.ts`).
- The low-level `Server.setRequestHandler` is keyed by method name
  (`'tools/call'`) instead of a request schema (`plugin-mcp/src/server.ts:104,128`).
- Serving both eras goes through `createMcpHandler(factory)`. Its factory receives
  only `{ era, authInfo, requestInfo }`, while `plugin-mcp/src/plugin.ts:172-255`
  builds each request's server from the principal, abilities, approval context,
  invocation pipeline, `c.env` and `executionCtx`.

**The deploy stubs cannot express their current rule.** Production bundles replace
the Dev MCP with throwing stubs keyed on exact module specifiers
(`packages/core/src/internal/deploy-build.ts:362-376`). RFC 0016 Phase 4a keeps one
of those entries, the App MCP transport, unstubbed for apps that depend on
`@guren/plugin-mcp` (`stubbableDevOnlyModules`, `deploy-build.ts:421-429`). That works
because v1 exposes `McpServer` and `WebStandardStreamableHTTPServerTransport` from
different subpaths. v2's server package exports only `.`, `./stdio`,
`./validators/*` and `./_shims`: both names come from the root, so "stub the Dev MCP,
keep the transport" has no specifier to key on.

Changing the stub key is not free either. Cloudflare aliases live in the app's
committed `wrangler.jsonc`, which the scaffold writes once and never overwrites
(`packages/plugin-cloudflare/src/build.ts:1397-1404`). A missing key only produces a
warning (`warnMissingBuildOwnedKeys`, `build.ts:1566-1583`), so an existing app would
build successfully and ship the real Dev MCP code.

## Proposed Solution

Move both endpoints to SDK v2 in one release, serving both eras. Put the Dev MCP's
SDK usage behind `@guren/cli`, a specifier that is already stubbed everywhere, so no
SDK specifier needs stubbing at all. No package takes a major.

### 1. The Dev MCP server moves behind `@guren/cli`

`@guren/cli` gains one export:

```ts
// packages/cli/src/dev-mcp/handler.ts
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'

export interface DevMcpHandler {
  fetch(request: Request): Promise<Response>
  close(): Promise<void>
}

export function createDevMcpHandler(options: { cwd: string; version?: string }): DevMcpHandler
```

It owns what `create-mcp-server.ts` does today, rewritten for v2: `registerTool`,
`registerResource` and `registerPrompt` with config objects, raw zod shapes wrapped
in `z.object()` (the repo's zod 4.5.4 satisfies v2's `^4.2.0`), and one boot-time
`createMcpHandler` with the default `legacy: 'stateless'`. Because the handler lives
in the CLI, it calls the CLI's context, check and codegen functions directly instead
of through the `GurenCliApi` namespace the server passes in today.

`McpServiceProvider` shrinks to wiring:

```ts
const cli = (await import('@guren/cli')) as GurenCliApi
if (typeof cli.createDevMcpHandler !== 'function') {
  throw new Error(
    `GUREN_MCP=1 needs @guren/cli ${DEV_MCP_CLI_VERSION} or later; the installed CLI predates the 2026-07-28 MCP endpoint.`,
  )
}
const handler = cli.createDevMcpHandler({ cwd })
hono.use(MCP_ENDPOINT_PATH, createMcpAccessGuard())
hono.all(MCP_ENDPOINT_PATH, (c) => handler.fetch(c.req.raw))
```

~~A CLI without the factory throws.~~ **Amended in implementation:** the provider
warns and leaves the endpoint unmounted, both for a CLI that predates the factory and
for one that cannot be imported. `Application.mountDevEndpoint` only catches failures
while loading the provider module, so a throw from `boot()` would stop the whole dev
server over the coding-agent endpoint; the warning names `bunx guren upgrade`.

Why `@guren/cli`:

- `DEV_ONLY_MODULES` lists it unconditionally, so every deploy target stubs it for
  every app (`deploy-build.ts:365`).
- Every committed and scaffolded `wrangler.jsonc` already aliases it
  (`"@guren/cli": "./.cloudflare/stub-guren-cli.js"`).
- The provider already reaches it through a dynamic import
  (`McpServiceProvider.ts:27-32`), and `@guren/core` declares it as a dependency, so
  it is installed wherever the Dev MCP can run.

After the move, `@guren/server` imports no MCP SDK code on any path `Application`
reaches (`Application.ts:800` loads only the provider).

Constraints the implementation has to respect:

- **The factory type is declared structurally in server.** `GurenCliApi`
  (`create-mcp-server.ts:38`) gains an optional `createDevMcpHandler` member, following
  `CONTEXT_ROUTE_FEATURES`. Importing the type from `@guren/cli` is not possible:
  server builds with `paths: {}` and cannot declare cli even as an optional peer
  without a cycle, so the import would silently become `any`.
- **The version check is the only floor.** `sync-import-floors` skips root entries
  (`ROOT_ENTRY`), and the server-to-cli edge is undeclared, so no gate can hold a
  floor for it. The version PR also raises core's declared `@guren/cli` range by hand.
- **The access guard stays.** `createMcpHandler` performs no Origin or Host validation.
  `createMcpAccessGuard()` reads only `Origin` and the socket peer, and the CSRF
  exemption reads only the path, so neither needs the new headers.

Behavior changes on the Dev MCP, all from v2's handler: `GET` and `DELETE` answer
`405` (v1 stateless opened an SSE stream on `GET` and answered `DELETE` with `200`),
a `POST` that is not `application/json` answers `415`~~, and a body the entry reads
itself answers `413` above 4 MiB (`maxRequestBodySize`; the bound does not apply to a
`parsedBody` the caller supplies, and neither endpoint supplies one)~~.

**Amended in implementation:** the `413` bound is not in the published SDK 2.0.0. The
SDK source this RFC cited was a checkout one commit past a branch that diverged from
the release tag, and `maxRequestBodySize` exists only there; the installed
`@modelcontextprotocol/server@2.0.0` has no body limit (its dist contains neither the
option nor a `413`). The `405` and `415` answers, the `request.clone()` on the legacy
leg and `authInfo` reaching every factory call were re-checked against the installed
dist and hold. Line numbers citing `createMcpHandler.ts` refer to that checkout.

`Application.ts:801` currently names `@modelcontextprotocol/sdk` when the provider
fails to load. After the move the likely failure is a missing or outdated
`@guren/cli`, so step 2 rewrites that message alongside the version check.

### 2. `createMcpServer` is deprecated for one minor

`@guren/server/mcp` exports `createMcpServer(): McpServer` and `McpServiceProvider`.
Neither is re-exported by `@guren/core`, neither carries a stability annotation, and
the package has no README, so `contributing/api-stability.md:53-55` places the subpath
in the Experimental tier. The implementation PR adds `@experimental` to both exports
so the tier is stated rather than inferred.

Experimental APIs keep a deprecation period of at least one minor
(`contributing/deprecation-policy.md:18`). `createMcpServer` therefore stays for one
minor on its v1 implementation, with:

- `@deprecated` naming `createDevMcpHandler` from `@guren/cli`,
- a once-per-process runtime warning,
- a `packages/cli/src/deprecations.ts` entry (`id: 'server-create-mcp-server'`),

and is removed in the following minor. A wrapper that delegates to the CLI is not an
option: the function is synchronous and returns a v1 `McpServer`, and neither half
survives delegation. During that minor `@guren/server` keeps its
`@modelcontextprotocol/sdk` dependency, but the provider no longer imports
`create-mcp-server.ts`, so v1 code is already out of every application's graph.

### 3. `@guren/plugin-mcp` moves to v2

**One handler, built at boot.** Request state reaches the factory through
`authInfo`, which `handler.fetch(request, { authInfo })` passes through unchanged to
every factory call: the legacy fallback (`createMcpHandler.ts:333-335`), the modern
leg (`:782-784`), a classified legacy route (`:893`) and a body the entry could not
parse as JSON (`:935`). The SDK types it as `AuthInfo` (`token`, `clientId`,
`scopes`, optional `extra: Record<string, unknown>`):

```ts
const APP_MCP_REQUEST = 'guren.appMcpRequest'

const handler = createMcpHandler(({ authInfo }) => {
  const options = authInfo?.extra?.[APP_MCP_REQUEST] as AppMcpServerOptions | undefined
  if (!options) {
    throw new Error('App MCP: request reached the handler without an authenticated caller.')
  }
  return createAppMcpServer(options)
})

app.hono.all(path, async (c) => {
  const resolved = external ? fromExternalAuth(external) : await verifyBearer(c, auth, config)
  if (resolved instanceof Response) return resolved
  // pipeline, approvals and audit hooks built exactly as plugin.ts:174-255 does today
  return handler.fetch(c.req.raw, {
    authInfo: {
      token: bearerToken ?? '',
      clientId: String(resolved.principal.id),
      scopes: [...resolved.abilities],
      extra: { [APP_MCP_REQUEST]: serverOptions },
    },
  })
})
```

`authInfo` does not stop at the factory: the protocol layer also hands it to every
request handler as `ctx.http.authInfo` (`core-internal/src/shared/protocol.ts:1095`).
Here those handlers are plugin-mcp's own `tools/list` and `tools/call`, which never
read or serialize it, and nothing in the SDK source serializes it either. The
`extra` payload is therefore in-process only, and `createAppMcpServer` must keep it
that way: it is not logged, not echoed in results, and not placed in audit records.

`authInfo` is built only after authentication succeeds. A request that reaches the
factory without it is a wiring bug, and the thrown error becomes the entry's `500`
(`createMcpHandler.ts:954-960`) rather than a server built with defaults.

The factory's `requestInfo` cannot carry this state. The modern leg receives the
original `Request`, but the legacy leg receives `request.clone()`, made so the body
can be read once for classification and still forwarded (`:497`, `:892`, `:935`). A
`WeakMap<Request, …>` in the style of `external-auth.ts:24` would miss on every
2025-era request, which today is every client.

**The low-level server.** `server.ts` registers `setRequestHandler('tools/list', …)`
and `setRequestHandler('tools/call', …)`, with types from `@modelcontextprotocol/server`.
The design at `server.ts:306-322` (an `isError` result keeps its `content` even when
the tool declares an `outputSchema`) still holds: the v2 client skips output
validation for `isError` results. v2 adds `ttlMs: 0` and `cacheScope: 'private'` to
modern list results by default, which is correct here because the tool list depends on
the caller's abilities. `server/discover` is answered by the handler.

**Status codes on a production endpoint.** Unlike the Dev MCP, this endpoint ships.
The `405` and `415` changes above apply to it too and are listed in the
changeset body. ~~Whether the 4 MiB default is right is Open Question 1.~~
**Amended in implementation:** SDK 2.0.0 has no body limit (see §1), so the
endpoint's request size stays whatever the app's own middleware allows.

**Tests.** `seam-tool-call.ts` sends a hand-built `initialize` and `tools/call` and
discards both responses (`seam-tool-call.ts:31-34`), so it asserts nothing about
success. It gains status and JSON-RPC result assertions and stays the legacy case.
New cases drive the endpoint as a modern client (`versionNegotiation`), including
concurrent requests with different principals and `env` values, which is what the
per-request `authInfo` must keep apart. Each case runs on both eras, since the two
legs reach the factory by different paths. `InMemoryTransport` suites keep legacy coverage only.

`@guren/plugin-mcp` is 0.x with no external users, so this is a minor (0.6.0).

### 4. Deploy bundling

**Same release: no stub changes.** After §1-3, nothing on a production path imports
a v1 SDK specifier, and plugin-mcp imports `@modelcontextprotocol/server`, which no
existing alias or filter matches: Cloudflare aliases exact v1 subpaths, and the
Lambda and Vercel catch-all is `^@modelcontextprotocol/sdk/.+`
(`plugin-lambda/src/build.ts:126-133`, `plugin-vercel/src/index.ts:273-280`). Existing
`wrangler.jsonc` files keep working unchanged. Only the test fixtures that fake the
SDK for plugin-mcp apps change package names, and the doc comment on
`MCP_SDK_SUBPATH_PREFIX` (`deploy-build.ts:654-657`, "reached only through
subpaths") is corrected in this release, since plugin-mcp's root import makes it false
immediately.

**The minor after: remove the Phase 4a machinery.** With `createMcpServer` gone:

- delete the two SDK entries from `DEV_ONLY_MODULES`, `MCP_TRANSPORT_SPECIFIER`, the
  `stubbableDevOnlyModules` filter, `assertMcpTransportNotAliased`
  (`build.ts:784-812`), and the `MCP_SDK_SUBPATH_PREFIX` catch-all;
- keep writing `stub-mcp-server.js` and `stub-mcp-transport.js` from a separate
  compatibility list. `writeDevOnlyStubs` iterates `STUBBED_MODULES`
  (`build.ts:755`), so removing the entries alone would stop the files existing and
  break every config that still points at them;
- review `MCP_UNAVAILABLE` (`build.ts:185`) now that `@guren/cli` is the only module
  of kind `mcp`;
- drop `@modelcontextprotocol/sdk` from `@guren/server` and delete the dead alias
  lines from the four committed configs (`examples/agents`, `examples/deploy/cloudflare`,
  `web`, `packages/plugin-agents/tests/workers/app`).

From then on the `@guren/cli` stub is the only thing keeping SDK v2 out of the bundle
of an app without plugin-mcp. That invariant is tested on all three targets, starting
from the committed `wrangler.jsonc` files as they are today, and
`tests/orm-bundle.test.ts` in plugin-lambda and plugin-vercel already assert that no
`@modelcontextprotocol` module is bundled. The same tests confirm plugin-mcp never
reaches `@guren/cli` at runtime, since the unconditional stub would break it.

### 5. Measurements before the removal PR

- **Bundle size.** An app with plugin-mcp now bundles the v2 server root instead of
  one v1 subpath. `wrangler-bundle.test.ts` measures this as `transport-served`
  against `FREE_PLAN_GZIP_BUDGET` (3 MiB, `:153`). Cloudflare removed the compressed
  size limit on 2026-09-04 and now checks 64 MiB uncompressed on every plan, so the
  constant needs re-baselining in the same change (Open Question 3). If the root turns
  out too large to accept, the fallback is a shim that re-exports the transport, and
  §4's removal list changes.
- **workerd.** v2's server dist imports `@modelcontextprotocol/core/internal` and
  selects `./_shims` through a `workerd` condition. The Workers test app has to serve a
  modern and a legacy request.
- **Clients.** `npx @modelcontextprotocol/inspector@latest` (printed by
  `guren tool:dev`, `packages/cli/src/tool-dev.ts:212`) and the `.mcp.json` clients the
  harness installs connect to both endpoints.

### 6. Versioning

| Package | Bump | Why |
|---|---|---|
| `@guren/cli` | minor | `createDevMcpHandler`, SDK v2 dependency |
| `@guren/server` | minor | provider uses the CLI handler; `createMcpServer` deprecated, then removed the minor after |
| `@guren/plugin-mcp` | minor (0.6.0) | v2, dual-era, new status codes |
| `@guren/core` | minor | `@guren/cli` range; deploy-build changes in the removal PR (`./internal/*` is Internal) |
| `@guren/plugin-cloudflare`, `plugin-lambda`, `plugin-vercel` | minor | removal PR only |

No `@guren/server` major is declared, so `audit:core-semver` does not require a core
major, core stays on 1.x, and the seven plugins declaring `compatibility: "<2.0.0"`
are untouched. `audit:plugin-compat` still runs against whatever `changeset version`
writes for plugin-mcp's core range.

Install size does not grow for anyone. SDK v1 is already a dependency of
`@guren/server`, which every app installs. For the one deprecation minor both lines
are installed; after the removal PR only v2 is.

### 7. Documentation and related RFCs

- `docs/{en,ja}/guides/agent-interface.md`: the App MCP section (`:504`) states the
  supported protocol revisions and the `405`/`415` behavior.
- `docs/{en,ja}/tutorials/12-agent-tools.md` (`:912`): the Dev MCP description.
  Code blocks change identically in both locales (`audit:tutorial-blocks`).
- RFC 0016 §7: an amendment note where Phase 4a describes the dropped transport entry
  and the fail-rather-than-warn stance (`rfcs/0016-agent-interface.md:640-663`).
- RFC 0017: the "No MCP SDK v2 migration" bullet (`:337-344`) points here.
- RFC 0024 (`:173`): the `/mcp` subpath rationale names the SDK; reword when the
  dependency leaves server.

### Implementation plan

1. **This RFC.**
2. **Dev MCP behind the CLI** (§1, §2): cli minor, server minor. Tests for both eras
   through the provider, not by calling the handler directly.
3. **plugin-mcp on v2** (§3): same release as 2. Fixture renames in the deploy
   plugins' tests.
4. **Measurements** (§5), recorded in this RFC as amendments.
5. **Removal PR** (§4, second half), in the minor after 2 ships.

## Alternatives Considered

**Stay on SDK 1.x.** Modern-only clients fail against both endpoints, and the 1.x
line gets no new protocol revisions. Hand-implementing the modern wire format on top
of v1 means reimplementing `_meta` negotiation, header validation, `server/discover`
and Multi Round-Trip Requests.

**Migrate plugin-mcp first and leave the Dev MCP on v1.** The two endpoints would then
import different specifiers, so the stubs would work unchanged. Rejected by the
maintainer: it keeps two SDK lines in the framework with no end date, and the Dev MCP
would stay a legacy server for the agents that use it most.

**A Guren-owned specifier for the Dev MCP** (for example `Application` importing
`@guren/server/mcp` by package self-reference, and stubbing that). It survives SDK
layout changes too, but it is a new alias key, so every existing Cloudflare app
silently bundles the Dev MCP until someone edits `wrangler.jsonc`. Self-reference
resolution under wrangler and `Bun.build` is also unverified. `@guren/cli` gives the
same independence with a key every app already has.

**One stub entry for the v2 server root, unstubbed for plugin-mcp apps.** The smallest
code change, but every plugin-mcp app bundles the Dev MCP's registration code along
with the root, and the committed `wrangler.jsonc` problem is unchanged.

**A shim that re-exports the transport and throws for `McpServer`.** Keeps plugin-mcp
bundles small, but the shim must track the SDK's export names on every release. Kept
as the fallback if §5's size measurement fails.

**Majors for `@guren/server` and `@guren/core`.** `createMcpServer`'s return type does
change, but the subpath is Experimental and has no known consumers outside this repo.
`audit:core-semver` would also force a core major, which moves seven plugins'
`compatibility` ranges and every `^1.x` app for a change none of them can observe.

**Declaring `@guren/core` minor under a server major.** Semantically sound, since core
re-exports nothing from `/mcp`, but `audit:core-semver` deliberately has no escape
hatch (`scripts/smoke/core-semver-audit.ts:22-24`). Loosening a release gate for this
change is not worth it when the Experimental tier already allows a minor.

**A `createMcpHandler` per request in plugin-mcp.** Closes over request state with no
lookup, but each handler allocates its own event bus and listen router
(`createMcpHandler.ts:699-705`) and has to be closed.

**A `WeakMap` keyed on the `Request`, read through `requestInfo`.** It matches the
existing `external-auth.ts` seam, but v2 forwards a clone to the legacy leg (§3), so
the lookup misses for every 2025-era client.

## Migration Path

- **Apps using `GUREN_MCP=1`:** nothing to change. Editor clients that connect with
  the legacy handshake keep working, and modern clients start working. An app that
  pins an older `@guren/cli` gets the named error from §1 at boot.
- **Code importing `createMcpServer` from `@guren/server/mcp`:** none is known.
  `guren upgrade --check-only` reports it during the deprecation minor; the replacement
  is `createDevMcpHandler` from `@guren/cli`. No codemod: the return value changes
  from a server to a fetch handler, so the call site has to be rewritten by hand.
- **Apps using `@guren/plugin-mcp`:** no configuration change. Clients that sent `GET`
  or `DELETE`, or a non-JSON body, see the new status codes.
- **Cloudflare apps:** no `wrangler.jsonc` change. After the removal PR the two
  `@modelcontextprotocol/sdk/...` alias lines are dead and can be deleted.

## Open Questions

1. ~~**plugin-mcp body limit.** Keep v2's 4 MiB default, or expose
   `maxRequestBodySize` through `mcpPlugin()` config?~~ **Closed in implementation:**
   SDK 2.0.0 has no such option (§1). Revisit when a release ships one.
2. **Legacy posture.** Both endpoints keep `legacy: 'stateless'`. `'reject'` would cut
   off every current client, including the harness's `.mcp.json`; is there a date
   after which the Dev MCP should go modern-only?
3. **Bundle budget.** `FREE_PLAN_GZIP_BUDGET` encodes a compressed limit Cloudflare no
   longer enforces (removed 2026-09-04; `wrangler deploy` checks 64 MiB uncompressed on
   every plan), so it gates nothing real today. Replace it with the uncompressed
   limit, or keep a tighter self-imposed budget and state why?
4. **`authInfo.token` for externally verified callers.** A caller presented through
   `presentExternalMcpAuth` holds no bearer token, so §3 sends `''`. Nothing in the
   plugin reads it back, but an empty required field is a trap for a later reader.
   Keep `''`, or send a fixed marker such as `'external'`?
5. **`createDevMcpHandler` stability.** It is a cross-package seam rather than an API
   for apps. Mark it `@experimental`, or name it as internal in the CLI's exports?
