# Control and Audit Agent Tool Access

Once routes are served as agent tools (see [Agent Interface](./agent-interface.md)),
three controls decide what an agent may do and keep a record of what it did:

| Control | What it decides | Section |
|---|---|---|
| Token scopes | Which tools a bearer token sees and may call | [Tokens and scopes](#tokens-and-scopes) |
| Approval gates | Which calls wait for a person before they run | [Approval-gated tools](#approval-gated-tools) |
| Audit trail | Where every call and every refusal is recorded | [The audit trail](#the-audit-trail) |

Each one works on its own, so you can adopt them in any order.

## Tokens and scopes

**An existing `['*']` token grants no agent tools.** Only `tool:` and `tools:`
abilities are read as tool scopes; every other ability, including the default
`['*']` an `ApiToken` carries, matches nothing here. This is deliberate: an
app declaring its first `.agent()` route must not hand its whole agent surface
to every token issued before agent tools existed. Access to the agent surface
is granted explicitly or not at all.

Four scope forms, and no more:

| Scope | Grants |
|---|---|
| `tool:posts.store` | exactly that one tool |
| `tools:read` | every tool whose resolved `readOnlyHint` is true |
| `tools:posts.*` | every tool named `posts.…` (the dot is part of the match, so not `posts` itself) |
| `tools:*` | every tool |

Scopes are additive and there is no deny form. A tool the token's scopes do not
cover is **absent from `tools/list`**, not merely refused, so an ungranted
catalog cannot map your write surface for a read-only agent.

### What an OAuth client asks for

This grammar is your application's, not the MCP specification's, so a generic
client cannot guess it and sends no scope at all. A
`guren cloudflare:build --mcp-oauth` worker therefore advertises what it
accepts, in the two documents the specification tells a client to read: the
`scope` on the 401 `WWW-Authenticate` challenge, and Protected Resource
Metadata (RFC 9728). Both carry `tools:read`.

That value is the coarse read scope on purpose. A conforming client requests
everything the field lists, and the field is specified to carry the minimum
that basic functionality needs, so listing `tools:*` there would have every
client ask for your whole tool surface. The wider `tools:*` stays advertised in
the authorization server metadata (RFC 8414), which no client reads to *choose*
a scope, for anyone inspecting what the server accepts.

A client that ignores all of it and still sends nothing reaches the consent
screen with a default applied, so it is never offered an empty page. Widening
to a write tool needs that tool's exact name, and a read grant cannot reveal
one: a tool outside the grant is absent from `tools/list`, and
`guren_preflight` refuses it too. Read the name from `bunx guren tool:list` and
re-authorize with `tool:<name>`.

### Issuing a token

```bash
bunx guren token:issue --name blog-reader --user 42 --tools 'tools:read' --expires 30d
```

```
✔ Issued token "blog-reader" for user 42.

Token (shown once — it is stored hashed and cannot be recovered)
  1|xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

Expires  2026-09-29T09:00:00.000Z
Abilities  tools:read
Granted tools
  read: posts.index, posts.show
  write: (none)
```

An agent that also writes gets its own token, rather than a wider scope on
this one:

```bash
bunx guren token:issue --name blog-writer --user 42 --tools 'posts.store' --expires 30d
```

`--tools` accepts shorthand: a bare name becomes `tool:<name>`, `posts.*`
becomes `tools:posts.*`, `read` becomes `tools:read`, `*` becomes `tools:*`.

| Option | Meaning |
|---|---|
| `--name` | Required. How the token is identified when someone revokes it. |
| `--user` | Required. The user ID the token authenticates as. |
| `--tools` | Required. Comma-separated scopes. |
| `--read-only` | Restrict the grant to read-only tools. |
| `--expires` | `30d`, `12h`, `45m`. Omit for a non-expiring token. |
| `--allow-unmatched` | Accept a scope matching no current tool. |
| `--yes` | Required to accept `tools:*`. |
| `--json` | Emit the issued token as JSON, warnings included. |

The command refuses more than it warns, because a typo on a credential command
line is cheapest to fix while you are still looking at it:

- **A scope matching no current tool is refused.** It is either a typo or a
  *latent grant*: a stored pattern that would activate, with nobody's consent,
  the moment a matching tool is added. `--allow-unmatched` overrides it and
  warns about exactly that.
- **`tools:*` needs `--yes`.** It grants every tool the app exposes now and
  every one it gains later, destructive ones included.
- **`--read-only` stores concrete entries.** The grant is expanded at issuance
  and written as `tool:<name>` entries, never as the pattern. The grammar has
  no "read-only subset of `posts.*`" form. That is fail-closed: a write tool
  added to the `posts.` family later joins no stored entry. Under `--read-only`
  an unmatched scope is refused even with `--allow-unmatched`, since it could
  never grant anything at any later point.

Two issuance-time warnings, neither of them a refusal:

- a token that never expires stays valid until someone revokes it by hand
- a token granting **both** read and write tools is the shape the known
  injection incidents took: an agent that reads attacker-influenced content and
  can also write it back can be steered by that content. Split the two across
  separate tokens where you can.

## Approval-gated tools

Some actions should not happen because an agent asked. Mark the route, and a
call becomes a request for a human instead of an execution:

```ts
router
  .delete('/posts/:id', { params: PostIdParamSchema }, [PostController, 'destroy'])
  .name('posts.destroy')
  .agent({ description: 'Delete a post.', approval: 'required' })
```

The first call is refused. Nothing runs, a pending record is created, your
approvers are notified, and the agent is handed the request id:

```json
{
  "status": "pending",
  "requestId": "8f0c…",
  "tool": "posts.destroy",
  "requestedAt": "2026-09-01T12:00:00.000Z",
  "expiresAt": "2026-09-01T13:00:00.000Z",
  "executed": false,
  "pollWith": "guren_approval_status"
}
```

Once a human approves the record, the agent repeats **the same call with the
same arguments** and it goes through — once. Repeating it is the caller's job
here; an agent your own application hosts retries automatically from a durable
ledger of its own (see [Durable Agents](./durable-agents.md)).

### Configuring the queue

There is no default store. Where pending approvals live is your decision, for
the same reason the audit sink has no default: this endpoint runs on Workers
and Lambda, where a framework that quietly fell back to process memory would
approve a record the next isolate has never heard of.

```ts
import { AgentApprovalRequested } from '@guren/core'
import { mcpPlugin } from '@guren/plugin-mcp'

mcpPlugin({
  approvals: {
    store: new DrizzleApprovalStore(db),
    notify: (request) => notifications.sendToMany(admins, new AgentApprovalRequested(request)),
    ttlMs: 60 * 60 * 1000,
  },
})
```

`store` implements `AgentApprovalStore`:

| Method | What it does |
|---|---|
| `create(request)` | Persist a new pending request |
| `find(id)` | The request with this id, or `null` |
| `findMatch({ tool, fingerprint, principalKey })` | The **unconsumed** record for this exact call, whatever its status; the most recent when several match |
| `consume(id)` | Spend the approval, returning whether *this* call won it |

Two guarantees an implementation owes:

- **`consume` must be a compare-and-set**: set `consumedAt` only if it is not
  already set, and answer `false` when it was. Two concurrent calls will find
  the same approved record, and an unconditional write hands the approval to
  both.
- **`findMatch` filters neither expiry nor status.** The framework judges both,
  so a store that judged them too would be a second copy of the rule: the copy
  that fails open, because a comparison it forgets is an approval granted last
  month letting a call through today.

`notify` hands the request over and you decide who hears about it: the
framework never picks approvers, because it cannot see your list.
`AgentApprovalRequested` is a ready-made notification for the common case, and
you can subclass it or send anything else. The record is persisted *before*
`notify` runs and is not awaited afterwards, so a mail channel that is down
costs an approver an email, never the request. The failure is logged with the
request id in it. A channel still delivering when the response goes out is not
dropped either: on Workers its promise is handed to the request's `waitUntil`,
which is what lets a webhook or an SMTP handshake finish.

Resolving a request is your application's job, over your own storage: set
`status` to `'approved'` or `'rejected'`, with `resolvedAt` and `resolvedBy`.
The framework offers no `approve()`, because approving is a human action taken
through an interface it cannot see.

### The rules the gate enforces

- **An approval is bound to the arguments.** Approving `posts.destroy {id: 5}`
  does not authorize `{id: 9}`. Key order and nesting do not change the match;
  types do, so `{id: 5}` and `{id: '5'}` are different calls. The match is a
  SHA-256 of a canonical form of the **raw** arguments: the stored record
  carries the hash and the *redacted* copy of the arguments, so the queue never
  becomes a second place your secrets live.
- **An approval is single-use, and it expires.** One call goes through; the
  next is a fresh request. Past `expiresAt` the record authorizes nothing.
- **An approval is bound to the caller.** Another principal's approval
  authorizes nothing, even for the same arguments.
- **The approval is spent before the call is dispatched.** A call that then
  fails has still spent it: approve again rather than have a destructive action
  run twice on one approval.
- **Repeating a pending call does not re-file it.** The same request id comes
  back and your approvers are not notified a second time.
- **A rejected call is not re-asked.** The refusal says `"status": "rejected"`,
  so an agent can tell it from a wait worth polling. After the record expires,
  asking again is a new question.

### `guren_approval_status`

The endpoint adds a second tool of its own when a queue is configured. Pass the
`requestId` from a refusal:

```json
{ "name": "guren_approval_status", "arguments": { "requestId": "8f0c…" } }
```

```json
{
  "requestId": "8f0c…",
  "status": "approved",
  "tool": "posts.destroy",
  "requestedAt": "2026-09-01T12:00:00.000Z",
  "expiresAt": "2026-09-01T13:00:00.000Z",
  "resolvedAt": "2026-09-01T12:04:11.000Z",
  "resolvedBy": "ops@example.com",
  "executed": false
}
```

Reading a status performs nothing: `"approved"` means "call it again now". It
counts against the token's read budget, like `guren_preflight`, so polling in a
tight loop throttles.

A caller may read only the status of a request **it** created. Another
principal's id answers exactly as an unknown id does. Otherwise the tool would
be a way to enumerate what your colleagues are waiting to have approved. Your
audit trail keeps the distinction the caller does not get; a status check is an
ordinary invocation recorded under `guren_approval_status`.

`bunx guren check` fails a route declaring `approval: 'required'` when it can
see your `mcpPlugin({ … })` call and finds no `approvals` in it: without a
queue the tool is not guarded, it is uncallable.

## The audit trail

Every invocation and every denial is emitted as a framework event, so you
forward them wherever you already forward events.

| Event | When | Carries |
|---|---|---|
| `AgentToolInvoked` | the call reached the application | `principal`, `tool`, `arguments`, `status`, `durationMs`, `surface` |
| `AgentToolDenied` | the adapter refused before any HTTP happened | `principal`, `tool`, `arguments`, `reason`, `surface` |

`reason` is one of `'auth'`, `'scope'`, `'approval'`, `'rate-limit'`: exactly
the checks that precede the request. **A policy denial is not one of them:**
policies evaluate inside the dispatched request, so it arrives as an
`AgentToolInvoked` with status `403`. A denial carries no status or duration
because nothing ran.

A `guren_preflight` call is recorded like any other invocation, under
`tool: 'guren_preflight'`. An agent probing what it is allowed to do is
exactly what a trail wants to show. The tool it checked gets no record of its
own, because nothing was invoked. A refusal is recorded the same way, as an
`AgentToolDenied` for `guren_preflight`: naming the checked tool instead would
make a refused rehearsal indistinguishable from a refused real call to a
mutating tool. The tool that was probed is in the record's arguments.

```ts
// app/Providers/EventServiceProvider.ts (or wherever you register listeners)
import { AgentToolInvoked, AgentToolDenied, createFacades } from '@guren/core'

const { Events, Log } = createFacades(app.container)

Events.on(AgentToolInvoked, (event) => {
  Log.info('agent tool invoked', {
    tool: event.tool,
    principal: event.principal?.id,
    status: event.status,
    durationMs: event.durationMs,
    arguments: event.arguments,
  })
})

Events.on(AgentToolDenied, (event) => {
  Log.warn('agent tool denied', { tool: event.tool, reason: event.reason })
})
```

An event manager has to be bound for any of this to happen: register
`EventServiceProvider` (or your app's own event provider) alongside
`mcpPlugin()`. Without one the plugin warns at boot and emits nothing.

### Writing the trail down

The events fire whether or not anything records them. To keep a durable trail,
configure a sink on the plugin:

```ts
import { mcpPlugin } from '@guren/plugin-mcp'

createApp({
  providers: [
    EventServiceProvider,
    mcpPlugin({
      audit: { file: 'storage/logs/agent-audit.log', days: 30 },
    }),
  ],
})
```

One JSON record per line, rotated daily into `agent-audit-YYYY-MM-DD.log`
beside the path you name, with files older than `days` swept on rotation
(14 by default). `file` is resolved by the filesystem, so give an absolute path
or one relative to the process's working directory. It is not resolved against
an application root.

For anywhere other than a file, pass a function instead:

```ts
mcpPlugin({
  audit: {
    sink: async (record) => {
      await auditStream.write(record)
    },
  },
})
```

A sink that throws is warned about and does not fail the tool call it was
recording. A sink still writing when the response goes out is not dropped
either: on Workers its promise is handed to the request's `waitUntil`, which is
what lets a D1 write finish.

Configuring a sink also covers `bunx guren tool:call`. That command boots your
application, so it finds the trail the application configured and writes to it
(one record per call, `surface: 'cli'`, arguments masked by the same
`.agent({ redact })` list, alongside your MCP records rather than in a second
file). It is worth having: a call from a terminal runs as whoever `--as` names,
with no credential to verify, which is exactly the kind of write an audit trail
is for.

A `bunx guren tool:call --preflight` is recorded as `guren_preflight`, exactly
as a rehearsal over MCP is, with the tool it checked in the arguments. The
handler did not run, so a record naming that tool would read as a call that
completed. If your application's `@guren/core` predates preflight support it
runs the call for real (the command warns about that), and the record then
names the tool that actually executed.

`tool:call` records only invocations, never denials. The four denial reasons
name checks an adapter runs before sending a request, and this one runs none.
It holds no token and dispatches straight into the app. A 401 or a 403 your
application answers with is a response, so it is recorded as an invocation
carrying that status, the same as everywhere else. The principal is the user
`--as` named, or `null` when it named nobody; `abilities` is absent, because
there is no token whose abilities they could be.

An application with no sink configured records nothing here either, and the
call still runs and reports normally.

**The sink is opt-in on purpose.** The endpoint runs on Workers, where there is
no writable filesystem, and on Lambda, where it is ephemeral. A framework that
started appending on its own would give you a trail that quietly degrades per
deployment while the configuration looks identical. An audit trail is only
worth something if you know whether it is complete, so Guren makes you say
where it goes.

### Reading the trail

```bash
# The last 50 records
bunx guren tool:log

# Follow, including the rollover into tomorrow's file
bunx guren tool:log --tail

# Only denials, only this tool, only the last two hours
bunx guren tool:log --denied
bunx guren tool:log --tool posts.store --since 2h -n 200

# Raw records, one per line, for piping
bunx guren tool:log --json | jq 'select(.status >= 400)'
```

| Option | Meaning |
|---|---|
| `--file <path>` | Base path of the trail (default `storage/logs/agent-audit.log`) |
| `--tail`, `-f` | Follow as records arrive |
| `--tool <name>` | Only this tool |
| `--surface <s>` | Only `mcp`, `dev-mcp`, `cli`, `webmcp`, `durable`, or `in-process` |
| `--denied` | Only denials |
| `--since <duration>` | Only records newer than `30m`, `2h`, `7d`… |
| `-n <count>` | How many records (default 50) |
| `--app <dir>` | Application root the base path is resolved against |
| `--json` | One raw record per line |

`tool:log` boots nothing. An audit trail has to be readable when the
application it records is not startable. It reads across the rotation set
newest-file-first, so `-n` spanning a midnight boundary works, and applies
`-n` **after** filtering: `--denied -n 50` is the last fifty denials, not the
denials among the last fifty records.

If there is no trail, the command says so and prints the configuration line to
add rather than an empty list. An empty listing here would read as "no agent
touched this application", which is exactly the wrong conclusion to draw from a
sink that was never wired.

### Redaction

`event.arguments` is masked before the event is constructed. Two sources are
unioned: a built-in list of sensitive key fragments every app gets without
asking (`password`, `passphrase`, `secret`, `token`, `apikey`, `authorization`,
`credential`, `cookie`, `session`, `privatekey`, `pwd`, `jwt`) and the route's own
`redact` metadata.

```ts
router
  .post('/integrations', { body: CreateIntegrationSchema }, [IntegrationController, 'store'])
  .name('integrations.store')
  .agent({
    description: 'Connect an external integration.',
    redact: ['webhookUrl'],
  })
```

Matching is blunt on purpose, in the safe direction:

- a key matches when its **lowercased, separator-stripped name contains** a
  fragment, so `apiKey`, `api_key` and `x-api-key` are all covered by `apikey`
- the same containment applies to entries you declare, so `redact: ['id']` also
  masks `userId`
- the key decides before the value's shape does: a nested object under a key
  named `token` is masked whole, not walked

Masked values are replaced with `[REDACTED]`. The walk is total (a cycle
becomes `[Circular]` and an absurdly deep payload `[Truncated]`) because it
runs while recording that something happened, including denials taken before
your route's own validation.

## Related

- [Agent Interface](./agent-interface.md): declaring, testing and serving the tools these controls apply to
- [API Tokens](./api-tokens.md): the token store and the abilities a token carries
- [Events](./events.md): listener registration for the audit events
- [Durable Agents](./durable-agents.md): an agent your app hosts, which retries an approved call from its own ledger
