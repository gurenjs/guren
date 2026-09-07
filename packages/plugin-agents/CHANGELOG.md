# @guren/plugin-agents

## 0.2.1

### Patch Changes

- 65e5a14: `make:agent` output typechecks in a fresh app, and `tool:list` finds `routes/api.ts`

  `make:agent` now writes what its class needs and never had: `config/env.ts`
  with the `Env` interface the scaffold imports (a D1 binding and a commented
  slot for the agent's Durable Object namespace — created when absent, left alone
  when the file already exports `Env`), the `import type { Env } from
'@/config/env'` line in the class, and `@cloudflare/workers-types` appended in
  place to `compilerOptions.types` in `tsconfig.json`. A tsconfig it cannot patch
  — no `types` array, comments, none at all — gets the line to paste, and an app
  missing the dependency is told to `bun add -d @cloudflare/workers-types`.

  `guren tool:list`, `tool:inspect` and `route:list` resolve the routes entry
  through the same probe `check` and `audit` use, so an API-only app whose routes
  live in `routes/api.ts` works without `--routes`; the flag still overrides. The
  degrading loader behind `guren context <Entity>`, `context --route` and
  `spec:generate` probes the same way, so those no longer describe an API-only
  app as having no routes.

  `@guren/plugin-agents`' README no longer says `make:agent` "writes all three"
  of its snippets — the `src/app.ts` registration is the one it leaves to you.

- Updated dependencies [52a23b1]
- Updated dependencies [68aa3d7]
- Updated dependencies [2894c60]
  - @guren/core@1.15.0

## 0.2.0

### Minor Changes

- 7fafa9f: Carry the parked call's arguments into `onToolApprovalSettled`. The approval queue holds no reversible copy of them by design, so an application that wanted to know _which_ call a human answered had to keep a second `requestId` → arguments map beside the ledger's own. The ledger already decrypts the arguments to perform the retry; the hook now receives them as `args`, absent only for an `'unreadable'` row, where they are what could not be decrypted.
- 923a3ee: Guard `/agents/*` with an app-declared authorizer (RFC 0017 Part 2b)

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

- e94645b: Retry a call automatically once a human approves it (RFC 0017 Part 3)

  A tool declaring `approval: 'required'` refuses the first call and files a
  request for a human, and until now an agent got the request id and was on its
  own. The approval queue cannot help: it stores only redacted input and a
  non-reversible fingerprint, so it can neither return the arguments nor repeat
  the call.

  `GurenAgent` now owns the retry material. A parked call is checkpointed into a
  private table in the agent's own Durable Object SQLite before the result is
  returned, and a `checkPendingApprovals` schedule is created — 30 seconds,
  doubling per check, capped at the request's expiry. On each wake the agent asks
  the queue about every parked call: `approved` repeats the original call with the
  stored arguments, so the queue's consume-on-use and fingerprint match spend
  exactly the approval that was granted; `rejected` and `expired` rows are pruned.

  ```ts
  export class Ops extends GurenAgent<Env, OpsState> {
    async retire(id: number) {
      const result = await this.tools.call("posts.destroy", { id });
      if (result.pending) return; // parked; the retry is scheduled for you
    }

    onToolApprovalSettled(event: AgentToolApprovalSettled) {
      if (event.status === "approved") {
        /* event.result holds the retry's answer */
      }
    }
  }
  ```

  - **`onToolApprovalSettled(event)`** is overridable and a no-op by default.
    `status` is the approval's outcome (`approved`, `rejected`, `expired`, or
    `unknown` for a request the queue no longer has); `result` is the retry's own
    answer, which can itself be a refusal when another caller spent the approval
    first.
  - **A lapsed row is asked about once before it goes.** A human can answer
    between the last check and the wake that finds the row past its expiry, and
    pruning it unread would report that answer as `expired` — an application that
    remembers only rejections then puts the same question to the same person on
    its next sweep. The sweep now settles such a row as `rejected` when the queue
    says so, and as `expired` otherwise: an approval past `expiresAt` is unusable,
    so there is nothing left to retry either way.
  - **Nothing is held in memory.** State and schedules are both durable, so an
    eviction between the request and the approval loses nothing.
  - **No encrypter, no ledger.** Ledger rows are encrypted with the app key at
    rest, which is what makes holding raw arguments acceptable at all. An
    application without `EncryptionServiceProvider` and `APP_KEY` is warned at
    boot and gets no ledger: a parked call is still reported with its `requestId`,
    it is simply never retried automatically.
  - **The sweep cannot throw.** The Agents SDK retries a failed scheduled callback
    three times and then drops the schedule, so one bad row would replay the whole
    sweep and then leave every surviving row with no wake at all. Each row is
    handled on its own, a hook that throws is reported and swallowed, a row naming
    a route a deploy removed is kept and counted, and a row no current key can
    decrypt is pruned and reported as `status: 'unreadable'` rather than taking
    down the sweep — and with it the record path, which reads the same rows to
    pick its next wake.
  - **An approval found already spent settles without calling anything.** If a
    sweep is interrupted after the retry ran but before its row was cleared, the
    next one settles with `status: 'approved'` and no `result`. Repeating the call
    there would file a fresh request, page a human again, and perform the action
    twice.
  - **A retry refused for want of budget keeps its row**, rather than spending a
    human's approval on a rate-limit refusal.
  - **`AgentToolClient.status(requestId)`** answers what `guren.approval_status`
    answers an MCP client, derived by the same rule, metered against the same
    per-instance budget, and audited under the same tool name. It reports "the
    queue has no such request for you" and "the queue could not be asked" as
    distinct outcomes, because a caller that purged its retry material on an
    unanswerable check would drop arguments a later approval needs.

