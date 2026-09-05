---
'@guren/plugin-agents': minor
'@guren/core': patch
---

Guard `/agents/*` with an app-declared authorizer (RFC 0017 Part 2b)

- **`routing.authorize` in `config/agents.ts`.** An `AgentRouteAuthorizer` is
  called with the request and `{ agent, instance }`; `true` lets the request
  reach the Durable Object, `false` refuses it with 403, and a `Response` is
  returned as it is. `agent` is the Durable Object **binding** name the SDK
  resolved the URL segment to — the path carries that binding kebab-cased, not
  the `config/agents.ts` key. The vocabulary is deliberately thin: RFC 0017 Open
  Question 3 is still open, and a richer surface published now would have to be
  kept.
- **`routeGuardedAgentRequest(request, env, routing, bindings)`** is the
  workerd-only mount, exported from `@guren/plugin-agents/agent`. It wires the
  authorizer into both of the SDK's pre-dispatch hooks — `onBeforeRequest` and
  `onBeforeConnect` — so a WebSocket upgrade is refused on the same terms as a
  request, and answers `undefined` off the `/agents/` prefix. `bindings` names
  the Durable Object bindings that host registered agents: the SDK routes to
  every binding in `env` with an `idFromName`, so without the list an authorizer
  would open the app's unrelated Durable Objects too. Anything off the list is
  refused with the same 403 before the authorizer is asked.
- The runtime the plugin publishes now awaits `app.boot()` rather than
  `app.booted()` before dispatching: after a boot that failed in a later
  provider, `booted()` resolved at once into the half-assembled application,
  while `boot()` retries it the way the next request would. With no `routing`
  declared it refuses the whole prefix with one 403 — before the SDK's router,
  whose own 400 for an unknown binding would otherwise let an anonymous caller
  tell bound names from unbound ones — and names the configuration that would
  let callers in. Registering agents reserves `/agents/*` for the router: an
  app's own routes under that prefix become unreachable.
- `AGENTS_CONFIG_FILE` moves into `@guren/core/internal/deploy-build`, so
  `guren check` and the deploy builds read one spelling of the registry path.
