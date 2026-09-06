# Triager — a durable agent, end to end

A stale-ticket triager built on RFC 0017: a Cloudflare Durable Object that wakes
on a schedule, reads the application's own tickets, and asks a human before it
closes one. Everything it does goes through the tool surface the routes already
declare — it imports no model and holds no database handle.

The human's half is a browser console: one page showing the tickets, the
approvals waiting on an answer, and what the agent did with the answers it got.
The JSON API underneath it is unchanged, and is still how the agent and any
script reach the same application.

It is deliberately small. The point is the wiring, not the product.

## What it demonstrates

- **`.agent()` routes as an agent's whole vocabulary.** `GET /tickets` is a
  read-only tool; `POST /tickets/:id/close` is a mutating one declaring
  `approval: 'required'`. `bunx guren tool:list` prints
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
- **Two operator surfaces over one set of rules.** The console is session-cookie
  and CSRF-protected; `routes/api.ts` is cookie-less bearer and exempt on its own
  terms (`isBearerRequestWithoutCookies`), so nothing had to be excluded by hand.
  Both answer approvals through the same `app/Services/approvals.ts` — a second
  copy of "which rows are answerable" is the copy that hands the agent a grant a
  human gave once. The tool routes keep returning JSON: an Inertia response on
  one of them would stop being a tool result, and `guren check` says so.
- **A session store that survives an isolate.** `DatabaseSessionStore` over a
  `sessions` table, not the in-memory default: on Workers the login redirect and
  the page it lands on are answered by different isolates, and a `Map` would lose
  the session between them. `guren check`'s deploy-runtime rule fails the default.
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

Open <http://127.0.0.1:3336> and sign in by pasting the token `db:seed` printed.
There is no password: `users` carries no password column, and hashing one per
login would spend CPU this demo does not have (see the Free-plan table below).
The console verifies the plaintext with `verifyApiToken`, which compares a
SHA-256 digest, and puts the operator's id in the session.

Everything but the agent works here. The console renders with **Run sweep**
disabled and says why; `POST /ops/agents/triager/sweep` answers `503`. There is
no Durable Object namespace under Bun, and this app does not pretend otherwise —
a fake DO runtime would be the mocked-driver trap RFC 0017 §7 refuses.

## The Workers run (this is the interesting one)

```bash
cat > .dev.vars <<VARS
APP_KEY=$(bun -e "console.log('base64:' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'))")
TRIAGER_INSECURE_COOKIES=1
VARS

bun run cloudflare:build                  # codegen, vite build, then .cloudflare/
bunx wrangler d1 migrations apply guren-example-agents --local
bun run db:seed:d1 > /tmp/seed.sql        # the token is printed on stderr
bunx wrangler d1 execute guren-example-agents --local --file /tmp/seed.sql

bunx wrangler dev --local --port 8799 --ip 127.0.0.1
```

`TRIAGER_INSECURE_COOKIES` is this app's own variable, read in `src/app.ts` and
by nothing in the framework. It keeps the session and XSRF cookies readable over
`http://127.0.0.1:8799`: `NODE_ENV` cannot decide that here, because
`wrangler.jsonc` defines it to `"production"` at bundle time, local run or not,
so a `Secure` cookie would be dropped by the browser and the login would fail
with nothing in any log. `.dev.vars` is local-only and never committed, so a
deploy has no such variable and gets `Secure` cookies.

`db:seed:d1` renders the same fixtures as `db/seeders/` as SQL, because D1's
local store lives inside miniflare where neither the seeder runner nor the ORM
can reach it. Both paths build the token through the framework's
`createApiToken`, so neither restates how a token is hashed.

### The console walkthrough

Open <http://127.0.0.1:8799>, sign in with the seeded token, and:

1. **Run sweep.** Two pending approvals appear, one per stale ticket. The agent
   report fills in: `stale 2`, `asked 2`, `closed 0`, and both ticket ids under
   *Parked on a human*. The third ticket is a day old, so the triager never
   looked at it.
2. **Approve one and Reject the other.** Both move to *Answered approvals* with
   your name on them, and neither reads as spent yet.
3. **Wait about thirty seconds, and do not sweep again.** The ledger's first
   backoff is 30 seconds from the moment the call parked, and a second sweep
   would spend the approval itself — leaving the ledger's own wake to report
   `approved` with no result (the interrupted-retry case in RFC 0017 §5). Reload
   the page instead.
4. The approved ticket is now **closed** and its approval reads *spent by the
   agent*; the rejected ticket id is under *Declined by a human*, and *Settled*
   carries both — `retry ok` for the one that ran, `retry not run` for the
   refusal. Nothing touched the Worker in between: the alarm did all of it.

![The console after the loop: no pending approvals, ticket #2 closed, ticket #1
declined, both requests settled](./console.png)

### The same loop over the JSON API

The console is one surface over the application; the tool routes are the other,
and they are what the agent itself speaks. Nothing below needs the console to
have run. With `TOKEN` set to what the seed printed and
`A="Authorization: Bearer $TOKEN"`:

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

Now wait — do **not** sweep again, for the reason step 3 above gives: the
ledger's first backoff is 30 seconds from the moment the call parked, and a
second sweep would spend the approval itself. About thirty seconds later, with
no request having touched the worker:

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

## The two operator surfaces

`routes/web.ts` is the app's one registrar — `createApp({ routes })` takes one,
and `guren check` fails a `routes/*.ts` the entry never calls. It mounts
`registerApiRoutes(router)` unchanged and adds the console beside it.

The console's actions live under `/console/`, so the JSON API keeps the bare
`/approvals/...` paths any existing script already uses. They redirect back to
the page and flash a refusal instead of answering with a status code, but the
refusal itself comes from the same `resolveApproval` the JSON API calls.

CSRF needed no configuration in either direction. `createApp({ auth })` mounts it
over the whole app; the console carries a session cookie and is verified, while a
bearer request that carries no cookies is exempt on its own terms, as is a
request carrying the agent principal the pipeline installed. The one visible
change: a mutating request with *neither* a bearer header nor a CSRF token now
answers `403` rather than `401`, because CSRF runs ahead of the auth middleware.
The exemption is the cookie-less shape, not the header: a bearer client that also
sends cookies is verified like a browser. The `curl` calls below keep no cookie jar.

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
Worker, and the retry closed the ticket. The table predates the console, so it
carries no number for a page render; what is known from the code is the query
count, which is the budget below that actually binds. Three Free-plan facts to
keep in view:

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
  `stale = asked + closed + refused + deferred`. One console render spends 6 of
  the 50: the session read and its rolling touch, the operator row, the ticket
  list (capped at `TICKET_LIMIT`), and the two approval lists. Seven on a render
  that writes the session back rather than touching it, a write being a read
  plus an update. The agent report costs none of them — it is a Durable Object
  call, not D1.
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
- Do **not** set `TRIAGER_INSECURE_COOKIES` as a deployed variable. It exists so
  a local `http://127.0.0.1` run can hold a session at all; on a real hostname
  its absence is what makes the session and XSRF cookies `Secure`.
- `wrangler d1 migrations apply guren-example-agents --remote` before the first
  deploy that serves the console: without the `sessions` table the JSON API keeps
  working and only the login fails.
- `sessions` rows are never collected on their own. `DatabaseSessionStore` treats
  an expired row as missing and deletes the one it reads, but a session nobody
  returns to stays; call its `deleteExpired()` from a scheduled task if the table
  matters to you.

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
- `guren check` reports "no test file named after TicketController" and four
  more: the detection is filename-only, and `tests/` covers those routes through
  `TestApp` rather than through files named for the controllers.