- 20c2bc7: New package: durable agents that call your application's own tools

  `@guren/plugin-agents` lets an application host long-lived, stateful agents —
  a triager that watches a queue, a nightly researcher that accumulates findings,
  an operations agent that proposes a change and waits for a human — on
  Cloudflare Durable Objects, through the Cloudflare Agents SDK.

  The point of it is what an agent _cannot_ do. `this.tools.call(name, args)` is
  the only way an agent reaches the application, and every call goes through the
  same invocation pipeline as every other agent surface: the scopes its
  registration declares, the policies the route declares, the approval queue, and
  a redacted audit record. An agent gets no privileged path to your models.

  ```ts
  // config/agents.ts
  export default defineAgentsConfig({
    agents: {
      triager: {
        module: "app/Agents/Triager.ts",
        export: "Triager",
        scopes: ["tool:posts.index", "tool:tickets.store"],
      },
    },
  });

  // app/Agents/Triager.ts
  import { GurenAgent } from "@guren/plugin-agents/agent";

  export class Triager extends GurenAgent<Env, TriagerState> {
    async onStart() {
      await this.schedule("0 7 * * *", "sweep");
    }

    async sweep() {
      const result = await this.tools.call("posts.index", { published: false });
      if (result.pending) return; // waiting on a human; nothing ran
    }
  }
  ```

  Notable details:

  - **Three entry points.** `@guren/plugin-agents` is safe to import from
    `src/app.ts`, which `guren dev` runs on Bun. The `Agent` base class lives at
    `@guren/plugin-agents/agent`, which only a Workers runtime can load. The
    runtime seam — what hands out the application to dispatch into — lives at
    `@guren/plugin-agents/runtime`, which `make:agent`'s architecture rule
    forbids agent code from importing.
  - **Registration scopes are narrower than token scopes.** `tool:<name>` and
    `tools:read` are accepted; `tools:*` and prefix grants are refused, because
    an unattended agent must not acquire consent to tools that do not exist yet.
  - **Every agent instance is metered.** A per-instance budget (60 calls a minute
    by default, `budget: { callsPerMinute }` to change it) ships with the client,
    so there is no release in which an unattended caller exists without one.
  - **Each instance is its own principal** (`agent:<name>:<instance>`), so one
    instance cannot spend an approval a human granted to another. Agent names are
    restricted to letters, digits, underscores and hyphens, and the instance half
    is percent-encoded, so two different agents cannot produce one id. Sub-agents
    (the SDK's facets) are refused for now: a facet reuses its parent's instance
    name, so its id would not be unique.

  Requires `@guren/core` 1.14.0 or newer. Deploy integration —
  `guren cloudflare:build` generating the worker's named exports and verifying
  the Durable Object bindings — lands next.

### Patch Changes

- Updated dependencies [e94645b]
- Updated dependencies [55137f7]
- Updated dependencies [923a3ee]
- Updated dependencies [59347c1]
- Updated dependencies [20c2bc7]
  - @guren/core@1.14.0
