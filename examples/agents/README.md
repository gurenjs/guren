# Triager — a durable agent, end to end

A stale-ticket triager built on RFC 0017: a Cloudflare Durable Object that wakes
on a schedule, reads the application's own tickets, and asks a human before it
closes one. Everything it does goes through the tool surface the routes already
declare — it imports no model and holds no database handle.

It is deliberately small. The point is the wiring, not the product.

## What it demonstrates

- **`.agent()` routes as an agent's whole vocabulary.** `GET /tickets` is a
  read-only tool; `POST /tickets/:id/close` is a mutating one declaring
  `approval: 'required'`. `bunx guren tool:list --routes routes/api.ts` prints
  what the agent can see.
- **One authentication story for two callers.** Both tool routes sit behind
  `requireAuthenticated()`. An operator satisfies it with a bearer token; the
  agent satisfies it through the in-process principal seam, which is *not* a
  credential — `createBearerTokenMiddleware` would refuse it, deliberately.
- **Authorization, not just authentication.** `guren check` fails a mutating
  agent tool that carries no authorization, so `close` runs behind
  `authorizeMiddleware('close-ticket')`. The ability (in
  `app/Providers/AuthProvider.ts`) admits operators and the agent principal
  `agent:triager:<instance>` — two different principal *kinds*, so an approval
  granted to one can never be spent by the other.
- **An `AgentApprovalStore` over a table.** `app/Services/DrizzleApprovalStore.ts`
  is the demo's queue: the framework ships no default, because one degrading to
  process memory would answer "approved" for a record the next isolate never
  heard of.
- **The pending-approval ledger.** A parked call is checkpointed in the agent's
  own Durable Object SQLite, encrypted under `APP_KEY`, and retried once a human
  approves it — surviving eviction, because state and schedule are both durable.
- **A sweep that stays inside a Worker invocation's budget.** The triager
  remembers what it has already parked (`parked`, keyed by ticket id) and caps
  fresh asks at `MAX_ASKS_PER_SWEEP`. Both bounds are the same fact: an
  invocation may run 50 D1 queries on the Free plan and a per-minute call
  budget is finite, so a backlog would otherwise starve every later ticket.
  `app/Agents/sweep-plan.ts` holds that arithmetic on its own, because a
  Durable Object cannot be exercised on Bun and this part should be.

## Local run (Bun, no agent)

```bash
bun install
cp .env.example .env   # then put a real APP_KEY in it
bun run db:migrate
bun run db:seed      # prints the operator's API token once
bun run dev          # http://127.0.0.1:3336
```

Everything but the agent works here. `POST /ops/agents/triager/sweep` answers
`503`: there is no Durable Object namespace under Bun, and this app does not
pretend otherwise — a fake DO runtime would be the mocked-driver trap RFC 0017
§7 refuses.

## The Workers run (this is the interesting one)

```bash
bun -e "console.log('APP_KEY=base64:' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'))" > .dev.vars

bun run cloudflare:build                  # codegen, then .cloudflare/
bunx wrangler d1 migrations apply guren-example-agents --local
bun run db:seed:d1 > /tmp/seed.sql        # the token is printed on stderr
bunx wrangler d1 execute guren-example-agents --local --file /tmp/seed.sql

bunx wrangler dev --local --port 8799 --ip 127.0.0.1
```

`db:seed:d1` renders the same fixtures as `db/seeders/` as SQL, because D1's
local store lives inside miniflare where neither the seeder runner nor the ORM
can reach it. Both paths build the token through the framework's
`createApiToken`, so neither restates how a token is hashed.

Then, with `TOKEN` set to what the seed printed and `A="Authorization: Bearer $TOKEN"`:

```console
$ curl -s -H "$A" 'http://127.0.0.1:8799/tickets?status=open'
{"tickets":[{"id":1,"title":"Login page 500s on Safari","status":"open","createdAt":"2026-08-25T00:56:39.813Z",…},
            {"id":2,"title":"Stale: invoice export truncates","status":"open",…},
            {"id":3,"title":"Docs typo in the quickstart","status":"open","createdAt":"2026-09-05T00:56:39.813Z",…}]}

$ curl -s -X POST -H "$A" http://127.0.0.1:8799/ops/agents/triager/sweep
{"swept":{"at":"2026-09-06T00:57:06.685Z","open":3,"stale":2,"asked":2,"closed":0,"refused":0,"deferred":0}}
```

`asked: 2`, `closed: 0`: both stale tickets parked on a human, and the third is
one day old so the triager never looked at it. The worker log carries the
notification the store's `notify` wrote:

```
[approvals] tickets.close awaits a human: POST /approvals/5cef07ef-…/approve (expires 2026-09-06T01:57:06.667Z)
[approvals] tickets.close awaits a human: POST /approvals/1e56a016-…/approve (expires 2026-09-06T01:57:06.678Z)
```

```console
$ curl -s -H "$A" http://127.0.0.1:8799/approvals
{"pending":[{"id":"1e56a016-…","tool":"tickets.close","input":{"id":2},
             "principal":"service:s:agent:triager:main","status":"pending",…},
            {"id":"5cef07ef-…","tool":"tickets.close","input":{"id":1},…}],"resolved":[]}

$ curl -s -X POST -H "$A" -H 'Content-Type: application/json' -d '{}' \
    http://127.0.0.1:8799/approvals/5cef07ef-…/approve
{"approval":{…,"status":"approved","resolvedBy":"Ops On-Call","consumed":false}}

$ curl -s -X POST -H "$A" -H 'Content-Type: application/json' -d '{}' \
    http://127.0.0.1:8799/approvals/1e56a016-…/reject
{"approval":{…,"status":"rejected","resolvedBy":"Ops On-Call"}}
```

Now wait — do **not** sweep again. The ledger's first backoff is 30 seconds from
the moment the call parked, and a second sweep would spend the approval itself,
leaving the ledger's own wake to report `approved` with no result (the
interrupted-retry case in RFC 0017 §5). About thirty seconds later, with no
request having touched the worker:

```console
$ curl -s -H "$A" http://127.0.0.1:8799/tickets
{"tickets":[{"id":1,…,"status":"closed","updatedAt":"2026-09-06T00:57:36.012Z"},
            {"id":2,…,"status":"open"},…]}

$ curl -s -H "$A" http://127.0.0.1:8799/ops/agents/triager
{"report":{"lastRunAt":"2026-09-06T00:57:06.685Z",
           "lastSweep":{"open":3,"stale":2,"asked":2,"closed":0,"refused":0,"deferred":0},
           "declined":[2],"parked":{},
           "settled":[{"requestId":"5cef07ef-…","tool":"tickets.close","status":"approved","retried":"ok",…},
                      {"requestId":"1e56a016-…","tool":"tickets.close","status":"rejected","retried":null,…}]}}
```

`retried` is the *retry's* own answer, not the queue's: `"ok"` means the repeated
call ran, `"failed"` that it dispatched to a refusal or an error, and `null` that
nothing was called. Both settled requests emptied `parked`, so ticket 2 is
askable again — except that its id is now in `declined`. Ticket 1 closed on the
alarm and its approval reads `consumed: true`. The next sweep therefore still
counts ticket 2 as stale but asks about nothing:

```console
$ curl -s -X POST -H "$A" http://127.0.0.1:8799/ops/agents/triager/sweep
{"swept":{"at":"2026-09-06T00:57:51.960Z","open":2,"stale":1,"asked":0,"closed":0,"refused":0,"deferred":1}}
```

And the SDK's own prefix is refused, because nothing here declares who may
address an instance:

```console
$ curl -s http://127.0.0.1:8799/agents/triager/main
{"error":"forbidden","message":"This application hosts durable agents, but nothing says who may address one, so /agents/* is refused. …"}
```

That is why the operator routes live under `/ops/agents/` — a route registered
beneath `/agents/` would be unreachable rather than merely refused. This app
talks to its agent through the `TRIAGER` binding, never over HTTP.

## The approvals API

`GET /approvals` is bounded on both halves: the 50 newest stored-`pending` rows
and the latest 20 resolved ones. `status` is always derived with
`agentApprovalStatusAt`, never read off the column — a request whose window has
closed still reads `pending` in SQL, so it is dropped from the listing rather
than offered as answerable, and `POST /approvals/:id/approve` on one answers
**409**, as does answering a request someone already resolved. A `404` means
only that no request has that id.

The table itself just grows: a settled request is this application's record of
what an agent was allowed to do, and nothing decides on its behalf when that
stops being worth keeping. `POST /approvals/prune` (operator, body
`{"olderThanDays": 7}`) deletes the requests that can no longer be answered —
resolved ones, and ones that lapsed unanswered — and reports how many went. It
is a route rather than a schedule because the retention period is a policy
question, and one an unattended job should not be answering.

## What the Free plan run measured

The maintainers' deployment of this app runs on the Workers **Free** plan, on
its own Worker and D1 (nothing shared with guren.dev). The same walkthrough as
above, against the deployed Worker, read from `wrangler tail`:

| Event | CPU | Wall |
|---|---|---|
| Worker startup (`wrangler deploy`) | 97 ms | bundle 2.9 MB, 568 KB gzip |
| `GET /tickets`, warm isolate | 4 ms | 80 ms |
| `GET /tickets?status=open`, cold isolate (boots the app) | 28 ms | 102 ms |
| `POST /ops/agents/triager/sweep` (Worker half) | 16 ms | 755 ms |
| the Durable Object's sweep: boot + 2 tool calls + 2 approval records | 47 ms | 179 ms |
| `GET /approvals` | 23–31 ms | ~115 ms |
| approve / reject | 6–13 ms | ~100 ms |
| the ledger's alarm (retry, close, settle both rows) | 14 ms | 129 ms |

The alarm fired 30 s after the calls parked with no request touching the
Worker, and the retry closed the ticket. Three Free-plan facts to keep in view:

- The Free plan's stated limit is **10 ms of CPU per Worker invocation**. A
  request that boots the application in a cold isolate measured 20–30 ms and
  every invocation above still reported `outcome: ok` — Cloudflare enforces
  the limit with tolerance, not as a hard cut — but a Worker that stays above
  it can start failing with error 1102. The Durable Object has its own, far
  larger budget, so the agent's work is not the exposed part; the operator
  API's cold boots are. Watch `cpuTime` in `wrangler tail`; if 1102s appear,
  the Workers Paid plan ($5/month) removes the ceiling.
- **D1 allows 50 queries per Worker invocation on the Free plan** (1,000 on
  Paid), and a whole sweep runs inside one Durable Object invocation. The index
  call is 1 query and each fresh `tickets.close` costs `findMatch` + `create`,
  so `MAX_ASKS_PER_SWEEP = 10` puts a full sweep at 1 + 2 × 10 = 21. That is
  the ceiling this app is sized against; raise the cap and the arithmetic is
  yours to redo. The rest of the backlog is reported as `deferred` and picked
  up by the next sweep — the summary's `stale` stays the total, so
  `stale = asked + closed + refused + deferred`.
- The *daily* allowances are a separate ceiling and nothing here comes near
  them (100,000 Durable Object requests, 13,000 GB-s, 100,000 SQLite row
  writes; D1 100,000 row writes): an hourly sweep with a handful of pending
  approvals is a few dozen wakes a day.

## Production notes

- `wrangler secret put APP_KEY` — the ledger is encrypted with it, and without
  one `agentsPlugin` warns at boot and retries nothing. Never commit `.dev.vars`.
- `wrangler d1 create guren-example-agents`, then put the id in `wrangler.jsonc` and
  run `wrangler d1 migrations apply guren-example-agents --remote`. Migrations are
  applied out of band; the app never migrates itself on Workers.
- `durable_objects` + `migrations` in `wrangler.jsonc` came verbatim from what
  `guren cloudflare:build` printed when it found a registered class the config
  did not host. Do not hand-write them; let the build tell you.
- Seed an operator token by whatever means your deployment allows. This demo's
  `db/seed-d1.ts` is for the local store only.

## Known rough edges

- **State shape evolves; instances do not.** `initialState` seeds a *new*
  Durable Object only. An instance that ran an earlier deploy keeps the state it
  was written with, so a field added in a later deploy reads `undefined` there —
  the first production sweep after `parked` shipped threw
  `Cannot convert undefined or null to object`. `Triager.#current()` layers
  `initialState` under `this.state` before every read; treat it as the app-side
  half of RFC 0017 Open Question 5.

- `guren check` warns that `POST /tickets/:id/close` carries no `body` schema.
  The action validates only route params, so there is nothing to declare;
  `guren audit`, which reads the controller body, passes the same route.
- `guren audit` and `guren tool:list` default to `routes/web.ts` and do not
  probe for `routes/api.ts` the way `guren check` does, so both need
  `--routes routes/api.ts` here. Without it `audit` skips *every* route-level
  check and still reports zero failures.
- `guren check` reports "no test file named after TicketController" and the
  other two: the detection is filename-only, and `tests/` covers those routes
  through `TestApp` rather than through a file named for the controller.
- `app/Agents/Triager.ts` names an `Env` that `make:agent` leaves undefined, and
  `GurenAgent` needs `@cloudflare/workers-types` in `tsconfig.json`. Both are
  supplied here (`config/env.ts` and the `types` array); a freshly scaffolded
  app has neither and does not typecheck until it adds them.
