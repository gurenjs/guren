# @guren/server

## 2.18.0

### Minor Changes

- 914650e: Ask GitHub about linked issues with `guren context <Entity> --live` (RFC 0018 Part 2)

  `guren context <Entity>` gains two flags, and the `guren_entity_context` MCP tool
  the matching `live` and `repo` arguments:

  - `--live` asks `gh` for the state, assignees, labels and title of every issue
    the entity's linked docs declare: one `gh api graphql` query per repository,
    never the body. Each issue that GitHub answered for carries a `live` object in
    `--json` and a second line under its entry in markdown, with a note that titles
    are external text. When `gh` is missing, not logged in, or exceeds 5 seconds,
    `issuesLiveError` says why and the offline list stands; the exit code is
    unaffected. Nothing in `guren check`, `gate`, or a hook is touched by this.
  - `--repo owner/name` names the repository bare issue numbers belong to, for a
    fork, a mirror, or a checkout with no `origin`; with it, no git command runs.

  `@guren/server` widens the `GurenCliApi.generateEntityContext` options it
  passes through; an older `@guren/cli` ignores the two new fields.

## 2.17.0

### Minor Changes

- e94645b: Share the approval-status rule and the audit recorder across agent surfaces

  `toApprovalStatusReport`, `approvalStatusNotFoundMessage` and the
  `ApprovalStatusReport` / `ApprovalStatusOutcome` types move out of
  `@guren/plugin-mcp` and into the framework, so every surface that answers "what
  became of this approval request" answers it the same way — including the part
  that is a _refusal_ to distinguish: an unknown request id and another
  principal's request id produce one message, byte for byte, because any
  difference between them turns the check into a way to enumerate other
  principals' pending actions. The found/not-found distinction stays in the audit
  trail, where the operator can see it.

  `ApprovalStatusReport` also gains **`consumedAt`**, present once an approval has
  been spent (MCP advertises it as an additive output property). "Approved" alone
  does not say whether the one call it permitted has already run, and a caller that
  repeats a spent approval finds no unconsumed match, files a fresh request, pages
  a human again, and performs the action a second time. The field is what lets a
  caller tell "approved, go ahead" from "approved, and already used".

  `createAgentAuditRecorder(options)` is extracted from the invocation pipeline
  and exported alongside it. A surface that reaches the approval store without
  dispatching a tool still has to write a record under the same principal, the
  same `surface`, and the same argument masking; a second copy of that is how one
  surface comes to record a field the other redacts.

  No behavior changes for existing callers. `@guren/plugin-mcp` imports the moved
  helpers and keeps its own MCP schema and tool description.

- 55137f7: Add the agent invocation pipeline and the principal seam (RFC 0017 Part 1)

  The steps that make an agent tool call trustworthy — scope gate, approval gate,
  dispatch, redaction, audit — now live in the framework instead of in the App MCP
  plugin, so every surface that invokes a tool passes the same checks in the same
  order. `app.fetch` on its own only executes the HTTP request; a caller that
  dispatched through it directly would bypass scopes, approvals and the audit
  trail while looking exactly like a gated call.

  - **`createAgentInvocationPipeline(options)`** runs, in order: the scope gate, a
    single **interposition hook**, the approval gate, dispatch, redaction and
    audit. It is protocol-neutral — it knows nothing about MCP — and returns a
    discriminated result an adapter maps onto its own shapes. The hook's position
    is fixed rather than configurable: it sits between scope and approval, because
    the approval gate writes a record and notifies humans, so a meter behind it
    would guard the execution while the amplification happened in front of it.
  - **Fail-closed approvals.** A tool declaring `approval: 'required'` with no
    approval queue configured is refused, nothing is dispatched, and the denial is
    audited. The refusal names the configuration line of the surface that was
    reached, through the new `configureHint` option.
  - **`gateToolCall`, `gatePreflight`, `gateApproval`, `notifyApprovers`** and
    their types are now exported from `@guren/core` (they were internal to
    `@guren/plugin-mcp`).
  - **The principal seam.** A pipeline call made with `handoff: 'seam'` installs
    its principal on the exact `Request` handed to the application, keyed on
    object identity — no header, nothing on the wire to forge, and a copied or
    rebuilt request carries nothing. The auth context consults it before any
    header-based guard, so `requireAuthenticated()`, `Controller.auth` and
    `Gate`/policies all answer for the caller. It is not a token:
    `createBearerTokenMiddleware` and `tokenCan*` judge an `ApiToken`, and there
    is none, so routes behind those still refuse.
  - **CSRF.** A seam-marked request skips verification on the same terms as a
    cookie-less bearer request, and the middleware _asserts_ that premise: a
    seam-marked request carrying any `Cookie` header is refused with 403 whatever
    its method, so the exemption cannot be widened by a bug elsewhere. Issuance of
    the `XSRF-TOKEN` cookie is unchanged.
  - **`AgentSurface` gains `'durable'`**, for agents an application hosts itself.
    Nothing emits it yet; `parseAuditRecord` and `guren tool:log` accept it, so a
    trail written by a later release is readable by this one.

- 05dfef2: `guren_gate` MCP tool

  The development MCP endpoint exposes `guren gate` as `guren_gate`, with
  `changed` and `deps` arguments and the per-stage report as its result; `ok`
  is the verdict, and the result is marked as an error when a stage fails. On a
  `@guren/cli` older than `guren gate` the tool says so instead of throwing.

- 59347c1: Let an endpoint declare that it authenticates without cookies, so CSRF does not
  answer in place of its own 401

  `Application.declareCookielessAuthPath(path)` records a path whose principal can
  only come from a bearer token or an authority in front of the app. The CSRF
  middleware reads the registry per request — it is created in
  `AuthServiceProvider.register()`, long before such an endpoint mounts at boot —
  and skips verification for an exact path match. Patterns are deliberately not
  supported, and the registry is a second argument to `createCsrfMiddleware()`
  rather than a `CsrfOptions` field, so it is framework wiring rather than a
  second `exclude` an app can fill in. Apps exempting a path they chose themselves
  still use `csrfOptions.exclude`.

  A declaration naming a path the app already routes is refused with a warning:
  the app's route is registered first and answers there, so honouring it would
  leave a cookie-authenticated handler serving the path with CSRF disarmed while
  the declaring endpoint sat unreachable behind it.

- 20c2bc7: Add `classifyRegistrationScope`, the narrower scope rule for unattended principals

  Agent tool scopes have always had four forms: `tool:<name>`, `tools:read`,
  `tools:*`, and `tools:<prefix>.*`. An API token may hold any of them — someone
  issued it and is watching it.

  A _registration_ is different: it grants an agent that runs unattended, and it
  is written once and then outlived by the route graph. `classifyRegistrationScope`
  is the rule for that narrower case — `tool:<name>` and `tools:read` only, with
  set grants refused by name and with the reason, because an unattended principal
  must not acquire consent to tools that did not exist when a human read the
  config.

  One exported rule rather than two implementations: `guren check` and the agent
  runtime both read it, so a check that passes cannot describe a runtime that
  refuses.

  Also adds `createAgentApprovalContext`, which builds the invocation pipeline's
  approval context — the TTL default, the route's redaction rules, and the
  fire-and-forget notification wrapping — from a surface's own `approvals` option
  and the caller it is answering for. Those three are invariants of an approval
  record rather than of a protocol, so every surface that offers a queue now
  shares one of them instead of restating it.

  Adds `Application.booted()`, which resolves when the boot that is running — or
  has already run — completes. A service provider's `boot` hook runs during the
  application's own boot, so anything it publishes is published while later
  providers are still unbooted; awaiting this first is what turns "published" into
  "usable".

## 2.16.0

### Minor Changes

- d525672: Drop the unused `config` parameter from `verifyPasswordResetToken`,
  `completePasswordReset`, and `verifyEmailToken`, and decide one-time token
  expiry from the signed token alone.

  The three functions accepted a `PasswordResetConfig` / `EmailVerificationConfig`
  and ignored it. The password-reset JSDoc even told callers it "must match" the
  config passed to `createPasswordResetToken`, which was never true: expiry is
  signed into the token at issuance as an `exp` claim, and the signing key comes
  from `APP_KEY`, so nothing in the config object can change what a verify call
  decides. This ships as a minor deliberately, on the same footing as the
  `ApplicationOptions.discover` removal in 2.10.0: it is a type-surface bug fix
  for an argument that never did anything. No caller in the framework, the
  scaffolds, or the guides passed one; TypeScript code that did now gets a
  compile error naming the truth instead of a silent no-op.

  These functions are re-exported from `@guren/core`, which makes them Stable
  under `contributing/api-stability.md`, so the two-minor deprecation period
  that governed the seeder-class removal in 2.9.0 would normally apply. It does
  not here, for the reason `ApplicationOptions.discover` did not need one: a
  deprecation period exists to give callers time to migrate, and there is no
  migration. The argument was read by nothing, so no program's behavior depends
  on passing it or on stopping.

  With that settled, the store's `expiresAt` is no longer a second source of
  truth. `verifyEmailToken` and `completeEmailVerification` used to re-check the
  stored record's `expiresAt` after the signed claim had already passed; the
  password-reset path never did. Both now share one rule: the `exp` claim signed
  into the token is the authority on expiry, and the store is asked only whether
  the token id still exists (single use and revocation). A store may still drop
  expired records for housekeeping — the in-memory and Redis stores do — but
  verification does not rely on it, so a custom store that returns stale rows is
  no longer a way to keep an expired link alive, and one that keeps them is not a
  way to extend it either. The claim is the authority on what verification will
  _accept_; a store that drops a row before that claim expires still ends the
  link early, which is what `MemoryPasswordResetStore.find` does by design.

- 78f1a51: Type the rate limiter's `statusCode` option as Hono's `ContentfulStatusCode`.

  The option was `number`, and the default handler passed it to `ctx.json()`
  through `statusCode as 429` — a cast asserting the value the caller chose is
  the literal 429. So nothing checked a custom status, and the codes that
  cannot carry a body (204, 205, 304) type-checked and then failed at runtime
  when the limiter tried to send a JSON body with one.

  `statusCode` now carries the type `ctx.json()` accepts, so those are compile
  errors at the call site instead. `ContentfulStatusCode` is re-exported from
  `@guren/core` beside the other rate limiting types.

  This ships as a minor deliberately, on the reading v2.10.0 applied to
  `ApplicationOptions.discover`: it is a type-surface fix rather than an API
  change. Nothing about the runtime moved, every status the limiter could
  actually send is still accepted, and a literal — which is how the option is
  written in the guides and in every example — is unaffected. The narrow case
  that now needs a change is a status arriving as a plain `number` (read from
  config, say), which needs a narrowing or a cast at the call site.

  Also makes the sliding-window store's `timestamps` a `const`; no branch
  reassigned it.

- 78f1a51: Export `DEFAULT_ROOT_PUBLIC_ASSET_EXTENSIONS` from `@guren/core/runtime`.

  `rootPublicAssets.extensions` replaces the default list rather than extending
  it, so an app that wanted one more extension had to restate the defaults —
  and then silently missed every extension added to the framework afterwards.
  Spread the export instead:

  ```ts
  rootPublicAssets: {
    extensions: [...DEFAULT_ROOT_PUBLIC_ASSET_EXTENSIONS, ".js"];
  }
  ```

  `RootPublicAssetsConfig` and `RootPublicAssetsOptions` are exported from the
  same entry, so the option can be typed without reaching into the package.

### Patch Changes

- b15c329: Fix a quadratic-backtracking regex in `readBearerToken` (CodeQL `js/polynomial-redos`).

  `/^Bearer\s+(.+)$/i` let the separator and the token both match a space, so the
  two repetitions overlapped. On `Bearer` followed by a long run of spaces and a
  newline — `.` never matches one, so `$` is unreachable — the engine retried
  every split of that run, quadratic in the header's length: ~1.5s for a 50KB
  header, and the header is parsed _before_ any authentication, by
  `hasBearerHeader` on every request that carries one. Anchoring the capture with
  `\S` removes the overlap; the same input now costs ~0.1ms.

  The only input whose result changes is an all-whitespace token, which was never
  a token: `Bearer` + spaces used to read as a bearer request carrying a space,
  and now reads as not a bearer request at all. That reclassification is what the
  change is, not just a different token value — `AuthManager.resolveGuardName` no
  longer routes such a request to the token guard, and the CSRF middleware no
  longer skips it. Net stricter: the request falls back to the session guard with
  CSRF enforced, where it previously bypassed CSRF to reach a token lookup that
  could only ever 401.

- 39d4fb2: Release the broadcast driver subscription when a client leaves a channel or
  disconnects.

  `BroadcastManager.subscribeClient()` and `subscribeWebSocketClient()` called
  `driver().subscribe()` and dropped the unsubscribe function it returned, so
  `unsubscribeClient()`, `unsubscribeWebSocketClient()`, `removeWebSocketClient()`
  and an SSE stream's teardown only cleared the client's own channel set. The
  driver-level subscription stayed registered for the life of the process: the
  memory driver kept fanning out to a callback whose guard always said no, and
  the Redis driver never sent the `UNSUBSCRIBE` that closes the channel once its
  last local subscriber is gone. Subscribing the same client to the same channel
  twice also registered two callbacks and delivered every event twice.

  The manager now keeps the unsubscribe function per client and channel, calls
  it from every leave path, and ignores a repeat subscribe for a pair it already
  holds.

  `MemoryDriver` now caps the published-event record it keeps for tests at
  `maxPublishedEvents` (default 1000, oldest dropped first; `0` disables
  recording) instead of growing for as long as the process publishes. The
  option is exported from `@guren/core` as `BroadcastMemoryDriverOptions`.
  `RedisDriver` drops an `initialized` field nothing read.

- 154d23b: Resolve deferred providers through `Container.make()`.

  `make()` handed the key to the deferred-provider loader and then read a flag
  set from the loader's `.then()`, which never runs before the surrounding
  synchronous code finishes — so the flag was always false, the freshly bound
  service was never re-read, and every deferred service failed with
  `Service "..." not found in container` even though its provider had just
  registered it. `ProviderManager.loadDeferredProvider()` worked, but the path
  the plugin guide documents (`deferred: true` + `provides`, loaded on first
  resolution) did not.

  The loader now runs the provider's `register()` synchronously and `make()`
  re-reads the bindings after it returns. A synchronous `register()` failure
  surfaces from `make()` instead of becoming an unhandled rejection, and a
  deferred `register()` that binds asynchronously gets an error saying so —
  `make()` cannot await it. `boot()` may still be async; it runs after that
  first resolution, and a later `loadDeferredProvider()` for the same service
  resolves once that boot has finished.

- e135767: Await and report promises the framework used to drop on the floor, found by
  the new `typescript/no-floating-promises` lint gate.

  - `Application` now awaits an async `register()` on the optional providers it
    loads on demand (`mountDevEndpoint`), so `boot()` no longer runs
    before such a provider has finished registering.
  - `Logger` attaches its error reporter to async channels: a channel whose
    `log()` rejects used to surface as an unhandled rejection, bypassing the
    `try`/`catch` that exists to keep logging failures from cascading. The
    check is duck-typed, so a promise from another realm counts too. A stack
    channel now calls every member, handles each member's rejection as soon as
    it is seen, and reports the failures once (an `AggregateError` when more
    than one member failed).
  - The session middleware no longer `return`s from inside `finally`, which
    discarded whatever `next()` threw before the exception handler could see it.

- 8f6ab47: Make `QueueManager.setDefaultDriver()` change the instance default, and
  document that `SyncDriver` retries immediately.

  `setDefaultDriver(name)` swapped the global driver `Job.dispatch()` uses but
  never reassigned the manager's own default, so `driver()` with no argument and
  `getDefaultDriverName()` kept answering with the driver from construction. The
  method now updates both, and publishes a driver that was already resolved by
  name as the global rather than leaving it off the global slot.

  `SyncDriver.release()` re-runs a released job at once and ignores the retry
  delay. That is deliberate: nothing waits in a sync queue, so honoring the
  default exponential backoff would block the dispatching caller for the full
  delay, and a detached timer would move the failure off the call that surfaces
  it. The driver, the `QueueDriver.release()` contract, the worker's retry path
  and the queue guide now say so.

- 526edd1: Make the Redis counters atomic.

  `RedisStore.increment()`/`decrement()` checked `EXISTS`, wrote `0`, then
  ran `INCRBY` — three round trips during which two concurrent callers could
  both see the key as missing, both write `0`, and lose an increment. Redis
  already treats a missing key as `0` and keeps an existing key's TTL, so each
  method is now the single `INCRBY`/`DECRBY`.

  `RedisSlidingWindowRateLimitStore.increment()` sent its trim, insert, and
  count through a pipeline, which batches commands but does not stop Redis
  interleaving other clients between them, so concurrent callers could read the
  same count. The three steps now run in one Lua script, matching the
  fixed-window store, so every caller is handed a distinct count.

- 2b4b542: Keep the cause of a failed `Mail.template()` render, and stop `Command.secret()`
  from leaking its input listener between prompts.

  `template()` caught every failure and threw a fixed "Make sure
  @react-email/render is installed" message, discarding the error that actually
  occurred. A template that threw while rendering, or a `render()` that failed for
  its own reasons, reported a missing package. The two failures are now
  distinguished: a failed module load keeps the install hint, a failed render does
  not, both name the component, and both attach the original error as `cause`.

  `secret()` registered a `data` listener to mask typed characters and never
  removed it. A command prompting twice left the first prompt's listener attached,
  so the second prompt echoed the first prompt's label and its own character
  count, and raw mode was never restored. The listener is now removed and raw mode
  reset on every exit path.

  All four prompts — `ask()`, `confirm()`, `choice()` and `secret()` — now share
  one lifecycle and handle input ending before an answer arrives. Every one of
  them previously left the promise unsettled forever in that case, which is the
  unattended-command scenario the console guide tells you to guard against. Input
  ending with an unterminated line resolves with what was typed. Input ending with
  nothing typed resolves to the caller's default for `ask()`, `confirm()` and
  `choice()`, and rejects for `secret()`, where no default is safe.

  The mask writes to the same stream `createReadline()` echoes to, reached through
  the new overridable `inputStream()` / `outputStream()` accessors. `outputStream()`
  derives from whatever output `setOutput()` installed, via a new optional
  `stream()` on `OutputInterface` that `Output` implements, so redirecting a
  command's output now redirects its prompts with it rather than leaving them
  pinned to the real `process.stdout`.

- Updated dependencies [976bd07]
  - @guren/orm@2.6.3

## 2.15.0

### Minor Changes

- 09c56ce: Add the agent approval queue and `guren.approval_status` (RFC 0016 §5.4 item 4).

  A route declaring `agent({ approval: 'required' })` no longer refuses unconditionally. With `mcpPlugin({ approvals: { store, notify } })` configured, the first call becomes a pending record instead of an execution: nothing runs, the approvers are notified, and the caller is handed a request id. Once a human approves the record, repeating the same call with the same arguments performs it — once.

  **The pending answer rides as an error result carrying JSON, on a measured protocol fact.** An MCP `isError: true` result is delivered to the client with its `content` intact, including for a tool that declares an `outputSchema` — no `-32600`, no structured-content validation. Measured directly against the SDK client with a two-tool server, one plain and one with an output schema, both returning `isError` with a JSON body; both bodies arrived whole. That is what makes the pending state expressible at all, and it rides as a second content block rather than as `structuredContent`, which MCP defines for _successful_ results.

  **Approval binds to the arguments, not just the tool.** One canonicalization (`canonicalizeAgentApprovalInput`), hashed by `agentApprovalFingerprint`, read by both the creation and the lookup path — approving `posts.destroy {id: 5}` does not authorize `{id: 9}`. Key order does not change the match at any depth; types, array order, and absent-vs-null deliberately do. The fingerprint is taken over the **raw** arguments while the record stores the _redacted_ copy: fingerprinting the redacted copy would make approving `users.setPassword {id: 5, password: '…'}` authorize the same call with a different password. Only the hash is stored, so the queue does not become a second place secrets live. Approvals are **single-use** (`consume` is a compare-and-set the store owns) and **expire** (judged by framework code against a clock, never filtered by the store, because a store that forgot to compare would fail open silently), and are bound to the principal that asked. **Consumption happens before dispatch**: an approval is permission for one attempt, not one success — consuming afterwards would let concurrent calls pass the same check and make a crashed call replayable.

  **The store is the application's, opt-in, with no default implementation** — the audit sink's precedent, for the audit sink's reason. This endpoint runs on Workers and Lambda, where a queue that quietly fell back to process memory would approve a record the next isolate never saw. Unconfigured, an `approval: 'required'` tool stays refused fail-closed and absent from `tools/list`, and the refusal names the configuration line. `notify` hands the request over and the application decides who hears about it; `AgentApprovalRequested` ships as a ready-made `Notification` for the common case. The record is persisted before `notify` runs and is not awaited after, so a channel that is down costs an approver a message, never the request or the call.

  `guren.approval_status` is a second reserved meta-tool, `{ requestId }` in, its own output schema out, listed when a queue exists and the token grants at least one tool. **A caller may read only the status of a request it created**: another principal's id answers exactly as an unknown id does, converged on one branch in code, because any difference between the two answers enumerates other principals' pending actions. The audit trail keeps the distinction the caller does not get.

  Two deviations from the design as specified, both recorded in the RFC. A **pending** match is reused rather than re-filed — without that, an agent polling by re-calling the tool creates unbounded records and notifies approvers once per poll. A **rejected** call is not re-asked while its record is unexpired, and the refusal reports `status: 'rejected'` distinctly so a caller can tell it from a wait worth polling.

  `guren check` **fails** a route declaring `approval: 'required'` when it can read the app's `mcpPlugin({ … })` call and finds no `approvals` in it — without a queue the tool is uncallable rather than guarded. Positive evidence only: options this check cannot read (a variable, a spread) and an app with no readable call say nothing, since `guren check` has no per-finding ignore configuration. The option key is exported from `@guren/server` and read from there, never restated, because the CLI cannot import the plugin.

- e4b1ba4: Record `guren tool:call` in the agent audit trail, closing the last unrecorded surface of RFC 0016 §5.2.

  `'cli'` has been a member of `AgentSurface` since the events shipped, and `guren tool:call` is the whole of it — but the command emitted nothing. A developer could call a write tool from a terminal, acting as any user via `--as`, and the trail would show that nothing happened. It now records an `AgentToolInvoked` carrying `surface: 'cli'`, the tool name, the arguments masked through the _called_ route's own `.agent({ redact })` list, the HTTP status, and the duration of the dispatch — measured over the same span the App MCP endpoint measures, so the CSRF priming round-trip this surface needs is not billed to the tool.

  `@guren/server` now owns `createAuditEmitter` (with `AgentAuditEmitter` and `AgentAuditSink`), which `@guren/plugin-mcp` previously defined privately. It is the one rule for announcing an audit event — the sink called directly and the events emitted beside it — and it now has two readers, so a second copy is how one surface comes to swallow a sink failure the other warns about. Every line of its reasoning moves with it, including the measured fact that keeps the sink off the listener list: `EventManager.emit` awaits listeners in priority order inside a bare loop, so one unrelated application listener throwing would end the loop and silence the trail.

  The plugin publishes the emitter it built as the container service `AGENT_AUDIT_BINDING` (`'agent.audit'`), declared in `ServiceBindings` beside every other service name. The _emitter_ is bound rather than the sink, so a second caller cannot build a different one around the same sink and then disagree with the first about whether a failure warns. `guren tool:call` resolves that name — it does not, and must not, depend on `@guren/plugin-mcp`, which is not installed in every application. The name is a constant both sides import, because this is the first binding written by one package and read by another that cannot import it: two literals that drifted would leave the CLI recording nothing, which reads exactly like an application that configured no trail. The resolution is guarded at every step, including a container whose factory throws: a command that failed a tool call in order to record it would be the exact inversion the emitter is built to prevent.

  A `--preflight` is recorded as `guren.preflight`, never under the tool it rehearsed, which is the rule the MCP surface already follows — the handler did not run, so a record naming `posts.destroy` with a success status would be indistinguishable from a destroy that happened. The probed tool rides in the arguments, in the `{ tool, input }` shape the meta-tool's own arguments take on MCP, and the checked route's `redact` list masks the payload inside it. The distinction is decided by the answer rather than the flag: a `--preflight` against an application whose `@guren/core` predates the preflight seam runs the call for real, and that write is recorded under the tool that executed.

  Nothing is bound when no `audit` sink is configured, and then the command records nothing and runs unchanged — the same absence the endpoint already has, not a second sink writing somewhere an operator does not look.

  This surface emits **no** `AgentToolDenied`. Each of the four reasons names a check an adapter performs before synthesizing a request, and this one performs none: it holds no token to scope and no rate budget, and it dispatches directly. Its own two refusals (a missing path parameter, a URL dot-segment) are argument errors none of those reasons describes, and no request is sent for them, so there is no status a record could honestly carry — a deliberate divergence from the MCP endpoint, which answers the same two conditions with a synthetic 400 inside a tool result and records that. What the _application_ refuses arrives as a response, and so as an invocation with that status, exactly as on every other surface.

  The principal is `{ kind: 'user', id }` when `--as` names one and `null` otherwise, with `abilities` omitted rather than sent empty: abilities belong to a token and this surface presents none. `surface: 'cli'` carries the standing fact that no credential was verified, which is what lets the principal record who the application acted as without hedging — collapsing it to `null` would make an impersonation indistinguishable from an anonymous call, which is the one fact a reader of this trail most needs.

- 1fbbb04: Add the agent audit sink and `guren tool:log`, the durable half of RFC 0016 §5.2's audit trail.

  `@guren/server` gains the record: `AgentAuditRecord` is the one JSONL line shape a sink writes and a reader parses, `toAuditRecord(event, now)` derives one from an `AgentToolInvoked` or `AgentToolDenied`, and `parseAuditRecord(line)` reads one back — returning `null` for a blank line or the truncated final line a concurrent append leaves, so a reader stays usable against a file being written to. `DEFAULT_AGENT_AUDIT_PATH` names `storage/logs/agent-audit.log`. Redaction stays the emitter's contract: arguments arrive already masked and are carried across verbatim, because a second redaction rule beside the real one is one nothing reading a record could tell apart from it. The daily-file naming rule (`dir/name-YYYY-MM-DD.ext`) is now one exported function, `dailyFilePath` / `matchDailyFileDate`, that `DailyFileChannel` names its files with and the reader matches on — a second copy is how a writer and a reader drift apart, and the drift shows up as an empty log rather than an error. Extracting it also made the retention sweep's pattern escape its base path, so a log called `app.v1.log` no longer matches — and delete — files whose names merely differ in that position.

  **One behaviour change reaches every `DailyFileChannel`, not only the audit trail.** The retention sweep used to resolve its directory with `path.parse(path).dir`, which is the empty string for a base path that names no directory (`'audit.log'`), and `existsSync('')` is false — so a channel configured that way returned before looking at anything, and its `days` window never expired a single file however old. It now uses `path.dirname`, which answers `'.'`, so the sweep runs in the working directory the channel is already writing into. A channel configured with a bare relative filename therefore starts deleting dated files it previously left alone; only its own, as `matchDailyFileDate` decides, but in a directory that holds far more than a log directory does. Configure such a channel with a path that names its directory if that is not what you want.

  `@guren/plugin-mcp` gains `audit`: `{ file, days }` appends JSONL through the existing daily-file channel (rotation, retention, directory creation), `{ sink }` hands each record to a function. The sink is called **directly**, beside the event emit, and deliberately not subscribed as a listener: `EventManager.emit` awaits its listeners in priority order inside a bare loop with no try/catch, so the first one to throw ends the loop and every listener after it never runs. An unrelated application listener could therefore silence the audit trail, and the only evidence an operator would have of that is an empty file — a record of what agents did may not be contingent on what else the application happens to listen for. The events are still emitted unchanged for every consumer that legitimately is a listener, and a sink records with or without an event manager bound. A sink that throws, or returns a rejected promise, is warned about and does not fail the tool call it was recording; a sink dropping records in silence is the failure this feature exists to prevent.

  **The sink is opt-in, and the RFC is amended in place to say so.** The events themselves are still emitted by default, unchanged; what an application now asks for is somewhere to put them. A framework that appended to a file on its own would be wrong on two of the runtimes this endpoint is specified to run on — Workers has no writable filesystem, Lambda's is ephemeral — so the trail would degrade differently per deployment while the configuration looked identical. An audit trail whose completeness depends on where it happens to be running is worse than one an operator knows is absent.

  `guren tool:log` reads the trail back, with `--tail`/`-f` (following the midnight rollover to a new dated file), `--tool`, `--surface`, `--denied`, `--since 30m`, `-n`, and `--json`. It boots nothing: an audit trail has to be readable when the application it records is not startable. Files are read newest-first across the rotation set so `-n` spanning a rollover works, and `-n` applies after filtering — `--denied -n 50` is the last fifty denials, not the denials among the last fifty records, which over a busy trail is reliably empty and reads as "there were none". When there is no trail the command names the configuration line to add instead of printing an empty list, and it never pre-checks with `existsSync`: a permission error on a parent directory would answer "does not exist" and let the command make exactly the claim it must not. A `--tail` with no trail yet keeps waiting rather than exiting — the first record is exactly what someone running it is waiting for. `runToolLog` takes an optional `signal`, the only way to end a follow short of ending the process; it cuts the poll sleep short so an abort is answered promptly rather than up to one interval later.

- 0346aeb: Add `@guren/server/agent`, the browser-safe half of the agent dispatch surface (RFC 0016 §3, §8).

  `buildToolRequest`, `mapToolResponse` and `advertisesStructuredOutput` were reachable only through the package index, which pulls in the container, Hono, the ORM and the rest of the application graph — everything a client bundle must not carry. The new subpath re-exports exactly the names an _out-of-process_ dispatcher needs, plus types only, and its two transitive imports (`internal/route-path`, `internal/agent-preflight`) are string and regex constants. Pure Web API throughout: nothing from `node:`, nothing Bun-specific, no DOM access at module scope, so it is importable under SSR as well as in a browser.

  The entry deliberately re-exports **no value** from `agent/derive`. `dispatch.ts` imports `DerivedAgentTool` with `import type`, which is what keeps the derivation — and through it `Router` and the authorization middleware — out of the graph; a value re-export would undo that with nothing failing.

  The entry also exports `describeBuildFailure` (with its `ToolRequestBuildFailure` input type): the one wording for the two ways `buildToolRequest` refuses to build — a missing path parameter, a `.`/`..` path value. One function rather than a string per adapter, because the same tool is reachable from several surfaces and an agent that reads a different diagnosis depending on which one it reached would be debugging the client instead of its own call. `@guren/plugin-mcp` and the WebMCP client both read it.

  `BuildToolRequestOptions` gains `surface`, which sets the `X-Guren-Agent-Surface` header the builder previously hardcoded to `'mcp'`. It defaults to `'mcp'`, so every existing caller sends exactly what it sent before, and `'webmcp'` is what an in-browser call announces. The header is informational and write-only inside the framework — it is there for an application that wants to tell the surfaces apart, and no check may ever rest on it, since any client sets any header it likes.

- c9947b9: Add `guren.preflight`, the preflight companion tool on the App MCP surface (RFC 0016 §5.4).

  Preflight could not be an argument of the tool being checked on MCP. A tool advertising an `outputSchema` must answer with `structuredContent` conforming to it unless the result is an error, and a verdict conforms to no route's output — so a tool that sometimes returned a verdict would sometimes violate its own contract, and reporting "allowed" as an error would be worse than not offering preflight at all. The verdict therefore gets a tool of its own: `guren.preflight`, taking `{ tool, input }` and answering with `{ tool, allowed, status, message }` plus the seam's `validated` / `unverified` and, for a refusal, the application's own `errors`. **One meta-tool for the whole catalogue, not one companion per tool** — per-tool companions double the tool count, against RFC 0016 §5.5's own catalogue-quality rule.

  Nothing about it re-implements a check. It resolves the named tool from the same derived set the endpoint serves and dispatches the same re-entrant request an ordinary call does, with `BuildToolRequestOptions.preflight` set, so the route's real middleware runs and the router's preflight seam stops the chain before the handler. A refusal comes back as a **successful** result carrying `allowed: false`: the caller asked whether the call would be allowed, and "no, here is why" answers that. `validated` and `unverified` are absent, not empty, when the request was refused before it reached the seam — a call stopped by authentication has nothing to report about checks it never reached. A response that is neither a verdict nor a refusal means the handler ran, and is reported as an error rather than as a rehearsal that did not happen.

  Checking a tool requires the **same scope** as calling it, or the companion becomes a way to probe the authorization surface of tools the token cannot call; an ungranted name produces the same `AgentToolDenied` (`reason: 'scope'`, naming the checked tool) a direct call would. A tool declaring `approval: 'required'` **is** checkable although it is not callable — that is exactly when "would this be accepted?" is worth asking, and the rehearsal executes nothing. `guren.preflight` is listed only for a token that grants at least one tool, since a token that can call nothing has nothing to rehearse and listing it would map the surface to a caller with no access to it. The call is audited as an `AgentToolInvoked` with `tool: 'guren.preflight'` — an agent probing what it may do is what an audit trail wants to show — recorded under the _checked_ tool's `redact` list, because the arguments being written down are that tool's. The checked tool gets no record: nothing was invoked.

  `@guren/server` exports `PREFLIGHT_TOOL_NAME`, `RESERVED_AGENT_TOOL_NAMES` and `isReservedAgentToolName` — one list with two readers. `guren check` **fails** an agent route whose tool name claims a reserved one (`agent-route-reserved-name:*`), and the endpoint drops such a route rather than serving two tools under one name, which an MCP client answers by rejecting the entire catalogue. Restating the name in either place is how the check comes to keep passing a route the endpoint has already shadowed.

- cfef2ad: Diagnose a swapped `PasswordHasher.verify()` call, and stop the built-in defaults from being Bun-only.

  `verify(hashed, plain)` takes two same-typed strings in the inverse order of both the `Bun.password.verify(plain, hashed)` that `ScryptHasher` delegates to and this package's own `verifyPassword(plain, hashed)`, so a swapped call is a type-correct program that no compiler can reject. It surfaced as an opaque `UnsupportedAlgorithm` (or `Invalid password hash format.`) at runtime, naming neither the parameter nor the order — a 500 on every login. `ScryptHasher` and `NodeHasher` now throw a `TypeError` that says so.

  The check is deliberately **two-sided**: it fires only when the second argument looks like a hash _and_ the first does not. A one-sided "the first argument must look like a hash" precondition would misdiagnose a legitimate non-hash credential column — `passwordHash: 'oauth:...'`, the sentinel this repo documents for OAuth-only accounts — as a caller mistake; those keep falling through to the implementation and are rejected as before. Neither argument appears in the message, because one of them is a plaintext password and this throw is reached on a live login attempt.

  **`AuthenticatableModel`, `ModelUserProvider`, and `AuthManager.useModel()` now default to `DefaultHasher` rather than `ScryptHasher`.** On Bun that is the same hasher and the same hash format. Off Bun it is the difference between working and not: `ScryptHasher` calls `Bun.password` unconditionally, so a model with a plain `password` field threw on `create()` under Node — the runtime the Lambda guide tells you to deploy to, and the runtime an app's own Vitest suite runs on. `DefaultHasher` also forwards `needsRehash()` now, so `Hash` is genuinely a drop-in for the runtime-specific hashers rather than silently dropping that member.

  `@guren/testing`'s `configureInertiaVitest({ stubBun: true })` now installs a **working** `Bun.password` built on `node:crypto` scrypt, in the `$scrypt$` format `verifyPassword()` can read back, instead of stubs that throw. A stub that throws forces every app test touching a password into hand-writing its own hasher double, and a hand-written double is a copy of a contract that no type constrains — which is exactly how the swapped call above shipped with a green suite, its double having encoded the same inversion. The fake throws on a hash it cannot parse, as `Bun.password.verify` does, so a swapped call fails in a test the way it fails in production rather than looking like a wrong password.

  **Security: a malformed `$scrypt$` hash authenticated every password.** `verifyPassword()` derived a key of `expectedHash.length` bytes and compared it with `timingSafeEqual` — for a hash whose digest decodes to zero bytes, that is two empty buffers, which compare equal. A truncated column, a partial write, or a digest that is not valid base64 all reach that shape, and `NodeHasher` is the delegate the runtime-detecting default now uses off Bun. The decoded salt and digest must be non-empty and the cost parameters positive integers; anything else is `Invalid password hash format.` as it always should have been.

  `configureInertiaVitest`'s `Bun.password` stand-in delegates to `hashPassword`/`verifyPassword` rather than reimplementing scrypt, so the format, the parameter parsing, and that rejection are the same code the application runs and cannot drift from it.

- 7bcd5d6: Deny a password login against an account that has no password, instead of turning it into a 500.

  `ModelUserProvider.validateCredentials()` handed whatever sat in the credential column straight to the hasher. A column holding a sentinel rather than a hash — `passwordHash: 'oauth:...'`, which this repo's own JSDoc, `MassAssignmentException` message, database guide and agent skill all suggest for an OAuth-only account — reached `Bun.password.verify()` and threw. The login came back as a 500 while an unknown address came back as a 401, so the pair of responses told an attacker which addresses belong to OAuth accounts. A null column was already handled; the sentinel was not.

  Such a column now means what it says: the account cannot authenticate with a password, so the login is denied. It runs through the same dummy-hash path a null column already took, so the two answers cost the same work and the channel does not reopen as a timing difference. `make:auth --oauth` was never affected — it scaffolds a nullable column — so the reachable population is applications that followed the documented sentinel.

  **A value that _claims_ a hash format and fails to satisfy it keeps throwing.** That is the other half of the rule and it is deliberate: a truncated or corrupt digest is not a passwordless account, and denying that login in silence would leave nothing to notice the corruption by. `looksLikePasswordHash()` is what separates the two, so the prefixes this check trusts are the same ones the swapped-argument diagnostic trusts.

  `DefaultHasher` no longer tells a non-hash value that it "was written by Bun.password". That message is for a genuine Argon2id or bcrypt hash met on a runtime that cannot read it; a sentinel now gets one that says what is actually wrong. `ModelUserProvider` never reaches it, but a direct caller can.

- a6e3a1f: Reject app-relative signed URLs that begin with an authority, and widen the agent audit sink's default redaction vocabulary.

  `signUrl` / `verifySignedUrl` canonicalize to `pathname + search`, which is what makes a signature host-portable (RFC 0015 §2, T6) — and what made the canonical form non-injective over its own input. `//host/path` and `/\host/path` both begin with `/`, so both took the app-relative branch, and the WHATWG parser folded the first segment into the URL's _authority_, which the canonical form then dropped. The consequences ran in both directions: `verifySignedUrl('//evil.example' + signed)` returned `true` against a signature that never covered `evil.example`, and `signUrl('//evil.example/a.pdf')` returned `/a.pdf?signature=…`, silently discarding the host the caller asked to sign. `parseUrl` now holds app-relative input to the invariant that makes the canonical form usable at all: `pathname + search`, which is both what gets signed and what gets returned, has to mean the same thing when it is parsed again. That fails in two directions, so the guard is one check. Reading in, an authority the parser folds out of a `/`-leading value is covered by no signature. Writing out, a value whose _normalized_ pathname begins with `//` (`/.//host/a`) parses onto the placeholder origin but serializes to a string that does not, so `signUrl` would hand back a URL its own verifier rejects. Both now throw a `TypeError`; `verifySignedUrl` reports that as a failed verification, as it already does for any malformed input. Paths that merely contain a doubled slash (`/a//b/c`) or whose first segment looks host-like (`/evil.example/a.pdf`) are unaffected.

  The check compares the _parsed_ origin rather than matching a prefix. Which spellings fold into an authority is the URL parser's rule to change, not the framework's — a list of prefixes would go stale in silence, which is the failure mode a signature check can least afford.

  Not reachable through the attachment delivery route this primitive was written for: `registerAttachmentRoutes` registers `${prefix}/:id/:filename`, and no `//`-leading path matches it, so a request that reaches the handler always carried a fully signed three-segment path. `signUrl` and `verifySignedUrl` are public exports, though, and an app calling them directly had no such route shape protecting it. RFC 0015's T12 row is amended in place with the injectivity requirement; §3 and T5 are amended separately to record that R2 deliberately does not forward the presign response-overrides, which the RFC text still described it as doing.

  `redactAgentArguments` gains `privatekey`, `pwd` and `jwt` as default sensitive-key fragments — spellings that share no fragment with `secret`, `password` or `token` and so were carried into audit records in the clear. A bare `otp` is deliberately _not_ added: at three characters it is a substring of ordinary argument names (`slotProvider`, `notPublic`), and over-masking is the safe direction for a fragment that mostly hits credentials, not for one that mostly hits everything else.

- 202cd67: Stop `@guren/testing`'s controller mock keeping its own copy of the query-reading rules.

  Follows the split the request-body change made: the rule is shared, the adapter stays local. Two restatements of runtime behavior are gone from `packages/testing/src/controller.ts`.

  `flattenContextQueries()` was a line-for-line copy of the runtime's `flattenRequestQueries()` — same loop, same `values.length === 1 ? values[0] : values`. It now calls that function, reached through `@guren/server/internal/request`. To make it reachable, `flattenRequestQueries()` takes a structural parameter naming the one member it reads (`RequestQueryContext`) instead of a whole Hono `Context`. Narrowing a parameter accepts strictly more callers, so every existing caller passes a real `Context` unchanged. It is spelled as the call shape rather than as `Pick<HonoRequest, 'queries'>`, because `HonoRequest.queries` is overloaded and a `Pick` keeps both signatures, which the plain `() => Record<string, string[]>` on `ControllerContext` cannot satisfy.

  `groupSearchParams()` restated `HonoRequest.queries()`; both of its call sites now use `HonoRequest` itself, and it is deleted.

  **`queries?()` stays optional on `ControllerContext`, and an override supplied there is still honored.** The published type is consumed by application test suites, and the fallback for a context lacking one is load bearing — it re-derives the grouping from the required `req.url` and must never fall back to `query()`, which is single-valued by construction. So the adapter keeps that branch: a context that carries `queries()` hands it to the shared rule, one that does not is re-derived through a `HonoRequest`. Building the `HonoRequest` unconditionally from `req.url` would have read past the override silently.

  The adapter invokes an override as a _method_ on `ctx.req` rather than handing the shared rule a bare function reference. `queries?: () => Record<string, string[]>` is satisfied by a method as readily as by an arrow, so an override may read `this.url`; rebinding it onto a fresh object would silently give it the wrong receiver.

  This also fixes a real divergence, not just duplication. The mock's no-arg `ctx.req.query()` built its record by assignment (`first[name] ??= value`), so a `__proto__` query key hit `Object.prototype`'s inherited setter and vanished: `?__proto__=x` read as absent in a controller test and as a value in production. Hono builds a null-prototype object, which has no setter to hit, and `query()` now delegates to it. This is the same footgun the mock's form-body collection was fixed for earlier.

  Sharing the rule also exposed a `__proto__` bug in the runtime's own flattener, released separately below.

  One deliberate behavior change to note: `createControllerContext()`'s no-arg `query()` and `queries()` now return **null-prototype** objects, because that is what Hono returns and they now delegate to it. `Record<string, string[]>` promises no prototype, and a real controller's `ctx.req` has always behaved this way, so this brings the mock into line with production rather than away from it — but a test calling `ctx.req.queries().hasOwnProperty(...)` on the result would need `Object.hasOwn(...)` instead, exactly as it would against a live request.

  `packages/testing/tests/controller.test.ts` keeps pinning the parity by running one URL through the mock and through a real `Application.fetch()`, covering the repeated key, the single occurrence, and the no-`queries()` fallback, with new cases for the `__proto__` key on the raw surfaces and through `validateQuery()`.

- 0076c39: Stop `@guren/testing`'s controller mock keeping its own copy of the multipart upload read.

  This is the follow-up the body-parser change filed. That one moved `validateBody()` and the field helpers onto the runtime's parser and left exactly one restatement behind: `file()` and `files()` do not go through the body parser, so the mock still gated on Hono's media-type rule and then read the body with `Request.formData()`.

  `Controller.parseUploads()`'s body moves to `parseRequestUploads(ctx)` in `packages/server/src/http/request.ts`, re-exported from the internal `@guren/server/internal/request` subpath beside `parseRequestBody`. `Controller.file()` / `files()` call it, and the mock calls it through the same `HonoRequest` adapter the body parser already uses — so the mock's `isMultipartBody` and `readMultipartBody` are gone, and the adapter is now the whole of what stays local.

  It is a second function rather than a second caller of `parseRequestBody`, deliberately: uploads parse with `{ all: true }`, so a field repeated in the body stays an array and `files()` sees every part. The body parser flattens that same field to its first value, so routing uploads through it would silently reduce `files()` to one file per `<input multiple>` — a loss no malformed-body test can see.

  **The divergence this closes, and where it is visible.** The mock answered `null` from `file()` for a `Content-Type: MULTIPART/FORM-DATA` body the runtime delivers the file for. The gate was not the cause: it lowercases like Hono does. `Request.formData()` was — the gate passed and the read then threw.

  Where that throws is host-dependent, and the ground moved under this change while it was open. Measured: **Bun 1.3.14 rejects the header, Bun 1.4.0 accepts it, Node always accepted it** — the 1.4.0 trial lane caught this by failing a hard assertion that the host refuses, on the same CI run where 1.3.14 was green. So the concrete symptom is confined to Bun 1.3.x, which is the version every workflow currently pins; on the other two the mock and the runtime already agreed by accident.

  That narrows the bug, not the argument. The defect was never "Bun is case-sensitive" — it was that the mock decided the media type somewhere Hono does not, so its answer tracked whatever the host happened to do. Deciding it in one place is what makes the two agree on every runtime, including ones whose `formData()` has not been written yet. Nothing gates now, on either side, because Hono decides the media type inside `parseBody()`.

  **`readMultipart()` changes shape, and this is the deliberate part.** It is public only because TS4094 forbids private members on the exported anonymous class type the mock factory returns, but it appears in the published `packages/testing/dist/index.d.ts`, so the change is stated here rather than left to ride. Two things change together:

  - Its return type goes from `Promise<FormData | null>` to `Promise<Record<string, string | File | (string | File)[]>>` — the runtime's `{ all: true }` record. The `multipartBody` memo beside it follows.
  - `null` is gone. A non-multipart body now reads back as its parsed fields rather than as `null`, because the runtime has no media-type gate to answer `null` from.

  `file()` and `files()` are unaffected when they read through `readMultipart()` themselves: a urlencoded field arrives as a string and fails their `instanceof File` test exactly as an absent field does. Two other cases are affected and are worth naming rather than rounding off. `multipartBody`, the memo beside it, is public for the same TS4094 reason and changes type with it. And a subclass that _overrides_ `readMultipart()` to return a `FormData` — legal against the old declared type — now feeds that object into record indexing, so `file()` and `files()` would read `undefined` off it rather than calling `getAll`. Nothing in this repository does either, but "only direct callers of `readMultipart()`" would have been too narrow.

  One knock-on lands on the published surface: both members are typed as `RequestUploads`, so `packages/testing/dist/index.d.ts` now opens with `import { RequestUploads } from "@guren/server/internal/request"` — a _type_-level dependency on that subpath, where the previous release only reached it at runtime. Naming the runtime's type rather than respelling its shape is the point.

  It does **not** turn the version floor into a compile-time check, which is the tempting thing to claim and is wrong. `skipLibCheck: true` suppresses the `TS2307` that an unresolvable import inside a dependency's `.d.ts` would otherwise raise, and it is on both in this repository's root `tsconfig.json` and in the `create-guren-app` default template — so the consumers most likely to hit this are exactly the ones who would not see it. Measured against `tsc` directly rather than reasoned from the flag's name. A consumer on too old a `@guren/server` therefore still fails the way the previous release did: at runtime, on first import. The release step below is what prevents it, and nothing else does.

  The precedent here is the opposite of the one set when the mock's `parsedBody` box was reverted to keep the published shape. That break was avoidable — the mock clones the request, so re-parsing cost nothing and the memo could stay as it was. This one is not: `FormData | null` _is_ the second implementation. Keeping it would mean converting the runtime's record back into a `FormData`, which reintroduces the copy this removes. `createControllerModuleMock()`'s members are Experimental by the decision tree in `contributing/api-stability.md` — exported from the package index, not from `@guren/core`, with no stability annotation on the package — which is what allows a minor here.

  `packages/testing/tests/controller.test.ts` gains an upload table beside the body one, running `file()` and `files()` through a real `Application.fetch()` controller and a mocked one on the same request: a single upload, an uppercase media type, a repeated file field, a repeated `field[]`, a leading empty upload, a multipart text field, a urlencoded body, and a body with no boundary. Both sides must answer the same names.

  What that table can and cannot do is worth stating, because it was measured rather than assumed. Dropping `{ all: true }` turns two rows red, which is the guard it is really carrying. But run against the exact pre-change mock, **every row passes** — including the uppercase one, because vitest runs that suite on Node, which accepts the header. The uppercase assertion therefore lives in `packages/server/tests/http/request.test.ts`, under `bun run test:bun`.

  That test asserts `parseRequestUploads` answers with the file and says nothing about what the host's `formData()` would do — deliberately, and the second version of it. The first pinned the host's refusal as a premise, which is exactly the assertion Bun 1.4.0 broke. Adding a media-type gate to `parseRequestUploads` still turns it red on every runtime, which is the property worth holding; the host's own answer is recorded in the comment as context that has already changed once.

  Two further cases sit after the table and cover the delegation itself, which comparing `file()` / `files()` cannot: they read `readMultipart()` directly and assert it answers the runtime's record rather than a `FormData`, and that a urlencoded body reads back as its fields rather than as the `null` the gate used to short-circuit to. Both go red against the pre-change mock on any runtime, so reverting the mock to `Request.formData()` is a test failure rather than a silent one.

  `@guren/server` gains one function on the existing internal subpath — no behavior change, and nothing new on the package root. The subpath carries no stability guarantee, by the same rules that put `parseRequestBody` on it.

  **Release step:** the same one the change that added the subpath carried, and it comes due again. v2.14.0 already raised `@guren/testing`'s `@guren/server` peer to `>=2.14.0`, which is the release that first carried `internal/request` — but this change puts a _new_ export on that subpath, so the floor has to move again to whatever version publishes `parseRequestUploads`. Raise it in the release pull request beside the generated version bumps; it cannot be raised earlier, because `audit:plugin-compat` requires every `@guren/*` range to admit the version the workspace currently publishes. Skipping it leaves `>=2.14.0` claiming a compatibility this package does not have: `@guren/testing` upgraded alone against a pinned `@guren/server` 2.14.0 resolves the subpath and then fails on the missing export.

### Patch Changes

- 1eb4303: Stop reporting handled client errors as `Unhandled exception:`.

  `ExceptionHandler.reportException()` falls back to `console.error('Unhandled exception:', error)` when an app registers no reporter, so that a hosted runtime — where stdout is the only channel back to the operator — does not turn a 500 into a rendered page and nothing else. That fallback fired for _every_ exception reaching the handler, including the 4xx an application throws on purpose: a `ValidationException` from `validateBody()`, an `AuthorizationException` from an authorization middleware, an `HttpException.notFound()`. A route rejecting invalid input as designed printed a full stack trace per request, labelled as though nothing had handled it.

  The label was the misleading part. Nothing escapes: the exception is caught by the handler's own middleware, `reportException()` is awaited inside `handle()`, and the correct 4xx is returned. Confirmed on Node 22 under `--unhandled-rejections=strict` against the built `dist` — no `unhandledRejection`, no `uncaughtException`, exit 0 — so this was never a crash risk on `@guren/plugin-lambda` or `@guren/plugin-vercel`, only noise loud enough to read as one.

  The gate is on the console fallback alone, **not** on `shouldNotReport()`: a registered reporter still receives 4xx, because an app tracking auth failures or validation churn through one is asking for exactly those. The status it reads comes from a single `resolveExceptionStatus()`, which `renderDefaultException` now also takes its status from rather than from `toResponse()` — what an exception is delivered as and whether it counts as a server failure must be the same number, or an exception could be sent as a 422 and reported as a crash. An error carrying no status is still a 500, so a bare `throw new Error(...)` logs exactly as before.

- 58f2835: fix(server): force document types served out of `public/` to download

  The `public/` tree is not only build output. The attachments scaffold roots
  its `public` storage disk inside it (`./public/storage`), so a file there can
  be an upload that kept the uploader's own extension and content type. Served
  back as `text/html` or `image/svg+xml` from the app's own origin, that is
  stored XSS: session-riding requests, CSRF-token reads, account takeover.

  Two routes reach that directory and neither stopped it. The extension
  allowlist in `registerRootPublicAssets` was declared to be the gate, but
  `configureInertiaAssets` also mounts an unfiltered `serveStatic` at
  `/public/*` (and `registerDevAssets` mounts the same one, so `bun run dev` was
  not exempt); `.svg` is in the allowlist's own default extensions, so it was
  reachable through the declared gate too.

  Both mounts, and the `/resources/css/*` one beside them, now answer with
  `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff` for
  the content types a browser renders as a document in the serving origin:
  `text/html`, `text/xml`, `application/xml`, `text/xsl`, and any `*+xml`
  (`application/xhtml+xml`, `image/svg+xml`, `application/xslt+xml`).

  `Content-Disposition` is honoured for navigations and ignored for subresource
  loads, so `<img src="/logo.svg">`, `<link rel="icon">` and CSS `url()` are
  unaffected. Scripts, stylesheets, fonts, images, media and PDFs are untouched.

  What does change, beyond opening such a URL directly:

  - an SVG or HTML page embedded through `<iframe>` or `<object>` no longer
    renders, because that is a navigation;
  - a directory request resolves to its `index.html` before the guard runs, so
    `public/site/` now downloads rather than renders. A static microsite under
    `public/` is the one legitimate flow this stops.

  Opt back in per route family: `rootPublicAssets: { inlineDocuments: true }`
  for the root-level allowlist, and `inlineDocuments: true` on
  `configureInertiaAssets` / `registerDevAssets` for `/public/*` and
  `/resources/css/*`. Turn either on only for a directory holding nothing
  user-supplied.

  Two scope limits worth stating:

  - This covers the app's own static serving, which is what `bun bin/serve.ts`
    and the Docker image use. A deployment fronting `public/` with platform
    static assets, a CDN, or nginx serves those files without reaching this
    middleware and needs the same header policy configured there.
  - Root-level assets are served `public, max-age=31536000, immutable`, so a
    browser or shared cache holding a pre-upgrade inline response keeps it. An
    app that has already accepted uploads should rotate those URLs or purge the
    cache rather than rely on the upgrade alone.

- 202cd67: Fix `__proto__` query parameters being dropped before reaching a validation schema.

  `flattenRequestQueries()` — which backs `Controller.validateQuery()` / `validateQuerySafe()` and every route contract's `query` schema — built its result by assigning into an object literal. Query keys are attacker-controlled, and `flat['__proto__'] = …` hits `Object.prototype`'s inherited setter rather than defining a field, so a `__proto__` key was lost in one of two ways depending on how often it was repeated:

  - `?__proto__=one` assigned a **string**, which is a silent no-op. The field never reached the schema, so a schema requiring it failed and one merely reading it saw nothing.
  - `?__proto__=one&__proto__=two` assigned the **array**, which is not a no-op: it replaced the returned record's own prototype, handing the schema an object whose inheritance came from the request.

  Hono groups query parameters into a null-prototype object, so the key arrives intact and only this last step could lose it. The record is now materialized with `Object.fromEntries`, which defines own properties — the same rule, for the same reason, that the form branch of `parseRequestBody()` already follows.

  Covered directly in `packages/server/tests/http/request.test.ts`, and through `validateQuery()` on both a real `Application.fetch()` and `@guren/testing`'s controller mock.

- 1414267: Apply the document-disposition guard to the two file-serving routes it had missed, and pin the set of mounts that must carry it.

  The guard added for `public/` covers the four routes that reach that directory. Two more routes build file responses of their own and were still serving whatever they found inline: the dev transpile route's static fallback (anything under `resources/js/` that is not TypeScript is handed back as it sits on disk, so a `.html` beside a page component comes back as `text/html`), and the mount serving the built Inertia client out of its package directory. Neither is where an upload lands, which is exactly why they were easy to leave out — but a rule with an exception nobody can name is one nobody can rely on, and `resources/` is a directory a project's own tooling writes into. Both now go through `applyDocumentDisposition`. Neither takes the `inlineDocuments` switch: that escape hatch exists for a `public/` directory holding nothing user-supplied, and these two serve the app's sources and a vendored package.

  **The mounts are now pinned in the source, not just covered by tests.** A seventh mount added later would typecheck and pass every existing test, because `serveStatic` builds its own response and a test cannot reach a route it does not know about. Two source-level assertions close that: the set of modules calling `serveStatic(` must equal the known list, and each of those modules must reference `guardStaticDocument` once per mount. Both were mutation-checked against the three ways such a scan can pass while a mount is unprotected — a mount added in a new file, a mount added to an already-listed file, and the guard replaced by a comment naming it. Comments are stripped with `Bun.Transpiler` rather than a regex, because these files are full of route patterns like `'/public/*'` and `/*` opens a block comment.

- Updated dependencies [4831473]
  - @guren/orm@2.6.2

## 2.14.0

### Minor Changes

- 8f43757: Move the agent dispatch contract into `@guren/server` and add the preflight seam (RFC 0016 §3, §5.4).

  `buildToolRequest` / `mapToolResponse` / `advertisesStructuredOutput` now ship from `@guren/core` rather than from the MCP plugin. Every surface that invokes a tool — the App MCP endpoint, `guren tool:call`, `@guren/testing` — has to build the same request and read the same response, and none of them can depend on an optional plugin; a second copy is how one of them comes to send a POST route's `query` keys in the body.

  Preflight answers "would this be allowed" without the write happening. A dispatch carrying `preflight: true` runs the route's middleware and validates the contract the tool advertises, then stops before the handler and reports what it checked — including what it could _not_ check: a route that authorizes inside its action gets `unverified: ['authorization']`, because a seam that stops before the handler never reaches that call. The seam is mounted last, so every gate in front of it is the real one: an unauthenticated call is still the auth middleware's 401 and an unauthorized one its 403. Only routes declaring `.agent()` honour it, so no ordinary endpoint changes behaviour on a header any client can set.

  Preflight is not offered over MCP itself. The spec requires a tool advertising an `outputSchema` to answer with conforming `structuredContent` unless the result is an error, and a verdict conforms to no route's output — so the MCP form needs a companion tool, which is the same problem the approval queue has and belongs with it. `guren tool:call` and `@guren/testing` reach the seam through `BuildToolRequestOptions.preflight` instead.

- 0cf0260: Add agent exposure metadata to routes (RFC 0016 Phase 1).

  - `RouteBuilder.agent(metadata)` and the `agent` key on `RouteContractOptions` mark a route as an agent tool. The metadata (`AgentRouteMetadata`: description, toolName, expose, MCP annotation hint overrides, approval, redact) is storage-only — input/output schemas, authorization, and annotation defaults derive from the contracts the route already carries.
  - `resource()` accepts per-action metadata via `ResourceRouteOptions.agent`; an action not listed is not exposed (deny by default), and metadata for an action the call does not register (excluded via `only`/`except`, or missing from the controller) throws.
  - `RouteDefinition.agent` carries the declared metadata through `definitions()`. Metadata is snapshotted on attach and on read, so neither side can mutate the router's copy.

- a3a96ae: Add the agent security primitives (RFC 0016 Phase 2): tool scopes, audit events, and argument redaction.

  - Tool scope grammar for API token abilities: `tool:<name>`, `tools:read`, `tools:*`, and `tools:<prefix>.*`, with `parseToolScope`, `scopesAllowTool`, and `expandToolScopes` (a filter over `scopesAllowTool`, so a consent screen and the dispatcher cannot list different tools). Only `tool:`/`tools:` entries are considered — every other ability, including the `ApiToken` default `['*']`, grants no tool, so tokens an app already issued for its own API do not silently gain the agent surface when the first `.agent()` route appears. The judge ignores a malformed entry rather than throwing; refusing one is the issuer's job. `AGENT_TOOL_NAME_PATTERN` exports the MCP tool-name grammar (SEP-986) a `tool:` scope and a wildcard prefix must satisfy.
  - `AgentToolInvoked` and `AgentToolDenied` events carrying the principal (`AgentPrincipal`), tool, arguments, surface, and either status and duration or a denial reason (`auth`, `scope`, `approval`, `rate-limit`). Declarations only: the dispatch path emits them, and their `arguments` are a contract that the emitter has already redacted.
  - `redactAgentArguments(args, redact)` deep-copies arguments and masks sensitive fields, unioning a built-in fragment list (password, secret, token, authorization, cookie, session, …) with a route's `.agent({ redact })` names. Matching is a substring test on the key after lowercasing and stripping separators — `apiKey`, `api_key`, `api-key` and `X-Api-Key` are all one name to it — applied before the value's shape is considered; nested objects and arrays are walked, and the copy accumulates on a null-prototype object so a `__proto__` argument cannot reach the prototype chain from the logging path. The walk is total, because it runs while recording what happened — including a denial taken before the route's own validation: a non-object root yields an empty record, a cycle terminates as `[Circular]` without mistaking a shared reference for one, and a payload nested past the depth limit as `[Truncated]` rather than overflowing the stack.

- e72244a: Add a `guren_agent_surface` tool to the development MCP endpoint (RFC 0016 §9).

  Reports every route that declares agent metadata — tool name, method and path, description, exposed surfaces, MCP annotations as declared, approval requirement, and derivable authorization — so a coding agent can see whether the route it is about to edit is already reachable by an autonomous agent. Reads the project context the CLI produces, so it inherits the same fresh-process route loading the other route-dependent tools use; annotation defaults are deliberately not filled in here, since the derivation layer owns that rule.

  It stays a separate tool rather than a field on `guren_get_context` for the reason the agent-interface guidance itself gives: a catalog an agent must read in full is a catalog that costs context, and the exposure question is asked about one route at a time, usually right before editing it. `guren_get_context` answers "what is in this project" for a whole session; this answers "what can an autonomous agent already invoke" in a payload small enough to ask casually. When the app's `@guren/cli` predates agent metadata, the tool says so explicitly instead of returning an empty list — "nothing exposed" and "this CLI cannot answer" are different facts.

- 327b4b5: Derive agent tools from route contracts (RFC 0016 PR-1b).

  - `deriveAgentTools(definitions)` turns the route definitions a router hands out into MCP-shaped tools: name, description, input/output JSON Schema (2020-12), annotation hints, authorization, approval and redaction. Only routes that declare `.agent()` _and_ carry a name become tools; everything else about a tool derives from contracts the route already has, so a tool cannot advertise a schema the endpoint does not validate.
  - Input merges `params` + `query` + `body` into one object schema, supplements path parameters the `params` schema omits as required strings, and nests a non-object `body` under a `body` key. Path parameters are required whatever describes them — a schema declaring one optional gives its _type_, not permission to omit it from a URL. Nothing throws: a key collision is reported as a warning and resolved deterministically in the body's favour, so the runtime derivation stays total (the static check fails the build instead).
  - Annotation defaults follow the MCP spec: GET/QUERY are `readOnlyHint`, read-only tools are non-destructive, GET/QUERY/PUT/DELETE are idempotent. Explicit metadata always wins.
  - Authorization is emitted only when the route's stamped capabilities make it unambiguous — one ability checked with `mode: 'all'`, or a resource check that resolves its ability from the built-in verb map. Anything else is omitted rather than guessed.
  - A route's `resource` hint is carried only when the route declares no `output` schema — declared, not merely renderable, so an `output` the walker cannot express still outranks the hint rather than letting an unvalidated claim describe the response.
  - The Hono path lexer is now shared too (`@guren/server/internal/route-path`, re-exported by `@guren/core/internal/route-path`). `@guren/openapi` had its own copy that dropped a trailing `*` while lexing, so `/files/:name*` named the parameter `name` there and `name*` — what Hono registers — everywhere else. Its documents are byte-identical: OpenAPI path templates are RFC 6570 URI templates where `{name*}` means "explode", so the asterisk is now stripped where the document renders instead of where the path is read.
  - The Zod → JSON Schema walker moved from `packages/core/src/internal/` to `packages/server/src/internal/`, with `@guren/core/internal/zod-compat` and `@guren/core/internal/zod-json-schema` kept as re-exports. `@guren/core` builds after `@guren/server`, so the walker had to move down to the package the derivation and the OpenAPI generator can both import. No consumer's import specifier changes.

- 5cbccb0: Stamp authorization capabilities on the authorize middlewares, so a route's
  required ability is derivable from its middleware chain instead of from
  controller bodies (RFC 0016 §4).

  `authorizeMiddleware`, `authorizeAllMiddleware`, and
  `authorizeResourceMiddleware` now carry an RFC 0007 capability stamp, which
  `Router.definitions()` aggregates into `RouteDefinition.capabilities`
  alongside the existing authentication capability. A single ability reports
  `{ abilities: ['update'], mode: 'all' }` however it was written; two or more
  alternatives report `'any'`; `authorizeAllMiddleware` reports `'all'`; the
  resource variant
  reports a `resource` marker, whose `fromMethodMap` says whether the built-in
  HTTP verb map decides the ability (it does not when an `abilityFor` callback
  overrides it). A chain carrying several checks that do not combine into a
  single all-of reports `mode: 'mixed'` — authorization is present, but no one
  ability may be named for it.

  Three behaviour changes come with it:

  - `authorizeAllMiddleware([])` now throws at creation. `Gate.all([])` is
    vacuously true, so an empty list mounted a route that advertised
    authorization and enforced none.
  - All three middlewares now snapshot their arguments at creation
    (the ability array, and `options.abilityFor`), so mutating them afterwards
    can no longer change what is enforced or make the stamp disagree with it.
  - `authorizeMiddleware(['one-ability'])` is now treated exactly like
    `authorizeMiddleware('one-ability')`, so its denial carries the policy's own
    message and status instead of the generic any-of message. Two or more
    alternatives are unchanged.

  The capability shape stays internal (nothing new is exported from the package
  root) and may change in any release.

- a9077f4: Skip CSRF verification for `Authorization: Bearer` requests that carry no `Cookie` header (RFC 0016). CSRF defends cookie ambient authority, and a cookie-less bearer request has none to attach — the token is the client's own deliberately presented credential. A request carrying any cookie verifies exactly as before, so a forged Bearer header on a victim-browser request skips nothing, regardless of middleware mount order. Token issuance is unchanged.
- 15f969a: Add `@guren/plugin-mcp`: the production App MCP endpoint (RFC 0016 §7). `mcpPlugin()` mounts a bearer-authenticated Model Context Protocol endpoint (default `/mcp`) serving the tools the app's `.agent()` routes derive. Every call re-enters the application through `app.fetch` as a real HTTP request — validation, policies, and middleware run exactly once, in the app — with `env` and execution context forwarded for Workers bindings. The adapter enforces what must precede HTTP: bearer verification against the app's `ApiTokenStore`, token scopes (a token's catalog lists only what it can call; the `ApiToken` default `['*']` grants nothing), fail-closed refusal of `approval: 'required'` tools until the approval queue ships, and per-token rate limits with a stricter write budget. Each refusal emits `AgentToolDenied` and each execution `AgentToolInvoked`, arguments redacted.

  `@guren/server` grows the adapter-facing surface: `DerivedAgentTool.inputSources` and `inputBodyNested` record how a flat tool call maps back onto path, query, and body (the merge's inverse, so a POST route's `query` keys land where `validateQuery` reads them), `AuthManager.getApiTokenStore()` exposes the store `useTokens()` configured, and `readBearerToken` joins the root exports.

- 89aa23f: Stop `@guren/testing`'s controller mock keeping its own copy of the request-body parser.

  The mock reimplemented the runtime's rules for reading a body, and the copy drifted from the original repeatedly. Every one of these was a separate fix to the copy, each landing after a mocked controller test had already passed on behavior the runtime does not have: an uppercase media type, a `;`-parameterized one, a repeated `field[]`, a `__proto__` field, and a body no parser can decode.

  Those fixes stand; this removes what made them necessary. The mock now reads the runtime's parser through the new `@guren/server/internal/request` subpath, wrapping its `Request` in a `HonoRequest` so the parser finds the three members it reads — `header()`, `json()`, `parseBody()` — from the same class a live request supplies. The media-type decision inside `parseBody()` is then Hono's own rather than a restatement of it, and the repeated-field collapse, the `{}` fallback and the record view (`asRecord`, behind `parseRequestPayload`) are single copies shared with the runtime. Only the adapter stays local, because the runtime is handed a Hono context and the mock holds a `Request`.

  Sharing the parser closed one divergence the earlier fixes could not reach, because it is not about _what_ a body parses to. The runtime boxes its parse, so two `validateBody()` calls in one action are handed the same object; the mock re-parsed and handed out two, and a schema that mutates what it validates then saw a different body on its second read. The mock now memoizes the raw body as the runtime does, in a new `rawBody` box beside the existing `parsedBody` record memo — additive, and `parsedBody` keeps both its declared shape and its role. Apart from that, behavior is unchanged: the copies had already been brought into agreement, so the rest is the structural half.

  One restatement remains, and its previous justification was wrong. `Controller.file()` / `files()` do **not** gate the multipart read on the media type — the runtime's `parseUploads()` is `ctx.req.parseBody({ all: true })` in a try/catch, with Hono deciding the media type inside. The mock gates because it reads uploads through `Request.formData()`, which is case-sensitive where Hono lowercases first, so dropping the gate without also moving off `formData()` would reintroduce the uppercase-multipart divergence rather than fix it. Sharing the runtime's upload read is the actual fix and is filed separately, because it changes the published type of the public `readMultipart()`.

  `parseRequestBody()` also stops declaring a full Hono `Context` it never reads. It now takes a structural `RequestBodyContext` — `header`, `json`, and an optional `parseBody` — which is what the mock adapts to without a cast, and which makes the existing `typeof ctx.req.parseBody === 'function'` guard meaningful instead of looking dead against a type that always has one. Narrowing a parameter accepts strictly more callers, so `Router`, `Controller`, the validation middleware, `FormRequest` and `BroadcastManager` are untouched.

  `packages/testing/tests/controller.test.ts` gains a parity table running json, urlencoded, multipart, unsupported and absent content types — plus uppercase and `;`-parameterized ones, repeated fields, and a body that must reach validation unnarrowed — through a real `Application.fetch()` controller and a mocked one, requiring the same answer from both. It complements the per-divergence tests already there by covering the space rather than the known cases, and it guards the runtime as well as the mock: each row asserts the runtime's answer first, so a change to `parseRequestBody` surfaces here instead of in a mock that silently followed it. A separate case pins the parse memo by object identity, which is the only probe that separates one parse from two. Note where it runs — `@guren/testing`'s suite is not part of `bun run test`, so `bun run test:testing` is the gate that speaks for this parity.

  Two runtime behaviors the table pins deserve naming, since both look like bugs and neither changed here: `Content-Type: APPLICATION/JSON` is **not** read as JSON, and `text/plain; profile=application/json` **is**. The runtime's JSON branch is a case-sensitive substring test on the raw header, the one part of the decision Hono does not normalize.

  `@guren/server` gains only that subpath — no behavior change, and nothing new on the package root. It is internal by the rules in `contributing/api-stability.md`: reachable only through a deep import under `internal/`, carrying no stability guarantee, and existing so the two packages cannot drift apart, exactly as `@guren/server/support/expiry` and `@guren/server/internal/route-path` do.

  **Release step:** `@guren/testing`'s required `@guren/server` peer must be raised from `>=2.2.0` to the version this release publishes for `@guren/server` — the first one carrying the subpath. It cannot be raised in the pull request that adds it: `audit:plugin-compat` requires every `@guren/*` range to admit the version the workspace currently publishes, and that is still 2.13.0 until `changeset version` runs. So the edit belongs in the release pull request, beside the generated version bumps, and nothing catches it if it is skipped — the floor would then claim a compatibility this package does not have, and an install pinning an older `@guren/server` while upgrading `@guren/testing` alone would fail to resolve the deep import.

- 1218a8a: Add `TokenGuard` and unify bearer-token authentication with the auth context (RFC 0016 Phase 0).

  - `TokenGuard` implements the `Guard` contract backed by an `ApiTokenStore`: `requireAuthenticated()`, `Controller.auth`, and `Gate` now treat token-authenticated requests exactly like session-authenticated ones. Successful verification also populates `ctx[API_TOKEN_KEY]`, so `getApiToken()` and `tokenCan*` keep working. `logout()` revokes the presented token; credential flows (`login`/`attempt`/`validate`) throw.
  - `AuthManager.useTokens(store, { provider?, guardName?, updateLastUsed? })` registers the guard and enables header-based selection: an unqualified `auth.guard()` resolves to the token guard when the request carries `Authorization: Bearer`, and to the default (session) guard otherwise. Explicit guard names always win; session-only apps are unaffected.
  - `Gate.resolveUser()` now treats an attached framework auth context (`guren:auth`) as authoritative — including when it resolves no user — so policies receive the principal for both session and bearer requests, and a rejected authentication can no longer be shadowed by a manually-set `ctx.set('user', ...)`. An explicit `userResolver` still takes precedence, and the legacy `ctx.get('user')` fallback continues to work for requests with no auth context attached. **Behavior note:** apps that attach the auth context _and_ set a reduced/impersonated principal via `ctx.set('user', ...)` for Gate evaluation should move that logic to `defineGate({ userResolver })` or `gate.forUser(...)`, which keep precedence.
  - With a configured user provider, `TokenGuard.check()` requires the token's user to resolve — an unrevoked token for a deleted account is not authenticated. `logout()` also clears the request's `API_TOKEN_KEY`, and `useTokens()` refuses a `guardName` that would shadow an already registered guard.
  - New export: `VerifiedApiToken` (the result shape of `verifyApiToken`).

### Patch Changes

- ea515ae: Remember the options `useTokens()` configured its guard with, and expose them as `AuthManager.getApiTokenOptions()`. Machinery that replaces the token store without meaning to change anything else — `guren tool:dev` installs an ephemeral store over the app's — could otherwise only call `useTokens(store)`, which silently dropped the app's `provider`: a token then resolved to a bare `{ id }` instead of the real user record, and every policy reading a user field behaved differently for no stated reason.
- ec10be6: Route contracts and `validateBody()` accept non-object request bodies.

  A body that parsed to anything other than a plain object was replaced with `{}` before validation ever saw it, so a route declaring `body: z.array(z.number())` or `body: z.string()` could not receive its payload — every request 422'd against an empty object, whatever the client sent. This affected every HTTP caller, not one dispatch path.

  The parse step now has two shapes, and the caller picks by what it does with the result:

  - `parseRequestBody()` (internal) returns the parsed value as sent — an array stays an array, a string stays a string — and is what feeds a route contract's `body`, `Controller.validateBody()` / `validateBodySafe()`, and the `validateRequest()` / `validateRequestWith()` middleware. The schema decides the shape.
  - `parseRequestPayload()` (unchanged, still exported) is the record view, for callers that read the body field by field: `Controller.input()` / `only()` / `except()` / `has()`, `FormRequest` rules, and broadcast channel authorization. A non-object body reads as `{}` there, exactly as before, because there is no field to read on one.

  Two behaviors are deliberately preserved. A malformed or empty JSON body still parses to `{}`, so an all-optional object schema keeps passing on an empty POST — the cost is that a non-object schema sees that `{}` and returns 422 rather than receiving nothing. And form submissions still normalize to a record, since they have no non-object shape to keep. (A form body that fails to parse at all is unchanged and still separate: `Controller` catches it and validates `{}`, while a route contract or `validateRequest()` lets it surface as a 500.)

  `@guren/testing`'s controller mock gains the same split. Its `parseRequestPayload` now narrows exactly as the runtime's does, and the mock `Controller` gains `getRawBody()`, which validation reads instead. Previously the mock narrowed nowhere, so a mocked controller and a real one disagreed on every non-object body — a test written against the mock could pass on code the runtime would 422. Two divergences on the same path close with it: a JSON body of literal `null` is no longer coalesced to `{}` before validation, and a body the parser rejects falls back to `{}` as the real `Controller` does rather than throwing out of `validateBody()`.

  The change to the mock is additive — `getRawBody()` is the only new member on the exported class type, and `parsedBody` keeps both its declared shape and its role as the record-view memo.

- a259c3b: Validate a route's `output` schema against successful responses only. `output` states what the action _returns_, so a failure response is outside it by construction — the exception handler wrote that body, not the action. Validating it anyway rewrote every `validateBody()` rejection on such a route into `500 Response validation failed`, hiding the real 422 behind a report that the app had violated its own contract. RFC 0016 makes the combination usual rather than exotic, since `guren check` warns about an agent route with no `output` schema.

  A 3xx response with a JSON body is no longer validated either, which was mostly latent already (a redirect's empty body tripped the parse guard and skipped validation). The agent surface is unaffected: `mapToolResponse` independently reports a 204 or 3xx from a tool advertising an object output schema as an error result.

- bc70b7f: Stop `Router.definitions()` from recursing forever on a route `resource` hint
  that is neither a Resource class, a single-element array, nor a plain object.

  The hint is purely declarative and nothing validates it at runtime, so a value
  outside `ResourceResponseHint` reaches the serializer. A string recursed until
  the stack overflowed (every character is itself a one-character string), `null`
  threw out of `Object.entries`, and a class instance serialized to `{}` — a
  response shape the server never sends. All three now void the whole hint, the
  same all-or-nothing rule an unnamed Resource class already followed.

- 3b55863: Serve opt-in root public assets with the right content type, and export `escapeHtml`.

  `registerRootPublicAssets` now knows the content types for `.js`, `.mjs`, and `.css`. They stay out of the default extension allowlist, so nothing new is exposed — but an app that opts one in no longer has to restate its type to stop the browser refusing an `application/octet-stream` script or stylesheet.

  `@guren/plugin-markdown` exports `escapeHtml`, which consumers passing `sanitize: false` need for anything they hand back through the `highlight` callback.

- cfb4a8d: Host the single-child wrapper unwrap step once, in `internal/zod-compat`.

  Three walks look through zod's wrappers for different reasons — finding the
  object behind a params schema, rendering a TypeScript type, deciding whether a
  property may be omitted — and each carried its own copy of the traversal. The
  copies agreed, but nothing made them: a wrapper name or pipe direction known to
  one and not another silently changes an answer, which is the whole reason the
  vocabulary itself already lived in one place.

  `unwrapSingleChild(schema, io)` now applies that vocabulary for all of them.
  What each caller _concludes_ from a wrapper stays with the caller, because those
  conclusions legitimately differ: the CLI's type renderer reads only the side of
  a `.pipe()` it renders so presence matches the type it names, while the JSON
  Schema walker and the route contract check require both sides to permit
  omission. No behaviour changes.

  Internal by `contributing/api-stability.md` — reachable only through a deep
  import, with no stability guarantee. `@guren/cli` is released alongside so its
  `@guren/server` range admits the version that introduces the helper it now
  reaches through `@guren/core/internal/zod-compat`.

- 9e19202: A request body the form parser cannot decode fails validation instead of crashing the request.

  Sending a body the form parser rejects — a `Content-Type: multipart/form-data` with no usable boundary, say — used to get a different answer depending on which validation path read it. A route contract and the `validateRequest()` / `validateRequestWith()` middleware let the parser's `TypeError` escape, so the client got a **500** whose body reported the exception and a stack trace; `Controller.validateBody()` caught it and validated `{}` instead. Three readers of the same request, three answers.

  A malformed body is a client error, so it is now treated as one: the parse step falls back to `{}` and the schema decides, which puts it alongside every other body-validation failure — a 422 for any schema that rejects `{}`. The fallback lives in `parseRequestBody()`, which is also what `parseRequestPayload()` reads, so the field-by-field callers stop throwing on one too: `Controller.input()` / `only()` / `except()` / `has()`, `FormRequest` rules, and broadcast channel authorization, which answers its usual 400 (`No channel specified`) rather than a 500.

  **This changes a status code.** A client branching on 500 for a malformed form body now sees whatever its schema decides — 422 for the common case. The response body is the ordinary validation-error shape rather than an exception report; leaking the parser's message and stack to the client was itself part of the old behavior.

  Two things this deliberately does not change. An all-optional object schema keeps _passing_ on an undecodable body, because the fallback is `{}` and not `undefined` — the same answer it has always given for an empty POST or malformed JSON. And it covers the paths that hand the body to a schema, not every read of one: CSRF token extraction catches the parser's error itself and fails closed at 403, unchanged. `Controller.file()` / `files()` parse the multipart body themselves rather than through this fallback, and get their own guard — see the accompanying note.

  `Controller.getRawBody()` drops its own now-redundant fallback and reads the shared one. `@guren/testing`'s controller mock does the same, and its parser's fallback now covers the whole body read rather than one content type, so the mock and the runtime give the same answer for an undecodable body. A ctx carrying no request at all still throws there rather than reading as `{}` — that is a broken test setup, not an unparseable body.

- 4335cbc: `Controller.file()` / `files()` report no upload for a request body the form parser cannot decode, instead of crashing the request.

  Both helpers parsed the multipart body themselves, unguarded. A body the parser rejects — a `Content-Type: multipart/form-data` carrying no usable boundary, say — made that parse throw a `TypeError`, which escaped the action as a **500** whose body reported the exception and a stack trace. Any route reading an upload was one malformed request away from that, whether or not it also validated a body.

  An undecodable body carries no file, so it is now answered as one: `file()` returns `null` and `files()` returns `[]` — the same answers both already give for a field that is simply absent. Callers that already handle "no file was uploaded" need no change; the throw is what goes away.

  This finishes the surface started by the empty-object fallback in `parseRequestBody()`, which fixed the body-_validation_ paths and named these two as a known exclusion. They stay separate on purpose rather than sharing that fallback: it parses without `{ all: true }` and flattens a repeated field to its first value, so routing the upload helpers through it would silently reduce `files()` to one file per field. The shared rule is a guarded multipart parse of their own, which keeps `{ all: true }`.

  Like the fallback it sits beside, the guard does not distinguish whose fault the parse failure was: a body the client could never have sent correctly and a body already consumed upstream — middleware reading `ctx.req.raw` directly, bypassing Hono's cache — both read as "no upload" here. That is deliberate for the same reason, telling the two apart means matching runtime-specific error codes that differ on Bun, Node and Workers. The cost is worth naming: a middleware-ordering bug that used to surface as a loud 500 now reads as an absent file.

  **This changes a status code.** A client branching on 500 for a malformed upload now gets whatever the action does with no file — often its own validation error rather than an exception report. Leaking the parser's message and stack to the client was itself part of the old behavior.

  `@guren/testing`'s controller mock has the same guard, so a controller test and the runtime give the same answer for an undecodable upload.

## 2.13.0

### Minor Changes

- 36257a7: Signed-delivery groundwork (RFC 0015 Part 1).

  `signUrl`/`verifySignedUrl` now accept app-relative input (`/path?query`)
  and return it relative — previously `signUrl('/path')` threw. Query
  canonicalization sorts by code unit instead of the locale-dependent
  `localeCompare`, the `expires` parameter must be a plain positive integer
  (`NaN`/`Infinity` no longer verify), `signUrl` rejects a non-finite
  `expiresIn`, and `verifySignedUrl` returns `false` on malformed input
  instead of throwing.

  `StorageDriver` gains three additive members: an optional
  `getStream?(path, { range? })` streaming read (implemented by
  `LocalDriver` and `S3Driver`; callers fall back to buffered `get()` where
  absent), an optional `capabilities` declaration (`S3Driver` declares
  `{ presignedGet: true }`; absent means none — fail-closed), and an
  optional `TemporaryUrlOptions` bag on `temporaryUrl()` whose
  `responseContentDisposition`/`responseContentType` map onto S3's
  presigned response overrides.

## 2.12.0

### Minor Changes

- 104c9b6: First-class content rendering (RFC 0014): `Controller.view(component, props)`
  renders a `hono/jsx` component to plain server-rendered HTML — the
  non-hydrating counterpart to `this.inertia()` for public content pages, with
  auto-escaping, native `<title>`/`<meta>`/`<link>` head hoisting, and a loud
  error when a page forgets its Layout (pass `{ doctype: false }` for
  intentional fragments).

  Alongside it: `viteAsset(entry)` resolves Vite asset URLs (dev server in
  development, hashed manifest output in production, throws when neither
  resolves), and new `@guren/core/jsx-runtime` / `@guren/core/jsx-dev-runtime`
  subpaths let View files compile with `/** @jsxImportSource @guren/core */` —
  applications never declare hono themselves. `@guren/server`'s hono floor
  moves to `^4.13.0`, where the component result contract `view()` renders was
  introduced.

- 451755c: Build-time Vite manifest injection for serverless targets: `viteAsset()` now
  resolves production entries from `GUREN_VITE_MANIFEST` (the client manifest
  JSON) before reading the filesystem, and all three deploy plugins populate it
  during their build step — Cloudflare Workers and Lambda in their generated
  entry module, Vercel by substituting the read at bundle time. Content pages
  rendered with `Controller.view()` work on deploy targets whose runtime never
  sees `public/assets/manifest.json`.

### Patch Changes

- d1b1eb6: Follow `NextContinuationToken` in `S3Driver.files()`, `directories()`, and `allFiles()`. A single ListObjectsV2 request returns at most 1000 entries, so listings beyond one page were silently truncated — `deleteDirectory()` left objects behind on large directories, and callers treating the listing as complete missed everything past the first page. A truncated page without an advancing token now throws instead of returning an incomplete listing. `deleteMany()` splits deletes into the 1000-key batches DeleteObjects accepts, and root listings on a disk with a `prefix` no longer send a doubled-slash `Prefix` that matches nothing.

## 2.11.0

### Minor Changes

- ca7f360: Let a Resource declare its payload type, so `toJSON()` reports it

  `Resource<T>` now takes an optional second type argument for the payload
  `toArray()` builds:

  ```ts
  export class PostResource extends Resource<PostRecord, PostResourceData> {
    toArray(): PostResourceData {
      return { id: this.resource.id, title: this.resource.title };
    }
  }
  ```

  `toJSON()` returns `PostResourceData` instead of `Record<string, unknown>`,
  which removes the override every scaffolded resource used to carry — a method
  whose only body was `return super.toJSON() as PostResourceData`, a cast nothing
  checked against the `toArray()` right above it.

  The parameter defaults to `ResourceData`, so `Resource<T>` and existing
  overrides keep compiling unchanged. `JsonResource<T>` deliberately stays on the
  default: narrowing it to `T` would reject a subclass whose `toArray()` returns a
  subset, which is a break no minor should carry.

  `TData` describes `toArray()`. `additional()` still takes arbitrary
  `ResourceData` and is spread after the payload, so a colliding key can still
  overwrite a typed field — use it for keys beside the payload, not inside it.

## 2.10.1

### Patch Changes

- deaa5c0: Declare `sideEffects` so bundlers can tree-shake the framework. Without it a bundler must assume every module in the barrel may have a load-bearing top-level effect, so `export * from '@guren/server'` pulled the whole server package into a deployed function — mail (and nodemailer behind it), cache, queue, redis and the rest — for an app that imported none of them.

  This is what a serverless cold start pays for on every invocation. Measured against a fixture that resolves `@guren/*` from `dist` the way an installed app does, bundling a two-line entry that only uses `createApp` with the same stub set and options `@guren/plugin-vercel` uses: 1,137,335 to 672,676 bytes (-40.9%, 224 modules to 133), and its cold start from a 55.2ms to a 37.1ms median (-32.7%, n=30 per arm, interleaved). Of the modules that drop, 89 are ioredis, nodemailer and their transitive dependencies.

  `@guren/orm` and `@guren/core` use the array form rather than `false`, because `instance-guard` (the duplicate-copy detector) and `bin` exist only for their side effects. Two things are worth knowing before anyone simplifies this:

  - The ORM's dist entry names `./dist/index.js`, not `./dist/instance-guard.js` — tsup inlines the guard into the barrel rather than emitting it as its own file, so the per-file path would have matched nothing. Making it a separate tsup entry does not help: the guard then lands in a content-hashed chunk that no `sideEffects` entry can name stably.
  - Under Bun, `sideEffects: false` on the ORM also keeps the guard whenever an app uses the ORM, because Bun will not treat the guard's top-level global write as pure — so Bun alone cannot distinguish the two forms. The array is what makes the guarantee portable to rollup and webpack, which drop a bare-imported module from a `sideEffects: false` package by design. It costs 955 bytes for an app that never touches the ORM, since `@guren/core`'s barrel re-exports ORM names and so keeps the guard reachable.

  `@guren/server` is `false`: it has no module-scope side effects at all — no bare imports, no global mutation, no prototype patching outside function bodies.

  Both declarations are pinned by source-level tests, because nothing at runtime can check them: `bun test` never bundles, so a regression here would stay green everywhere and surface only in a bundled serverless build. One fails if a bare import appears under `packages/server/src`; the other fails if an entry in the ORM's array stops naming a file that carries the guard.

  No API changes, and nothing changes for unbundled apps — `sideEffects` is only read by bundlers.

- 8871c4c: Build with tsdown instead of tsup, and emit declarations with the native TypeScript 7 compiler. The public file layout of every package is unchanged (same `dist/*.js` / `dist/*.d.ts` entry names, shebangs, and `exports`); only the internal chunk names differ. tsup is unmaintained and its declaration bundler needs the JavaScript compiler API that TypeScript 7 no longer ships.
- 49f7edb: Keep scaffolded apps and the framework compiling under TypeScript 7.

  - Scaffolded `tsconfig.json` no longer sets `baseUrl`, which TypeScript 7 rejects (TS5102); `paths` already resolves from the tsconfig directory without it.
  - `guren doctor` warns on a root `baseUrl` (TypeScript 7 rejects it), and its autofix removes one while adding the `@/*` alias.
  - A `resources/js/vite-env.d.ts` declares the virtual `@vite/client` module, since TypeScript 6+ checks that side-effect imports resolve.
  - The dev banner's JSON import uses the standard `with { type: 'json' }` attribute instead of the removed `assert` form.

- Updated dependencies [deaa5c0]
- Updated dependencies [8871c4c]
  - @guren/orm@2.6.1

## 2.10.0

### Minor Changes

- b0625ee: Remove `ApplicationOptions.discover`. The option was accepted and silently ignored since it was introduced — nothing in `Application` ever read it, so no discovery ran and no behavior exists to migrate. This ships as a minor deliberately: it is a type-surface bug fix, not an API removal. JavaScript apps are unaffected either way, and TypeScript code passing `discover: true` now gets a compile error naming the truth instead of a silent no-op. The `AutoDiscovery` class remains available as a standalone scanner; its docs now state that registration in Guren is explicit and show how to feed scan results into the registries yourself.
- 1ebda4b: Serve Vite's content-hashed build assets (`/public/assets/*` in production) with `Cache-Control: public, max-age=31536000, immutable`. Their filenames change on every content change, so browsers can cache them forever instead of re-downloading on each visit. Files elsewhere under `public/` keep stable names and are served without a caching header, unchanged; the dev-mode route stays uncached so HMR keeps working. The prefix follows a custom `publicRoute` (e.g. `/static/*` → `/static/assets/*`).
- 532879c: A route `params` schema failure is now 422 on both handler kinds. It used to depend on how the route was handled: a controller action reported 422, while a functional typed handler given the identical schema and request reported 400.

  422 is the framework's validation status. `ValidationException` is 422, the `validateBody` / `validateQuery` / `validateParams` helpers the guides document throw it — including the guides' explicit "422 on invalid params" — and the `query` and `body` halves of these same contract options were already 422 on both paths. Only `params` was spelled 400, and only the functional path ever put that number on the wire; the controller path built a 400 response and discarded it to throw `ValidationException` instead. The status is what clients branch on: `InertiaServiceProvider` renders `ValidationException` into `form.errors`, and a 400 skips that entirely, so a form posting to a functional handler saw its params errors silently dropped.

  This ships as a minor rather than a major deliberately. The affected surface is narrow — functional typed handlers that declare a `params` schema — and the change moves behavior toward what the documentation already promises rather than away from it, so code written against the documented contract keeps working and code written against the old number was reading an inconsistency. Update any client or test asserting 400 on a params failure to expect 422.

  The response body still differs in shape between the two paths: a controller action returns `{ message, errors: { field: [...] } }` and a functional handler `{ errors: { field: "..." } }`. That difference is not specific to `params` — it already applies to `query` and `body` — and is unchanged here.

### Patch Changes

- 19310c6: Keep the SIGINT/SIGTERM/exit teardown compiling under bun-types 1.4.0, which declares `process.off` with only a `"memoryPressure"` overload and thereby shadows the generic `EventEmitter.off` the signal names relied on. Runtime behavior is unchanged.

## 2.9.0

### Minor Changes

- 4464071: ### Deprecated

  - **Class-based seeder API (`BaseSeeder` / `Seeder`, `SeederRunner`, `createSeederRunner`, `resetCalledSeeders`, and the `SeederClass` / `SeederInterface` / `SeederRunnerOptions` types)** — Write seeders with `defineSeeder` instead. Deprecated in 2.9.0, will be removed in 3.0.0. Detected by `bunx guren upgrade --check-only` as `seeder-class-convention`.

  A seeder class is not itself unsupported. `db:seed` loads seeders through `runSeeders()`, which accepts a `defineSeeder` handler, an exported `seed`/`run`/`Seeder`, or a default export — including an exported class whose prototype has a `run` method, which it constructs and calls as `run({ db })`. That last shape is deliberate: `packages/orm/tests/seeder.test.ts` covers it as "supports class-based seeders with run method".

  What `BaseSeeder` gets wrong is the signature it imposes. Its `run()` is declared to take no parameters, so it hides the one argument a seeder needs. A subclass cannot simply correct that: declaring `run(ctx: SeederContext)` fails to compile against the base (`TS2416: Target signature provides too few arguments. Expected 1 or more, but got 0`). Widening it to an optional `run(ctx?: SeederContext)` does compile, but then the subclass must handle a missing context, and that case is real: `call()`, `callOnce()`, `callMany()` and `callParallel()` construct child seeders and invoke `run()` with no arguments at all, so a parent that received a context cannot pass it down. The result is a seeder that is counted as having run while its context handling is left to chance.

  `SeederRunner` is the orchestration those classes were written for, and no Guren command reaches it. It runs a single seeder per call — a class passed in, a name registered with `register()`, or a name resolved to `<seedersPath>/<Name>.ts` defaulting to `DatabaseSeeder` — constructing it with `new` and invoking `.run()` with no context. `db:seed` does none of that; it runs every seeder in the folder.

  Nothing is removed and no existing call changes its result. This adds `@deprecated` JSDoc naming the replacement, a once-per-process runtime warning from the `BaseSeeder` and `SeederRunner` constructors, and a `seeder-class-convention` entry in the deprecation registry so `bunx guren upgrade --check-only` reports affected files. No codemod ships with it: the migration moves a class body into a handler and has to resolve how each `call()`/`callOnce()` child receives `db`, which is not a mechanical rewrite.

  These exports are re-exported from `@guren/core`, which makes them Stable under `contributing/api-stability.md`, so the deprecation policy's minimum of two minor versions applies before removal. Deprecated in 2.9.0, that permits removal from 2.11.0 onward: `removedIn` targets 3.0.0 on the assumption that 3.0.0 follows 2.11.0, which is also what keeps this removal in the same batch as `local-disk-per-object-visibility`. If 3.0.0 is cut earlier than that, this entry moves to the following major rather than being removed early.

  The sibling `BaseFactory` / `Factory` / `defineFactory` exports live in the same directory and are deliberately untouched — `make:factory` scaffolds `class …Factory extends Factory<typeof Model>`, `Factory` being the `BaseFactory` alias.

### Patch Changes

- Updated dependencies [50bdfec]
- Updated dependencies [c8489f9]
- Updated dependencies [6cbb012]
  - @guren/orm@2.6.0

## 2.8.0

### Minor Changes

- 2be4b64: Bind a route parameter by a column other than the primary key

  `bind: { id: Post }` resolves the parameter with `Post.findOrFail(value)`, so a
  `/posts/:slug` route could not use route model binding: the router looked the
  slug up as a primary key and answered 404 for every real post. The only way
  through was an adapter object (`{ findOrFail: (v) => Post.findOrFail(v, 'slug') }`)
  passed to both `bind:` and `this.model()`, which worked by accident of the
  structural type and appeared nowhere in the docs.

  The `bind` option now also accepts a `[Model, column]` tuple. The router calls
  `Post.findOrFail(value, column)` and `this.model(Post)` returns that record, so
  the class-only form and the tuple form read the same in the controller:

  ```ts
  router.get('/posts/:id',   { bind: { id: Post } },              [PostController, 'show'])
  router.get('/posts/:slug', { bind: { slug: [Post, 'slug'] } },  [PostController, 'show'])

  async show() {
    const post = this.model(Post)
  }
  ```

  Router-level `router.bind(param, ...)` accepts the same tuple, and its model
  bindings — class or tuple — now feed `this.model(Post)` too. Values from
  `router.bind()` still arrive as positional arguments after the context, in
  path-parameter order; that is the only channel for a custom resolver function,
  which has no model class to look the record up by. Because `this.model()` is
  keyed by the model class, a route's own `bind` wins whenever both levels would
  write the same class — a same-param override, or two params bound to one
  model. The router-level binding still resolves and still fills its positional
  slot, so a custom resolver's side effects are never skipped.

  Neither channel ever landed on the Hono context: the routing guide told
  readers to use `this.ctx.get('post')`, which has always been `undefined`. The
  English and Japanese guides, the agent harness rules, and the `guren context`
  API digest now describe the two channels that exist, including the one limit
  `router.bind()` has always had — bindings resolve for controller-action routes,
  never for inline handlers, which take Hono's `(ctx, next)`. A router test pins
  each behavior, so the docs cannot drift from the implementation unnoticed
  again.

  `this.model(Post)` is also typed as the model's record now. Its return type
  was read off `findOrFail`, which is generic in `this`, so `ReturnType` widened
  it to the base row (`Record<string, unknown>`) and `post.id` came back
  `unknown` — the docs claimed `PostRecord` all along. The record type now comes
  from the `recordType` marker `defineModel()` sets; anything without a usable
  marker — including an adapter whose `recordType` names something other than a
  record — keeps the previous fallback.

  `BindableModel` and the new `RouteModelBinding` type are exported from
  `@guren/core` for code that builds `bind` maps outside a route call.

### Patch Changes

- 0fd78a8: Publish the application container so `Job.make()` works

  `Job.make()` and the exported `resolve()` read the process-wide container that
  `setContainer()` fills in, but nothing in the framework ever called it. Every
  job that resolved a service — `this.make('mail')` inside `handle()`, the way a
  controller resolves one — therefore threw `Container not initialized. Call
setContainer() first.` the moment a driver ran it, whether that was `SyncDriver`
  in-process or the worker behind `guren queue:work`.

  `Application` now publishes its own container, so anything reaching for the
  global finds the app's bindings.

  It publishes at construction rather than in `boot()`: `guren queue:work`
  bootstraps the app only far enough to read the queue driver, and an entry that
  merely exports the application — with no `ready` or `bootstrap` export — is
  accepted there and never booted. A job dispatched from module scope is in the
  same position. Bindings a service provider registers still only exist after
  `boot()`, as before; construction publishes the container, not its contents.

  Publishing is the constructor's last step, so an application that fails to
  build leaves the previous one's container in place instead of replacing it with
  a half-built one. Otherwise the most recently constructed application wins,
  which is what `bun --hot` needs — a reloaded entry replaces the stale container
  rather than being ignored.

- Updated dependencies [9e1ce65]
- Updated dependencies [7251560]
- Updated dependencies [866919c]
- Updated dependencies [32e03dd]
- Updated dependencies [39b17e7]
  - @guren/orm@2.5.0

## 2.7.0

### Minor Changes

- 2b98e24: Let the S3 driver talk to endpoints without object ACLs, and scaffold a switchable disk

  `S3Driver` sent `x-amz-acl` on every `PutObject` and reached for
  `PutObjectAcl` / `GetObjectAcl` for visibility, which is correct for AWS S3
  and wrong for several S3-compatible endpoints. Cloudflare R2 documents both
  the header and the ACL operations as unsupported — access there is decided
  per bucket — and MinIO deployments vary. The storage guide has recommended
  `driver: 's3'` against R2 for a while, so this affected a documented path.

  `S3DriverOptions.acl` (default `true`, so nothing changes for AWS) turns the
  header off. With `acl: false` visibility becomes a property of the disk:
  `getVisibility()` reports the configured `visibility`, and `put({ visibility })`
  or `setVisibility()` throw when asked for the other value instead of silently
  dropping it — a `setVisibility(path, 'private')` that does nothing on a public
  bucket is a leak that looks like success.

  The `StorageDriver` contract now states what the visibility methods do,
  which four drivers had been answering three different ways: a visibility
  call throws when the file does not exist, and a backend without per-object
  visibility reports the disk's configured value and refuses the other one
  instead of accepting a request it cannot carry out. `R2Driver` and the new
  `acl: false` path follow it from the start.

  **Deprecated, not changed:** `LocalDriver` has always accepted per-object
  visibility requests and done nothing — `put({ visibility })` and
  `setVisibility()` against a disk's other value, and either visibility method
  against a file that does not exist. It now warns once per process for each
  and keeps its current behaviour; these become errors in 3.0.0. What makes a
  local file reachable is the disk root and whatever serves it, not a flag on
  one file, so those calls were never carried out, they only looked like they
  were.

  To get ahead of it, declare the visibility on the disk rather than the call:
  the scaffolded `public` disk now carries `visibility: 'public'`, and files
  that must not be reachable belong on a disk that is not served.
  `bunx guren upgrade --check-only` lists the call sites.

  Separately, `guren add storage` now scaffolds a disk map selected by
  `STORAGE_DISK`, so an app declares its disks once and picks one per
  environment. The generated provider validates the name at boot: an unknown
  one is accepted by `createStorageManager` and only fails when a disk is first
  resolved, which can be inside a queued job.

## 2.6.0

### Minor Changes

- 1f815fd: Routes can declare their response shape by naming the Resource that builds it, and the generated API client types `json()` from it.

  `RouteContractOptions` gains a `resource` field: a Resource class, a one-element array (a collection), or a plain object of either (an envelope) — `resource: { data: [PostResource] }` mirrors `this.json({ data: PostResource.collection(posts) })`. Unlike `output`, nothing runs at request time; the hint is purely a type-level declaration, so the response shape lives in one place (the Resource's `toArray()` type) instead of being restated in Zod.

  `definitions()` serializes the hint to class names (`RouteDefinition.resource`), and `guren codegen` resolves those against the Resource classes it already extracts into `.guren/data.gen.ts`, emitting the assembled shape (`{ data: Data.Post[] }`) as the route's `response` type — the same slot an `output` schema fills, and `output` still wins when both are declared. A hint naming a Resource class codegen cannot find warns and leaves that route's response untyped rather than claiming a shape the server does not send. `generateApiClientTypes` returns those warnings (`{ outputPath, warnings }`, the same contract as `generateOpenApiSpec`), and the MCP `guren_codegen` tool forwards them in its payload alongside `generated`/`skipped`.

  The blog starter's `posts.search` route now declares `resource: { data: [PostResource] }`, so its search page reads `json()` typed instead of asserting the shape at the call site.

### Patch Changes

- Updated dependencies [7b34556]
- Updated dependencies [b7b2b09]
  - @guren/orm@2.4.0

## 2.5.0

### Minor Changes

- 684db66: Add a public `Application.stop()` to undo `listen()`

  `listen()` had no counterpart. It bound a socket, took the process-wide active
  server slot, started a managed Vite dev server, and registered SIGINT/SIGTERM/
  exit teardown — and the only path back out was the module-private
  `stopActiveBunServer()`, which an app could reach by signalling the process or
  by calling `listen()` again to replace the server, but never to simply stop.
  An app could be started programmatically but only stopped by ending the program.

  `await app.stop()` now closes the socket, clears the instance's server and the
  managed Vite dev server, and detaches the teardown handlers. It takes the same
  `closeActiveConnections` flag Bun's own `stop()` does, defaulting to `false`:
  a caller reaching for a public stop is usually shutting down deliberately,
  whereas the hot-reload path inside `listen()` keeps forcing the close, since a
  reload must not wait on the server it is replacing. Calling it when nothing is
  listening, or calling it twice, is a no-op.

  Vite goes down with it. `listen()` is what started the dev server, and
  `listen()`'s own bind-failure path already closes the one it started; stopping
  the application while leaving the asset server up would strand it, and its
  published environment variables, in a process with no application server. That
  close is best-effort on the same terms as every other shutdown path — bounded by
  `GUREN_VITE_CLOSE_TIMEOUT_MS`, and a dev server that overruns the bound is warned
  about and abandoned rather than holding `stop()` open. `GUREN_INERTIA_ENTRY` is
  now unpublished alongside the other managed variables, but only when it still
  holds the entry `listen()` published; an app that set its own is left alone.

  The global active-server slot is cleared only when it still points at this
  instance's server, mirroring the ownership check `closeViteDevServer()` already
  makes. A second `listen()` anywhere in the process force-stops the previous
  server and takes the slot over, so an app that stopped afterwards would
  otherwise clear a live server's teardown out from under it.

  `app.address` follows from that: it reports `undefined` once stopped, and the
  new address after a restart. Its documentation already treated a stop the
  framework can see as clearing the address, and `stop()` is now one of those —
  what it still cannot see is a caller reaching past the framework to the Bun
  server's own `stop()`.

  The teardown handlers are detached rather than forgotten, on both halves.
  Registration was guarded by a flag that only ever went `true`, so a close that
  merely reset the flag left the handlers attached while claiming otherwise, and
  the next `listen()` piled on another set. `stop()` now removes them and
  `listen()` re-attaches exactly one set, which is what makes an app restartable
  in a single process — a restarted app with no handlers is killed by SIGTERM's
  default disposition instead of shutting down through its own teardown.

  The Vite dev server's handlers had the same defect and are fixed with it, which
  matters more than the count: a leaked set keeps its own signal handler, and
  because handlers run in registration order a stale one could call `process.exit()`
  ahead of the live server's shutdown. Those handlers also captured the
  `Application`, so each leaked set pinned an entire app — container, routes and
  providers included. Both registrars now share one helper that attaches the
  SIGINT/SIGTERM/exit trio and returns the disposer for it, so neither can drift
  back to a memo that disagrees with what is actually attached.

  The starter templates are unchanged: they resolve `@guren/*` from npm and
  cannot call this until the release that ships it.

- dbd2e64: `authorizeResourceMiddleware` now fails closed on HTTP methods outside its built-in mapping

  Previously an unknown verb (e.g. a custom `PURGE` route registered via `router.on()`) fell through to the `view` ability, so a user with only view permission passed the gate in front of a handler that may mutate state. Unknown methods are now denied with a 403 (`AuthorizationException`).

  - The built-in mapping is now explicit: GET/HEAD/QUERY → `view` (QUERY is safe per RFC 10008, matching CSRF and `guren audit` classifications), POST → `create`, PUT/PATCH → `update`, DELETE → `delete`. Behavior for these methods is unchanged.
  - Custom verbs can opt in via the new `abilityFor` option (`AuthorizeResourceOptions`): return an ability name for a method, or `undefined` to fall back to the built-in mapping.

  ```ts
  authorizeResourceMiddleware(getPost, {
    abilityFor: (method) => (method === "PURGE" ? "delete" : undefined),
  });
  ```

  If you relied on custom verbs passing as `view` checks, add an `abilityFor` mapping for them.

- 0e615fc: First-class support for the HTTP QUERY method (RFC 10008)

  QUERY is safe and idempotent like GET but carries a request body like POST — the right verb for search and filter endpoints whose criteria don't fit in a URL.

  - `router.query(path, options, handler)` registers QUERY routes with the same overloads as the other verbs, on the router and inside `middleware(...)` group builders (which also gain the generic `on()` for arbitrary methods).

  ```ts
  router.query(
    "/posts/search",
    {
      name: "posts.search",
      body: z.object({ keywords: z.array(z.string()) }),
    },
    [PostsController, "search"]
  );
  ```

  - `TestApp.query(path, body?)` drives QUERY routes in tests.
  - Codegen picks QUERY routes up automatically; the generated API client sends them with a body (`client.request('posts.search', { body })`).
  - CSRF protection deliberately skips QUERY by default: it is a safe method, and browsers cannot send it without a CORS preflight. Keep QUERY handlers read-only, or opt into protection via the middleware's `methods` option — the generated client keeps sending the XSRF header on same-origin browser requests, so that opt-in works there (cross-origin clients supply their own header, as with every method).
  - `guren audit` checks body validation on QUERY routes without demanding auth middleware on them, matching GET.
  - The OpenAPI generator now allowlists the methods OpenAPI 3.1 can express and skips others (QUERY included) with a warning — previously a QUERY route would silently produce an invalid document. Mounted docs surface those warnings once via `console.warn`.

  Also fixed: `createCorsMiddleware` used to hand Hono an explicit `allowMethods: undefined`, which erased Hono's default and made every preflight answer without an `Access-Control-Allow-Methods` header. Guren now owns the default list (GET, HEAD, PUT, POST, DELETE, PATCH, QUERY).

  Deployment note: Guren's fetch-based adapters (Bun, the Cloudflare Workers and Vercel plugins) do not block QUERY, but verify your platform's ingress accepts the method — CloudFront, which fronts the app in the Lambda plugin's asset setup, does not forward it.

### Patch Changes

- 9452c71: Fix `Application` lifecycle races that could kill a live server or orphan one

  `listen()` and `stop()` tracked the running server across several independent
  pieces of state, and neither checked whether that state still described the
  server it was acting on by the time it resumed from an `await`. Three ways that
  went wrong:

  **A stopped app could close a Vite dev server a newer app adopted.** On a
  `bun --hot` reload the next `listen()` reuses the dev server the previous run
  left listening, so both applications held the same server object. `stop()` on
  the earlier one saw its own reference set and closed it — taking the asset
  server, its port, and its published `VITE_DEV_SERVER_URL` out from under the
  app that was serving from it. Comparing references cannot catch this: it is the
  same object. The active-server slot now names one owner at a time, adoption
  transfers that ownership along with the process teardown handlers, and only the
  owner may close.

  **A `stop()` concurrent with a `listen()` could orphan the newly bound socket.**
  A graceful `stop()` waits on in-flight requests; a `listen()` arriving in that
  window force-stopped the old server, bound a new one, and reused the teardown
  registration. The resuming `stop()` then cleared the instance's server handle
  and detached the handlers — leaving the new socket live with no way to reach it
  and no signal handling. `stop()` now returns without touching anything once it
  sees a `listen()` has superseded it.

  **A late cleanup could clear the process-wide slot out from under a live
  server.** `listen()`'s force-stop of the previous server cleared the slot
  unconditionally when it finished, even if another `listen()` had already pointed
  it at a server of its own. That slot is what the SIGINT/SIGTERM/exit teardown
  reads, so wiping it meant the surviving socket was never closed at shutdown. The
  clear is now conditional on the slot still holding the server that was stopped —
  and the Vite restart cleanup guards its slot, and the published env vars that
  travel with it, the same way.

  **Two `listen()` calls racing could strand what the loser started.** With
  nothing bound yet, both calls pass the entry force-stop, both bind, and the
  later assignment overwrote the instance handle — leaving the earlier socket live
  with nothing left holding it. A displaced server is now stopped instead of
  dropped, and a fresh Vite dev server displaced from the slot the same way is
  closed instead of stranded on its port.

  Also bounds the server `stop()` itself, mirroring the existing Vite close bound:
  a graceful stop that never finishes draining no longer holds shutdown open
  forever. The bound defaults to 5s and is configurable through
  `GUREN_BUN_STOP_TIMEOUT_MS`. A `stop` or `close` that throws synchronously is
  contained like one that rejects, instead of escaping the shutdown path.

- Updated dependencies [dd9a5df]
  - @guren/orm@2.3.0

## 2.4.0

### Minor Changes

- 0e072be: Expose the bound address on the application as `app.address`

  `Application.listen()` returns `{ port, hostname, url }`, but the instance kept
  only its private Bun server, so the address was available in exactly one place:
  whatever received `listen()`'s return value. Anything else that needs it — an
  OpenAPI `servers` entry, an absolute URL builder, a health report — had to have
  it threaded in from the entrypoint. The example API did this with a module-local
  variable and an exported setter re-exported through two files so that
  `bin/serve.ts` could push the address back down into the app that had just
  produced it. Every app mounting OpenAPI docs would have hand-rolled the same
  wiring.

  `app.address` now returns the same `ListenAddress` `listen()` returned, and
  `undefined` before `listen()`. It reads a value stored at bind time rather than
  re-deriving one from the live server, because `listen()` resolves the port
  through a fallback the socket no longer carries; the wildcard-host mapping
  (`0.0.0.0` → `127.0.0.1`, `::` → `::1`) stays in the single helper `listen()`
  already uses. `ListenAddress`'s fields are now `readonly`, since the object
  `listen()` hands back is the one every later reader sees.

  It reverts to `undefined` when the server is superseded or torn down through
  the framework — a later `listen()`, including one whose rebind fails, and the
  process-exit teardown. A server stopped by calling `stop()` on the Bun server
  directly leaves no signal behind, so the accessor keeps reporting its address:
  it answers "where did `listen()` put this app", not "is this app healthy".

  This does not replace passing a function to `@guren/openapi`'s `servers`
  option. Late resolution is what lets the document name an address the app did
  not have at mount time, and a function is the only form available when mounting
  against a plain Hono instance rather than an `Application`.

- cb46086: Return the bound address from `Application.listen()`, and move the busy-port walk into it

  `listen()` called `Bun.serve({ port })` and discarded `server.port`, returning
  `Promise<void>`. The framework knew the port it had bound and threw it away, so
  the only way to find out was to scrape the dev banner — ANSI-coloured prose
  written for humans. `listen()` now returns `{ port, hostname, url }`, read off
  the running server rather than echoed back from the request.

  That mattered because the port asked for and the port bound are routinely
  different numbers. The walk past a busy port lived in four copies of
  application code (`bin/serve.ts` in both starter templates, the blog example,
  and the docs site), each wrapping the framework call that should have owned it.
  Copies drift, and none of them could report where the app ended up. The walk now
  lives in `listen()` behind `portFallback`: `true` walks the next 20 ports,
  `false` fails fast. Left unset it walks outside production, which is what the
  loops it replaces did. Moving the walk inside also makes it dramatically
  cheaper — a retry used to re-enter `listen()` and restart the managed Vite dev
  server (~600ms per busy port); it is now a bare re-bind.

  A bind that gives up now shuts the managed Vite dev server down on its way out.
  `listen()` starts Vite before anything tries to bind, so an exhausted walk — or
  a strict-port failure, which is precisely the case automated callers _handle_
  rather than exit on — used to leave an asset server and its published
  environment variables running in a process with no application server.

  `GUREN_STRICT_PORT=1` forces fail-fast from outside the app. This is the case the
  walk actively harms: a smoke script, a Playwright `webServer`, or a CI job that
  pins a port needs to know the app answering is the one it started. Walking past a
  busy port makes that failure silent and inverted — the run goes green against
  somebody else's server. `bun run dev` keeps the convenience by default.

  `PORT=0` also works now. `Number.parseInt(process.env.PORT ?? '', 10) || 3333`
  turned 0 into 3333, so "let the OS pick a free port and tell me which" could not
  be expressed — and it is the natural way to run tests in parallel. The walk is
  skipped for port 0, which has nothing to recover from and would otherwise march
  into the privileged range.

  The starter templates keep their own loop for now: they resolve `@guren/*` from
  npm, so they cannot use a `listen()` option until the release that ships it.
  They do honour `GUREN_STRICT_PORT` and parse `PORT=0` correctly, which needs no
  new API.

### Patch Changes

- 730358f: Keep the dev server listening across `bun --hot` reloads by reusing the managed Vite dev server

  Editing a backend file in a scaffolded app — or running `guren add resource` /
  `guren add auth`, which edit several — killed the dev server silently. `bun
--hot` re-runs the entrypoint, and the new `listen()` stopped the previous Bun
  server first, then awaited the previous Vite dev server's `close()`. Vite
  waits for every open connection, and a browser tab holding its HMR socket can
  keep that wait alive indefinitely — so the process stayed up with no HTTP
  listener at all, no error printed, and every checkpoint URL dead until a
  manual restart.

  `listen()` now adopts the still-listening Vite dev server a previous run left
  on `globalThis` (which `bun --hot` preserves) instead of tearing it down. The
  browser keeps its HMR socket, the reload skips the `close()` wait entirely,
  and the Bun listener re-binds immediately. Explicit `vite` options still force
  a restart — the running server was built from the previous call's options.

  Two failure paths harden alongside: the previous Bun server is force-closed
  (a dev reload must not wait on in-flight requests — an open SSE stream used to
  be able to hang it the same way), and the paths that do close Vite abandon a
  `close()` that has not resolved within `GUREN_VITE_CLOSE_TIMEOUT_MS` (default 5000) with a loud warning instead of hanging the process.

- 10dddc8: Stop linking the raw dev stylesheet when a Vite dev server owns the entry

  In development the Inertia document linked `/resources/css/app.css` — the
  _source_ file, served raw by the app server. With Tailwind in it (every
  scaffolded app), the browser then requests the bare `@import 'tailwindcss'`
  specifier as a relative URL, 404s, and logs a MIME-type console error on every
  page load. The link contributed nothing: the compiled CSS already arrives
  through Vite's module graph via the `app.tsx` import.

  The document renderer now drops exactly that dev-default path when the script
  entry is served from a dev server (an absolute http(s) URL). A per-call
  `styles` option is an explicit choice and is never filtered; other
  env-configured hrefs are left alone; fallback mode (no Vite; the entry served
  same-origin) keeps the link — there the raw file is the only styling — and
  production manifest-derived links are untouched.

- 5970497: Fix the `FormRequest` JSDoc example that documented a no-op authorization gate

  `AuthContext.user()` is async, but `FormRequest`'s `protected user()` was
  declared `(): unknown` and returned its result unawaited. The class JSDoc built
  its `authorize()` example on that:

  ```ts
  authorize() {
    return this.user() !== null   // a pending promise — always true
  }
  ```

  An app that copied it authorized every request, including logged-out ones. The
  precondition is an attached auth context, which is the normal case:
  `Application` attaches a fallback one in its constructor even when the app
  configures no `options.auth`. The `unknown` return type kept `tsc` quiet.

  `user()` is now `protected async user<TUser>(): Promise<TUser | null>` and the
  example awaits it. `authorize()` already accepted `boolean | Promise<boolean>`
  and `handle()` already awaited it, so nothing else moves — for callers that
  await, runtime behavior is identical before and after.

  `handle()`'s JSDoc also claimed it was `@internal Called by
Controller.validate()`. That method does not exist and nothing in the framework
  calls `handle()`, so it now documents the real entry point:
  `await new StorePostRequest().handle(this.ctx)`.

  ### Note for subclasses that override `user()`

  The new signature is source-incompatible for a subclass that **overrides** the
  helper — `protected user(): unknown` no longer satisfies the base declaration.
  It is `protected` on a deprecated class, so this is not public API surface, and
  subclasses that only _call_ `user()` are unaffected.

  Migration: change an override to `protected async user<TUser = unknown>():
Promise<TUser | null>`. Separately, a subclass that copied the old
  `this.user() !== null` line keeps compiling and keeps returning true — a
  promise is still legally `!== null` — so rewrite it as
  `(await this.user()) !== null`.

- 8bc311d: Keep the query string in the default Inertia page url

  `Controller.inertia()` resolved the page `url` from `ctx.req.path`, which is
  the pathname only — so `usePage().url` never saw the current query
  parameters. Anything deriving state from the query (pagination, filters,
  sort order) silently lost it on every visit, and navigation components that
  propagate the active query onto their links emitted bare paths. The Inertia
  protocol expects `url` to include the query string (`"/posts?page=1"`).

  The default now lives in the `inertia()` engine itself: when `options.url`
  is absent, the page url is derived from `options.request` as the pathname
  plus the query string, kept relative as the protocol expects. This covers
  every caller that hands the engine a request — `Controller.inertia()` and
  direct `inertia()` calls alike — and an explicit `options.url` still
  overrides it. The `@guren/testing` controller mock mirrors the same
  default. On a version-mismatch 409, `X-Inertia-Location` now falls back to
  the absolute request URL when no `url` override is given, matching what the
  client does with that header.

  The `make:auth` scaffolds and the create-app templates no longer pass
  `url: this.request.path` — they rely on the default, so generated apps get
  the query-preserving value instead of re-introducing the lossy form.

- e38ac75: Harden the GCM tag length, the debug-page production gate, and SSE client ids

  Three defence-in-depth fixes from the framework security review. None closes a
  confirmed exploit on a shipped code path; each removes a way one could open.

  - **GCM authentication tags are pinned to 16 bytes.** `setAuthTag()` adopts
    whatever length it is handed, and a truncated tag was measurably accepted: a
    payload rewritten with the first 4 bytes of a real tag decrypted successfully,
    dropping forgery resistance from 2^128 to 2^32. Both `createCipheriv` and
    `createDecipheriv` now pass `authTagLength: 16`, and a short tag is rejected
    before any key is tried. Everything the `Encrypter` writes already used the
    full tag, so no existing payload is affected.

  - **`debugErrorMiddleware`'s production gate no longer uses an optional chain.**
    The page renders the stack trace, the request, and the process environment,
    and this read is its only guard. The deploy plugins settle it at bundle time
    with `--define 'process.env.NODE_ENV="production"'`, which substitutes one
    exact expression — the optional chain was not it, so on hosts where platform
    vars never reach the process environment the gate answered "not production".
    A source-level test pins the form, matching the MCP and docs-viewer gates.

  - **SSE client ids are unguessable, and a stream now records its owner.**
    `POST /broadcasting/auth` takes a `clientId` from the request body, so
    authorizing a channel attached it to whatever stream that id named. Ids were
    `Date.now()` plus a `Math.random()` suffix; they are now 16 random bytes from
    `randomHex`, which is the control that actually stops an attach against
    someone else's stream.

    The ownership check is defence in depth on top of that: the endpoint refuses
    to attach a channel to a stream whose recorded owner differs from the caller.
    Ownership is read from the conventional `id`/`sub`/`userId` field of whatever
    `getUser` returns, and a stream stays attachable when no owner could be
    resolved — both because a stream opened before sign-in has to stay attachable
    for authorize-after-login, and because the two cases are indistinguishable.
    An app whose user objects carry none of those fields gets the unguessable id
    and no second layer.

- e38ac75: Fix the health middleware returning an empty 204, and never-expiring Redis API tokens reading as expired

  Two independent bugs, both fail-safe (a broken read, not an exposure):

  - `HealthManager.middleware()` built its JSON response with `ctx.json(...)` but
    never returned or assigned it, so the router saw an unfinalized context and
    synthesized an empty `204` — the documented `router.get('/health',
health.middleware())` returned no report at all. It now finalizes the context
    by assigning `ctx.res`, preserving the `200`/`503` status.

  - `RedisApiTokenStore` serializes a never-expiring token's `expiresAt` as `''`
    (a Redis hash has no null). On read, `toOptionalExpiry('')` degraded the empty
    string to the epoch rather than treating it as absent, so every non-expiring
    token in Redis was rejected as expired. The empty string now maps to "no
    expiry"; a genuinely unparseable value still degrades to expired.

- dbbc0a2: Deliver Inertia validation errors on apps without a session

  Sessions only mount when `createApp({ auth })` is configured, and the Inertia
  validation renderer flashed errors to the session guarded by `if (session)` —
  so on a fresh scaffold (no auth yet) every validation failure redirected back
  with the errors silently dropped. The form appeared to do nothing: no
  navigation, no messages, nothing in `form.errors`. The tutorial's Part 1
  checkpoint ("Title is required." appears) was impossible to pass before Part 2
  installed authentication.

  Without a session, the flattened errors now ride across the one redirect in a
  short-lived HttpOnly cookie (display-only data, no store required, works on
  every runtime), and the shared-props resolver reads them from there into the
  same `errors` prop. Reading consumes the flash: a cleanup middleware expires
  the cookie on the render that consumed it — and only then, so intermediate
  hops (a trailing-slash redirect, an auth bounce) don't burn the errors before
  a page shows them, matching session-flash semantics. Fields too large for the
  ~4KB cookie cap are skipped individually so the rest still arrive. Apps with
  a session keep the existing flash path unchanged.

- Updated dependencies [e38ac75]
- Updated dependencies [5e38d18]
  - @guren/orm@2.2.2

## 2.3.0

### Minor Changes

- e87d053: Add `TestApp.fromApp(app)` and make `Application.boot()` idempotent

  Testing against the real application required
  `await app.boot(); TestApp.fromFetch((request) => app.fetch(request))` — and
  the arrow wrapper is load-bearing, because an unbound `app.fetch` reference
  throws (`Application.fetch` reads instance state). `TestApp.fromApp(app)`
  boots the app and binds fetch, removing both the boilerplate and the footgun.

  `Application.boot()` now reuses its first call, so booting twice is a no-op
  rather than mounting security middleware and routes a second time. This also
  covers two callers booting concurrently, which the previous code could not:
  each saw an unbooted app and mounted everything again. A boot that throws is
  not remembered, so a later call attempts boot again — it resumes on a
  partially mounted app rather than starting clean, which is how the Cloudflare
  Workers handler has always treated it.

  This is a behavior change to a public method: a second `boot()` used to
  duplicate the middleware chain and now does nothing.

### Patch Changes

- 72bd945: Degrade a corrupt ability list to no abilities instead of every ability

  `DatabaseApiTokenStore` decoded `abilities` with
  `decodeJsonColumn<string[]>(value, [])`, which returns whatever the JSON
  decodes to. A stored `'"*"'` decodes to the _string_ `"*"`, and `tokenCan` then
  runs `String.prototype.includes` on it, so `"*".includes("*")` is true and the
  token is granted every ability — the exact opposite of the deny-by-default the
  file's own comment claimed. `RedisApiTokenStore` had the same collapse, and its
  `JSON.parse` was unguarded besides, so one corrupt record threw on every
  verification of that token rather than degrading.

  Both stores now require an array and keep only its string members. A value that
  is not a list of strings yields no abilities.

- 72bd945: Anchor the asset path containment checks on a separator

  The dev transpiler route, the Inertia client route, and the production Inertia
  client handler resolved a request path and then checked containment with a bare
  `startsWith(dir)`. A sibling directory whose name extends the base passes that —
  `resources/js` against `resources/jsonfixtures`. All three now use
  `startsWith(dir + sep)`, matching the check `public-assets.ts` already carried
  for the same reason.

  The check is reachable because the request remainder is taken with
  `ctx.req.path.slice(base.length)`, so a doubled slash (`/vendor//var/...`) leaves
  an absolute remainder that `resolve()` returns verbatim; `../` and `%2e%2e` are
  normalized away by URL parsing before the handler runs. No default-scaffolded app
  has a sibling directory that would escape, so this closes the check rather than a
  live hole.

- eebd978: Make asset path containment survive symlinks

  `resolve()` collapses `..` but does not follow symlinks, while every reader
  downstream of these checks does — `Bun.file().text()`, `.arrayBuffer()`, and
  `new Response(file)`. So a request for `resources/js/link/secret.txt`, where
  `link` points out of the tree, resolved to a path lexically under the root,
  passed the containment check, and was served from wherever the link led. The
  dev transpiler route, both Inertia client routes, and the root public asset
  middleware were all affected.

  Containment is now judged on canonicalized paths, once the target is known to
  exist — the point at which it can be canonicalized, and, for the dev
  transpiler, the point at which extension probing has settled which file is
  actually read. Both sides are canonicalized, not just the candidate: a root
  reached through a symlink is routine (workspace and pnpm layouts, containers,
  macOS `/var`), and canonicalizing only the candidate would reject every asset
  such an app serves.

  The four call sites now share `isPathWithin` / `isRealPathWithin`, so this
  decision lives in one place instead of four copies of a `startsWith`.

  The configured entry points are deliberately exempt: they come from
  configuration rather than from the request, and a package layout may
  legitimately have the resolved module symlinked out of its own directory.

  Closing this needs local write access inside the project, so it is defense in
  depth rather than a live hole. It is a behavior change all the same: an asset
  deliberately symlinked out of `public/` is no longer served through the
  root-level public asset route. Copy the file into the tree instead.

  The scope is the framework's own handlers. `/public/*` and `/resources/css/*`
  are delegated to Hono's `serveStatic`, whose path handling leaves no lexical
  escape but which follows symlinks out of its root by design, as nginx and
  `express.static` do. So the same linked file that the root-level public asset
  route now refuses still serves under `/public/*`. Guren does not enforce
  symlink containment on the delegated routes; a deployment that must not follow
  symlinks out of `public/` should not rely on `/public/*` for that.

  Hono's `onFound` hook cannot close this — it runs after the content has been
  read and cannot reject — so guarding the delegated routes would mean either
  mirroring Hono's own path resolution in a second place or reimplementing static
  serving. Both were judged worse than the gap, and the gap is left explicit
  rather than papered over.

- 72bd945: Write the dev-endpoint gates in the form the deploy bundlers substitute

  `isMcpEndpointEnabled()` and `isDocsViewerEnabled()` read
  `process.env?.NODE_ENV` and `process.env?.GUREN_*`. The deploy plugins settle
  these branches at build time with `--define 'process.env.NODE_ENV="production"'`,
  which targets `process.env.NODE_ENV` — the optional-chained form is a different
  expression and was never substituted. `@guren/plugin-cloudflare`'s own comment
  records why that matters: wrangler `vars` are not guaranteed to reach
  `process.env` before the app's module graph evaluates, so a module-scope
  `NODE_ENV` branch has to be settled by the bundler.

  Both gates now use the plain form behind the existing `typeof process` guard,
  with a comment recording why `?.` must not come back. Deployed apps were already
  closed for other reasons — each plugin also sets `NODE_ENV=production` at
  runtime, and nothing sets `GUREN_MCP`/`GUREN_DOCS` — but the mechanism the
  plugins rely on now actually applies.

- 72bd945: Treat an unparseable expiry as expired, at the point the decision is made

  `new Date(garbage)` is an Invalid Date, and every comparison against one is
  false. So `new Date() > token.expiresAt` and `payload.expiresAt.getTime() <= now`
  both read a corrupt expiry as _not past_, and the record never expired.

  The authoritative checks are `verifyApiToken` and the OAuth state store's expiry
  tests, not any one store's deserialization — a token reaches `verifyApiToken`
  from `MemoryApiTokenStore`, from the database and Redis stores, and from
  application-supplied stores the framework never sees. `createApiToken` could also
  mint an Invalid Date on its own from a non-finite `expiresIn`, with no store
  involved at all. Both now go through a shared predicate in
  `@guren/server/support/expiry`, so the rule holds for every implementation
  including ones written by users.

  Store-level coercion is kept as defense in depth and is now consistent. `toDate`
  promised in its docstring that unparseable values return `null` but passed
  `Date` instances wrapping garbage straight through, which is why `isExpired`
  carried a second NaN check of its own; it now normalizes through one path and
  handles the `bigint` a BIGINT column returns. `toOptionalExpiry` keeps absent
  (`null`, "never expires") and present-but-unparseable distinct, degrading the
  latter to a long-past date rather than to `null`. `RedisApiTokenStore`,
  `RedisOAuthStateStore`, `RedisPasswordResetStore` and
  `RedisEmailVerificationStore` all read their expiry through the same helper —
  the last two still had the original unguarded `new Date(parsed.expiresAt)`.

- f43684c: Serve the built Inertia client in production, not its TypeScript sources

  `configureInertiaAssets()` located the vendored client by resolving
  `@guren/inertia-client/app` and taking `dirname()` of whatever came back. That
  subpath is not a stable anchor: a tsconfig `paths` entry mapping
  `@guren/inertia-client/*` at the package's `src/` — which Bun applies to
  runtime resolution, `import.meta.resolve` and `require.resolve` alike —
  redirects it to `src/app.tsx`. The production route then looked for
  `src/app.js`, which does not exist, and 404'd; every `chunk-*.js` the entry
  imports resolved against `src/` too, so the fallback of "the entry at least
  loads" was not available either.

  Resolution is now anchored on `@guren/inertia-client/package.json` — a subpath
  no `paths` entry shadows, since a mapping at `src/` misses and falls back to
  real package resolution — and the client directory is that package root's
  `dist/`. The path is derived from the package rather than from whichever file a
  specifier happened to reach.

  This bites wherever such a `paths` mapping is in scope, which is this
  repository: the reference app, the smokes, and the E2E runs all serve
  production assets through it. An app that installs `@guren/*` from npm has no
  `@guren/*` mapping, so its resolution already landed on `dist/app.js` and its
  behavior is unchanged.

  The resolution is now `resolveInertiaClientDir()`, exported so it can be
  asserted directly. Its previous form lived inline in `configureInertiaAssets()`,
  where no test could observe which directory it had chosen.

- 72bd945: Refuse requests the loopback guard cannot place, instead of allowing them

  `createLoopbackGuard` protects `/_guren/mcp` and `/_guren/docs`, and it has to
  stop two classes of caller: browser pages, rejected unless the `Origin` is
  loopback, and non-browser clients, rejected unless the socket peer is. Both
  checks were skip-on-absence — `clientAddress()` returned `undefined` when the
  runtime exposes no `server.requestIP`, and each check only refused when its
  signal was present. A client that sends no `Origin` (curl, any MCP client) on a
  runtime that reports no peer therefore passed both. That degradation is real on
  every non-Bun host and on `@guren/plugin-vercel`, which calls `app.fetch(request)`
  with no environment even though Bun is present.

  The peer check is now positive: a loopback peer allows, a peer that is present
  and not loopback is refused as a remote request, and a peer the runtime never
  reported is refused as one the guard cannot vouch for. The two denials say
  different things on purpose. `bun run dev` is unaffected — `Application.listen()`
  passes `{ server }` into `Bun.serve`, so the peer resolves on every request.

  For a host that genuinely cannot report a peer, `GUREN_ALLOW_UNVERIFIED_PEER=1`
  opts out, and the refusal names it.

  A loopback `Origin` deliberately does not satisfy the peer check. `Origin` is a
  negative filter — it attests that a _browser_ saw a cross-site request — and any
  non-browser client sets it with one flag, so accepting it as proof of locality
  would leave the hole open to `curl -H 'Origin: http://localhost'`.

  What the guard checks is the connection, not the caller: a reverse proxy,
  container port publish, or tunnel that terminates locally presents a loopback
  peer, so traffic behind it is accepted. The guides now say so, and say not to put
  a tunnel in front of a dev server running with `GUREN_MCP=1`.

- e22b10f: Report why the MCP codegen tool skipped an artifact

  `guren_codegen` filed every empty generator result under `"nothing to generate"`.
  That is right for an app with no page components, and wrong for the one case where
  a generator declines on purpose: the pages manifest is not written into an app that
  cannot compile one. An agent that just wrote a page component and asked for codegen
  was told there was nothing to describe. Generators can now carry a sentence with the
  empty result, and the tool reports it in place of the generic reason.

- 72bd945: Apply the security defaults to every response, including raw ones

  Two independent gaps meant the framework's own asset responses carried neither
  host authorization nor a single security header.

  `Application.boot()` mounted the security defaults, but the scaffolded templates
  call `autoConfigureInertiaAssets(app, …)` at module scope in `src/main.ts` —
  before `bootstrap()` awaits `boot()`. Hono composes matched handlers in
  registration order, so those asset routes ran ahead of the `use('*')` middleware
  and answered without ever entering it. With the template's development host
  authorization (`allowedHosts: ['localhost:*', '127.0.0.1:*']`) and `bin/serve.ts`
  binding `0.0.0.0`, `GET /` from a LAN peer was refused with 403 while
  `GET /resources/js/pages/Home.tsx` returned 200. The same ordering applied in
  production to `/public/*` and the root asset catch-all.

  `mountSecurityDefaults()` now runs in the `Application` constructor, which is the
  one position an application cannot register in front of. A double `boot()` no
  longer double-mounts the middleware either.

  Separately, `createSecurityHeaders`, `createForceHttpsMiddleware` and
  `createCspMiddleware` wrote their headers with `ctx.header(...)` before
  `await next()`. Hono keeps those in prepared headers and merges them only when
  the handler answers through the context; a handler returning a raw
  `new Response(...)` replaces `ctx.res` outright and drops them — which is every
  asset response the framework serves, and any application controller that returns
  a `Response` directly. All three now apply their headers after the response
  exists, through a shared `applyResponseHeaders`, which sets a header only when
  the response does not already carry it. Precedence is unchanged: a handler's own
  value, or an inner middleware's stronger `Strict-Transport-Security`, still wins.

- b210a53: Collapse the duplicated store expiry rules into a single implementation

  `toDate`, `isExpired` and `toOptionalExpiry` existed twice: once in
  `packages/server/src/support/expiry.ts` for the Redis-backed stores and the
  authoritative `verifyApiToken` / OAuth checks, and once in
  `packages/core/src/store-utils.ts` for the database-backed stores. The copies
  were identical and deliberate — `@guren/core` depends on `@guren/server` and
  not the other way around, so core was unreachable from the server package —
  but two copies of an expiry rule is how the next boundary-case fix lands in
  one backend and silently misses its sibling. That is the failure mode the
  Redis and database stores have already hit once.

  `@guren/server` now exposes the rules on a `@guren/server/support/expiry`
  subpath and `packages/core/src/store-utils.ts` re-exports them, leaving one
  implementation for both backends. The dependency direction already ran
  core → server, so this adds no cycle.

  No behavior change and no public API change: the two implementations were
  byte-identical, and neither package's index exports these — `@guren/core`'s
  index opens with `export * from '@guren/server'`, so a test now pins that they
  stay off the public surface. `decodeJsonColumn` stays in core as a drizzle
  column concern; the Redis stores decode their payloads through
  `redis-values.ts`.

- Updated dependencies [de3298b]
- Updated dependencies [19f7119]
  - @guren/orm@2.2.1

## 2.2.0

### Minor Changes

- ee5a918: Wire i18n into the application: `createApp({ i18n })`, controller translation helpers, and Inertia `_i18n` shared props

  The i18n subsystem (I18nManager, Translator, pluralization, loaders) existed
  but had no path from an app's configuration into a request. `createApp` now
  accepts an `i18n` option:

  ```ts
  createApp({
    i18n: {
      supported: ["en", "ja"], // first entry is the default fallback
      path: "lang", // lang/<locale>/*.json via JsonLoader (default)
      // loader: new MemoryLoader(...)  // e.g. bundled messages on serverless
    },
  });
  ```

  When set, `I18nServiceProvider` builds the `i18n` container binding from the
  options, preloads every supported locale during `boot()`, and mounts
  `detectLocaleMiddleware` (query → cookie → `Accept-Language`, opt out with
  `detect: false`). Apps that register their own `I18nServiceProvider` subclass
  keep ownership of the wiring.

  Controllers gain request-locale sugar: `this.t(key, replacements?)`,
  `this.tc(key, count, replacements?)`, and `this.locale`. They use the
  request-scoped translator bound by the locale middleware when present, and
  fall back to a translator scoped to the resolved locale from the container's
  `i18n` binding (then the `setI18n()` global) — the same resolution order the
  Inertia `<html lang>` default already used.

  Inertia responses share the resolved locale and its messages as the `_i18n`
  prop (`{ locale, fallbackLocale, messages }`, active locale plus fallback
  only; disable with `share: false`), laying the groundwork for a client-side
  `useTranslation()` hook.

- 89adb3f: Typed translation keys and translation catalog checks

  `guren codegen` now emits `.guren/translations.gen.ts` for apps with a
  `lang/` directory: a `TranslationKey` union built from every
  `lang/<locale>/*.json` catalog (namespace = file name, nested keys
  flattened to dot notation), plus declaration-merging augmentations that
  register it with the server and client. `this.t()` / `this.tc()` in
  controllers and `useTranslation()` in pages then autocomplete keys and
  reject unknown ones at compile time. Apps without `lang/` (or without the
  generated file) keep plain `string` keys — the new `GurenTranslationKeys`
  registry defaults to empty. The Vite route-types plugin watches `lang/`
  and regenerates on change.

  `guren check` gains translation catalog checks, content-activated like
  `--docs`: unparseable catalog JSON (fail — the loader silently skips such
  files), keys missing from individual locales (fail — they render in the
  fallback language), and interpolation placeholders that differ between
  locales for the same key (warn). `guren check --i18n` runs them alone and
  exits non-zero on failures.

- 80ef7b1: Let the OAuth manager keep the browser binding in the session itself

  Binding a flow via `bindTo` worked but pushed four steps into every
  controller: mint a random value, store it in the session, read it back in the
  callback, forget it — guarded on the session existing, twice. Every scaffold
  and example carried the same twelve lines.

  `authorize()` and `handleCallback()` now also accept a `session`. Hand them
  `this.auth.session()` and the manager mints the per-flow binding, parks it in
  the session under `OAUTH_SESSION_BINDING_KEY`, and consumes it during callback
  verification — reading and removing it in one step, so a replayed callback
  finds nothing. A missing session (no session middleware) flows through as an
  unbound state exactly as before, warning included. The parameter is typed as
  `OAuthBindingSession` — the three session methods the manager needs — so the
  framework session satisfies it structurally and tests can pass a plain stub.

  `bindTo` remains for bindings kept elsewhere (an encrypted cookie, secure
  storage) and takes precedence when both are given. `make:auth`, the `oauth`
  blueprint, the docs, and the blog example now pass `session` instead of
  hand-rolling the plumbing.

### Patch Changes

- 80ef7b1: Carry the policy's own denial through the authorization middleware

  `authorizeMiddleware` and `authorizeResourceMiddleware` called `allows()`,
  discarded the response, and threw a generic 403 — so a policy answering with
  `denyAsNotFound()` produced a 404 through `Controller.authorize()` and a 403
  through the middleware. Both now go through the same response, keeping the
  policy's message and status; `options.message` still overrides. Multi-ability
  (`any`) checks have no single response to carry and stay generic.

  Gate and policy `before` hooks are normalized too: previously anything that was
  not a boolean was read as "keep checking", so a `Response.deny()` returned from
  `before` was dropped and a permissive ability method then allowed the action.
  Only `undefined` continues. `GateCallback`, `GateBeforeCallback`, `Policy.before`
  and `definePolicy`'s `before` accept `PolicyResult` to match.

- 80ef7b1: Make the generated private-channel check the check that actually runs

  `make:channel --private` generated a `PrivateChannel` subclass with an
  `authorize(ctx)` method, and `make:channel --presence` a `join(ctx)`. Neither
  ever ran. `BroadcastManager.authorize()` resolves a channel only through the
  callbacks registered with `channel()` / `privateChannel()` / `presenceChannel()`
  and never calls a method on a channel instance, so both were dead code — with no
  TODO or comment to say so. The presence one could not have worked in any case:
  its signature contradicted the inherited `join(member)`, which is what adds an
  already-authorized member.

  Meanwhile the `broadcasting` blueprint registered the callback that _did_ run:

  ```ts
  broadcast.privateChannel(userFeed.getBaseName(), () => true);
  ```

  Allow-all, on `users.{id}.feed`, next to a generated file that reads as though it
  authorizes. That registration also defeats the manager's own fail-closed default,
  which denies unregistered `private-`/`presence-` names.

  The generated methods now take the `ChannelAuthorizer` signature
  (`channelName, user`) so they can be registered, the presence hook is
  `authorizeJoin()` to stop colliding with `join(member)`, and a pattern carrying
  `{id}` gets an ownership check rather than a bare "is logged in". The blueprint
  registers the channel's own method.

  `BroadcastManager.authorize()` also normalizes its result. Callers read anything
  that is not `false`/`null` as authorized, so an authorizer with an
  implicit-`undefined` return path used to grant access; it now denies.

- 05f6353: Fix CSRF verification accepting a guest token on a request that carries a session

  `verifyCsrfToken` picked its validation mode from the submitted token alone: a
  token without a `sid` claim took the stateless double-submit path, which only
  compares the token against the `XSRF-TOKEN` cookie. Because that check ran even
  when the request carried a session, a guest-mode token — which anyone can mint
  by visiting the site — could authorize a state-changing request for a logged-in
  user, provided the attacker also controlled the `XSRF-TOKEN` cookie. That cookie
  carries no `Domain` restriction and no `__Host-` prefix, so any sibling
  subdomain of the same site can set it, and a same-site request still sends the
  `SameSite=Lax` session cookie. The token-minting path already enforced this rule;
  only verification was missing it.

  Verification now fixes the mode from the request — whether it carries a bindable
  session — and requires the token to be in that mode.

  Issuing had to move with it. A session created during the current request stays
  `isNew` for its whole lifetime, so the response that logs a user in was minting a
  guest token for a session that later requests authenticate with; under the new
  rule that token would be rejected on the next mutation. Three changes keep
  issuing in step:

  - `Session` gains an optional `willPersist()` reporting whether the session
    survives the response under its current id. `bindableSessionId` asks that
    instead of `!isNew`.
  - `getCsrfToken()` now tracks the session as it stands at the moment of the
    call, re-issuing when a handler changes it. Previously the first call in a
    request fixed the answer, so a handler that logged a user in and then
    rendered the token put a guest token in the response body while the cookie
    carried a session-bound one — and submitting that form was rejected.
  - Excluded paths (and the dev MCP endpoint) skip verification but no longer
    skip issuance, so an exempt endpoint that establishes a session — an OAuth
    callback — still hands back a bound token.

  `createCsrfMiddleware` settles the response cookie after the handler returns, so
  it must be mounted directly inside the session middleware. Middleware layered
  between the two that rotates or invalidates the session after its own
  `await next()` moves the id after CSRF has committed to a token. The automatic
  registration in `AuthServiceProvider` already mounts them adjacently; the
  requirement is now documented for hand-composed chains.

- 80ef7b1: Fix a policy denial being read as an approval

  `Policy` ships `deny()`, `denyWithStatus()` and `denyAsNotFound()`, which return
  an `AuthorizationResponse` object rather than `false`. `Gate.check()` returned
  the policy method's value unchanged, so every consumer truthy-tested that object
  and read the denial as an approval: `authorize()` did not throw, `allows()` and
  `Controller.can()` returned truthy, `denies()` returned `false`, `inspect()`
  reported `allowed: true`, and `authorizeMiddleware`'s `if (!authorized)` guard
  passed. A policy written as

  ```typescript
  update(user: AuthUser | null, post: Post) {
    return user?.id === post.authorId ? true : this.deny('You do not own this post.')
  }
  ```

  therefore let any user through the exact check meant to stop them. Nothing
  flagged it: the helpers are `protected`, so a policy ability method is their only
  possible call site, and `PolicyMethod` was exported but never applied to policy
  classes, so the method's return type was inferred from its body with nothing to
  check it against.

  `Gate` now normalizes every policy and gate return value through one path. An
  `AuthorizationResponse` is honoured as written, `true` allows, and anything else
  denies — unknown shapes fail closed rather than open. A new `checkResponse()`
  keeps the full response so `inspect()` reports the policy's own message, and
  `authorize()` propagates `denyWithStatus()` / `denyAsNotFound()` into the thrown
  exception's status instead of flattening every denial to 403.

  `PolicyMethod` and `definePolicy()` now accept `PolicyResult`
  (`boolean | AuthorizationResponse`), so the type matches what `Policy` has always
  offered. `PolicyResult` and the `isAuthorizationResponse()` guard are exported.

- ee5a918: Make translation interpolation literal-safe

  `Translator.applyReplacements` built its `:key`/`{key}` patterns from the
  raw replacement key and passed the value straight to `String#replace`, so a
  key containing regex metacharacters could throw or match the wrong text,
  and a value containing `$` sequences (e.g. user input with `$&`) was
  expanded instead of inserted literally. Keys are now regex-escaped and
  values replaced via a callback, keeping both fully literal.

- 80ef7b1: Key the OAuth session binding by state, not by one shared slot

  `authorize({ session })` parked its binding under a single session key and
  `handleCallback({ session })` deleted that key regardless of which state the
  callback carried. Two consequences, both measured:

  - A browser could only have one flow in flight. Open two tabs, or start over
    with a different provider, and the second `authorize()` overwrote the first's
    binding — so at least one login failed. Completing the older flow first failed
    _both_, because it consumed the newer flow's binding on its way out.
  - A callback carrying a state the browser never started still stripped the
    binding. Anyone could navigate a visitor to `/callback?code=x&state=x`
    mid-login and lock them out of the login they had actually begun.

  Bindings are now filed under the hash of the state they belong to, and a
  callback takes only its own. Concurrent flows are independent, and a forged
  callback finds nothing to remove. The list is capped at five pending flows per
  browser and prunes expired entries as it goes.

  `OAUTH_SESSION_BINDING_KEY` and `OAuthBindingSession` are also exported from
  `@guren/server` and `@guren/core`, which the previous change documented as
  public API but left reachable only through the deep module path.

- 80ef7b1: Let OAuth `state` be bound to the browser that started the flow

  `createOAuthState` stored `{ provider, redirectTo, expiresAt }` and
  `verifyOAuthState` checked only that the provider matched. Nothing tied the
  state to a browser, and the manager is a process-wide singleton, so a state
  minted for one browser was consumable by any other. `state` was unguessable and
  single-use, but _transferable_ — which is the one property it exists to prevent
  (RFC 6749 §10.12).

  That is login CSRF. An attacker requests `/auth/github` on the target app and
  captures the `state` from the redirect, separately authorizes the app against
  their own provider account and captures the `code` without letting their browser
  reach the callback, then induces a visitor into a top-level navigation to
  `/auth/github/callback?code=…&state=…`. The state verifies, the code exchanges
  for the attacker's profile, and the visitor's session is logged into the
  attacker's account. The visitor keeps using the app believing it is theirs, so
  whatever they write next — posts, uploads, a connected payment method — lands in
  an account the attacker can read. It could not be fixed from application code:
  `handleCallback()` verified state internally and accepted no session-bound value.

  `authorize()` now takes `bindTo` and `handleCallback()` takes it back. Only a
  hash of the value reaches the state store, and comparison is timing-safe. Pass a
  value only that browser can present — a session id, or a random value stored in
  the session, which also makes a logged-out visitor's session persist across the
  round trip.

  A state created without a binding still verifies, so apps written against the
  earlier API keep working; `authorize()` warns once per process when called
  without `bindTo`, and those apps stay exposed until they adopt it. `make:auth`,
  the `oauth` blueprint, the docs, and the blog example all pass it now.

- 80ef7b1: Persist the OAuth state binding in the shared state stores

  `createOAuthState` recorded the browser binding in the payload, but
  `DatabaseOAuthStateStore` and `RedisOAuthStateStore` neither wrote nor restored
  it. Every bound state came back unbound, and `verifyOAuthState` then accepted
  any browser — so `authorize({ bindTo })` was inert on both shared stores,
  including the database store the docs recommend for production. Only the
  in-process memory store, which the docs tell you not to deploy, carried it.

  Both stores now round-trip `binding`. The database store needs a nullable
  `binding` column on the `oauth_states` table; without it the state cannot be
  persisted at all.

  `bindingMatches` also moves to `secureCompare`, the hex-decoding comparator, to
  match the other stored-hash comparison in the package.

- 80ef7b1: Stop binding the managed Vite dev server to every interface

  `Application.listen()` starts a Vite dev server on every non-production boot,
  and both the launcher and `gurenVitePlugin` replaced Vite's localhost-only
  default with `host: true`. Vite serves any file under its root — transformed
  source for `.ts`/`.tsx`, raw bytes for everything else — with no
  authentication, no origin check and no loopback gate. Anyone on the same
  network could read a developer's application source, and the scaffold's default
  `DATABASE_URL=./data/guren.db` puts the SQLite database inside that root and
  outside Vite's `server.fs.deny`, so `GET http://<dev-machine>:5173/data/guren.db`
  returned the users table — password hashes included — to any LAN peer.

  The framework already treats LAN reachability as in scope: `/_guren/mcp` and
  `/_guren/docs` are gated on a loopback socket peer precisely because templates
  bind `0.0.0.0`. The dev server it starts itself had no equivalent gate.

  `host` is now left unset, so Vite's own default applies and the project's
  `vite.config.ts` decides. Exposing the dev server on the network is an explicit
  opt-in — `--host`, `server.host` in `vite.config.ts`, or
  `app.listen({ vite: { host: true } })`.

  `preview.host` is unchanged: `vite preview` serves only `build.outDir`, never
  the project root, so it carries none of this.

  `resolveViteDevServerConfig()` is exported for callers that need the inline
  config the managed dev server would start with.

- Updated dependencies [80ef7b1]
- Updated dependencies [80ef7b1]
- Updated dependencies [80ef7b1]
  - @guren/orm@2.2.0

## 2.1.1

### Patch Changes

- 87bbd81: Reject path-traversal names in the `make:*` scaffolders

  `make:test` and `make:view` accept a nested name (`make:view posts/Index`,
  `make:test auth/Login`) and interpolated its segments straight into the output
  path. `trimSlashes()` only strips the edges and `split('/').filter(Boolean)`
  keeps `..` — it is non-empty — so a name like `../../../../tmp/evil` wrote
  outside the project, and `--force` overwrote whatever was already there. The
  name is not always something you typed: the MCP tool `guren_make_component`
  declares it as an unvalidated request field, so an agent working from untrusted
  content could reach it.

  Nested names are now split with traversal rejected rather than stripped, and
  every `make:*` scaffolder writes through a writer that asserts the resolved path
  stays under the project root. `scaffoldFile()` (behind `make:controller`,
  `make:model`, `make:route`, …) and the batch writer behind `make:feature`,
  `make:auth`, and `make:module` had no containment check at all before this and
  were safe only because `pascalCase()` happens to strip separators — the same
  incidental safety `make:route` did not have.

  Only traversal is rejected, so names the filesystem accepts still work:
  `guren make:test "admin/my page"` and `guren make:view "顧客/Index"` behave
  exactly as before. Codegen (`guren codegen --out`) is deliberately exempt, since
  its output directory is yours to choose and may sit outside the project.

  `secureCompare()` from `@guren/server/auth` is hardened in the same release.
  `Buffer.from(value, 'hex')` stops decoding at the first invalid pair, so two
  different strings that share an invalid prefix — `'zzzz'` and `'yyyy'`, or
  `'abcz'` and `'abdz'` — decoded to identical buffers and compared **equal**. It
  now rejects input whose hex decode does not round-trip to the original length.
  If you called it with UUIDs, base64 tokens, or anything else that is not strict
  hex, switch to `secureStringCompare()`, which is built for exactly that.

## 2.1.0

### Minor Changes

- ee6f1bd: Accept middleware handler functions in `Router.middleware()` and
  `RouteBuilder.middleware()`, alongside the registered alias names they already
  took. Four guides across both doc languages — rate limiting, middleware, API
  tokens, email verification — documented `router.post(path, action).middleware(
createRateLimitMiddleware())` and `router.middleware(handler).group(...)`, and
  every one of those snippets failed to compile with `Argument of type
'MiddlewareHandler' is not assignable to parameter of type 'never'`.

  Both call sites now take alias names, handlers, or a mix. They resolve by kind
  rather than by position: every name in a route's chain runs before every
  handler, across groups as well as within one call — so an inline handler on an
  outer group runs after a named one on an inner group. Use aliases throughout
  when relative order matters. Aliases are also the only form `guren audit` can
  report by name; the guards it recognizes (`requireAuthenticated`,
  `requireGuest`) are detected either way.

  `Router.group()` and `middleware(...).group()` now throw when handed an `async`
  callback, and `Router.group()` unwinds its prefix if the callback throws. Group
  scopes are popped synchronously, so a callback that awaited before registering
  its routes silently lost the prefix or middleware the group was opened with —
  including auth guards. This was already the behavior for alias names; the fix
  covers both.

  `requireVerifiedEmail`'s `getUser` option typed its argument as `unknown`, so a
  callback could not read the context at all. It now receives `{ get<T>(key) }` —
  Hono's context idiom — with the type argument inferred from the expected
  return, so the documented `getUser: async (ctx) => ctx.get('user')` compiles
  without a cast. Callbacks written against the old `unknown` signature remain
  assignable.

### Patch Changes

- 6feada3: Build emailed auth links from `APP_URL` instead of the request host

  The password reset flow scaffolded by `guren add auth` (and by
  `create-guren-app --auth`) built its link from the request:

  ```js
  buildPasswordResetUrl(
    `${new URL(this.request.url).origin}/reset-password`,
    token,
    email
  );
  ```

  A server request's URL is reconstructed from the `Host` header, which any
  client can forge — the framework's own host-authorization middleware says so,
  reading `ctx.req.header('host') ?? new URL(ctx.req.url).host` as one value. So
  an unauthenticated attacker could `POST /forgot-password` with someone else's
  address in the body and `Host: attacker.tld`, and the app would mail _that
  person_ a genuine, single-use reset link pointing at the attacker's server. The
  victim sees a legitimate mail from the real service; one click — or one
  link-prefetching mail scanner — hands over the token, and `ResetPasswordController`
  accepts it with no session binding or second factor.

  Scaffolds now route every emailed link through a generated `app/Auth/AppUrl.ts`,
  which reads `APP_URL` and **fails closed in production** rather than falling back
  to the request. Development keeps working with no configuration. The three email
  verification sites got the same treatment: they mail the requester's own address,
  so they were not exploitable, but they were the same pattern.

  Templates also stop disabling host authorization in production. It was
  `process.env.NODE_ENV === 'production' ? false : { ... }`, which removed the
  middleware in exactly the environment that needed it; the production branch now
  derives its allowlist from `APP_URL`'s hostname, and health-check paths stay
  excluded so load balancers reaching the app by IP are unaffected. When `APP_URL`
  is not readable at module scope the template warns and leaves the check off
  rather than throwing — the Cloudflare worker imports the app before wrangler
  `vars` reach `process.env`, and a throw there would stop the app booting at all.
  `guren audit` now also flags `hostAuthorization: false`, which it previously
  walked past while the templates themselves shipped it.

  In `@guren/server`, a `host:*` allowlist entry now means "this host on any
  **port**". `compileHostMatcher` accepted anything after the colon, so
  `example.com:*` also matched a `Host` of `example.com:attacker.tld`. The same
  middleware stops re-parsing the whole request URL to read its path on every
  request, which it now does in production rather than only in development.

  **Action required for new apps:** `APP_URL` must be set in production. It is
  already present in the scaffolded `.env.example`. Existing apps are unchanged —
  if yours has a `ForgotPasswordController` generated before this release, apply
  the same change by hand, or re-run `guren add auth --force`.

- b27a6cd: Accept controller actions alongside route contract options inside `router.middleware(...)` chains

  `router.middleware('auth').post('/posts', { name: 'posts.store', body: Schema }, [PostController, 'store'])`
  raised TS2769 even though it worked at runtime: the middleware-scoped builder carried only
  two overloads per HTTP verb, missing the contract-options + `[Controller, 'method']` variant
  the router itself has. All five verbs now expose it, so the direct chain no longer needs a
  `.group()` wrapper to compile.

  Route docs and the `make:feature` next-steps hint now capture the `aliasMiddleware()` return
  value, which later `.middleware()` calls require — a bare call registers the handler at runtime
  but leaves the alias name invisible to the type system.

- Updated dependencies [fe70ee7]
  - @guren/orm@2.1.0

## 2.0.0

### Major Changes

- cda337b: Structural mass-assignment protection (RFC 0006).

  BREAKING CHANGE: `Model.guarded` and `Model.strictFillable` are removed.
  `fillable` is the single allowlist and is always strict; the primary key
  (`id`) is always silently stripped from mass-assignment input. Models can
  contribute always-denied fields via the new `deniedFields()` hook —
  `AuthenticatableModel` denies its resolved password-hash and remember-token
  columns (new `rememberTokenField` static), so a request body carrying them
  throws a `MassAssignmentException` (new `reason: 'denied' | 'not-fillable'`
  property) regardless of `fillable`. Use `forceCreate()`/`forceUpdate()` for
  trusted server-side values such as `passwordHash: 'oauth:...'`.

  `ModelUserProvider` now reads credential column names from the model contract
  (`resolvePasswordHashField()`/`resolveRememberTokenField()`, now public) when
  the target extends `AuthenticatableModel`; explicit options remain as
  overrides. `AuthManager.useModel()` no longer hardcodes them.

  `defineModel()` drops the deprecated `createType` option (use
  `optionalOnCreate`/`requireOnCreate`), and `AuthenticatableModel.createType`
  no longer widens to `PlainObject` — models extending it directly should
  declare their own `createType`; `defineModel()`-based models are unaffected.

  CLI: `make:auth` stops emitting the now-redundant `guarded` line;
  `guren check` fails on models declaring `guarded`/`strictFillable` and on
  `fillable` listing a denied credential column; `guren audit` recognizes
  structurally protected auth models and warns when a controller method mixes
  `validateBody` with `forceCreate`/`forceUpdate`; `guren upgrade --check-only`
  detects the removed statics.

### Patch Changes

- d7e80fe: Identify hot-reload owners correctly when a path or a function name contains
  parentheses

  Under `bun --hot`, both packages key what a reload must tear down — timers for
  cache stores, schedulers, rate limiters and broadcast managers; clients for
  database connections — on the file that built it, read out of a stack frame
  whose location is wrapped in parentheses: `at make (/app/x.ts:3:1)`.

  `@guren/server` could not read that shape at all when the path itself
  contained parentheses, which is an ordinary macOS directory name
  (`~/Projects (2024)`). The rejected frame was not simply lost: the frame walk
  falls through to the next frame that does parse — a _different_ file, further
  out — so two owners reached from one place shared a slot, and building the
  second stopped the first's live timer.

  `@guren/orm` could read a path with parentheses, but by taking the frame's
  _leftmost_ `(` — which gets the wrong pair when the _function name_ in front
  of the location has parentheses instead. Bun emits exactly that shape for a
  method whose key carries them: `at weird (name) (/app/x.ts:3:1)`. Leftmost
  matching reads that as `name) (/app/x.ts`, which is not a path but is stable
  enough to be used as a key — worse than losing the frame, because on the
  server side the same rule also swallows the `unknown` marker of an implicit
  constructor, defeating the filter that stops every such owner from collapsing
  into one slot.

  Neither the leftmost nor the rightmost `(` is right in general — a path with
  parentheses needs the first, a function name with parentheses needs the last.
  Both packages now find the location by scanning back from the frame's final
  `)` and counting nesting depth, so it is bounded by whichever parenthesis
  actually matches it. Frames without parentheses in either position parse to
  exactly what they did before.

  An `eval` frame — `at eval (eval at <anonymous> (/app/x.ts:1:2), <anonymous>:1:1)`
  — is now rejected outright rather than read as a path: the location it
  contains belongs to the `eval` call site, not to the owner under construction,
  and using it as a key would drift on any edit to the line the `eval` occurs
  on. An owner with no key is left alone, which is the safe failure everywhere
  else in these registries.

- Updated dependencies [63fd323]
- Updated dependencies [e2c82da]
- Updated dependencies [d7e80fe]
- Updated dependencies [df90e04]
- Updated dependencies [cda337b]
  - @guren/orm@2.0.0

## 1.5.0

### Minor Changes

- e5b8688: feat: let jobs pin their durable wire identity

  Queue identity was derived entirely from the class name — registration,
  dispatch, and worker lookup all keyed on `jobClass.name`. That breaks a queued
  message whenever the class name changes between the write and the read: a class
  renamed while a backlog drains, or a bundler that mangles identifiers. The
  Vercel plugin hit the second case in production and was fixed at the bundler
  level, but that fix does not reach a user running their own esbuild or rollup
  over a Guren app.

  Jobs may now declare a stable wire name:

  ```ts
  export class SendWelcomeEmailJob extends Job<{ userId: string }> {
    static jobName = "SendWelcomeEmailJob";
  }
  ```

  `registerJob()` and `Job.dispatch()` resolve the name through a new exported
  `resolveJobName()` helper, which `@guren/testing`'s `FakeQueue` uses as well so
  the fake keys jobs exactly as the real driver does. Jobs without a `jobName`
  keep resolving by class name — this is opt-in and backward compatible.

  Only an **own** `jobName` counts. Statics are inherited, so resolving through
  the prototype chain would make every subclass of a pinned job claim its
  parent's identity and evict it from the registry. A subclass that wants to
  share the parent's wire name declares it explicitly.

  ### Upgrading

  The framework's own jobs now declare a `jobName`, pinning their wire name
  against future bundler mangling. In a normal, unmangled build this is a no-op —
  the declared name already equals the class name for both `SendMailJob` and
  `SendNotificationJob` — so it only matters going forward. **If a previous
  deploy was bundled with identifier mangling**, those jobs were queued under the
  mangled name (`a`, `t`, …) and will not resolve against the now-declared one;
  drain the affected queues before upgrading.

  `@guren/testing` now imports `resolveJobName` from `@guren/server`. Its
  `@guren/server` peer range stays at `>=1.0.0` — tightening it would only be
  satisfied once `@guren/server` itself is released at the
  version shipping this feature, which breaks workspace linking against the
  not-yet-released version in the meantime, and `.changeset/config.json`'s
  `onlyUpdatePeerDependentsWhenOutOfRange` deliberately keeps this range wide so
  routine `@guren/server` bumps don't force a spurious major on `@guren/testing`.
  Pair a current `@guren/testing` with a current `@guren/server`.

- 27137f9: Console commands are wired up automatically, and `guren check` reports the ones that are not.

  `make:command` wrote a class and printed the registration step for the user to
  perform by hand. Forgetting it left dead code with no signal — the same bug the
  console entrypoint was added to fix, recurring once per generated command.

  `make:command` now performs that wiring: a project-level command is imported
  and appended to `kernel.registerMany([...])` in `src/console.ts`, and
  `bunx guren check` warns about any command class a console entrypoint never
  uses outside its imports.

  `defineModule()` gains a `commands` field alongside `routes` and `providers`,
  so a module's commands reach the root kernel through its public surface:

  ```ts
  // modules/billing/index.ts — make:command --module billing writes this
  export const billingModule = defineModule({
    name: "billing",
    commands: [InvoiceCommand],
  });

  // src/console.ts — add once per module
  kernel.registerMany(billingModule.commands);
  ```

  Previously the only route was re-exporting the command from the module's
  `index.ts`, because importing it directly from `src/console.ts` reaches into
  module internals and fails `guren check --arch`.

  `guren context` now lists console commands, which were invisible to it before.

### Patch Changes

- ba3aae4: Fix queued notifications delivering nothing

  A notification with `static shouldQueue = true` was queued and picked up by the
  worker, but no channel was ever invoked. Serialization spread the notification
  into a plain payload (`{ ...notification }`), which copies only own enumerable
  properties — `via`, `toMail`, `toDatabase` and `toSlack` all live on the
  prototype and were dropped. The job handler then rebuilt a shim that read the
  delivery channels from a `_viaChannels` field nothing ever wrote, so `via()`
  returned an empty list and the send loop had nothing to iterate. The
  synchronous path was unaffected.

  Queued notifications are now rebuilt as real instances. Notification classes
  are recorded in a registry keyed on `notification.type` and restored with
  `Object.create(prototype)`, which brings back every prototype method without
  re-running the constructor (constructor arguments are not recoverable from a
  payload). Registration happens automatically when a notification is queued,
  which covers a worker sharing the dispatching process; a worker in a separate
  process should call the newly exported `registerNotification()` at boot, and an
  unregistered type now throws instead of failing silently.

  Routing survives the queue too. The worker used to guess a notifiable's routes
  from a `${channel}Route` property convention that the documented `Notifiable`
  does not follow, so a queued notification to a user routing Slack via
  `this.slackId` silently fell back to the org-wide webhook. `routeNotificationFor()`
  is arbitrary user code — frequently a closure on an object literal — and cannot
  be rebuilt from a payload, so it is now called at dispatch and the resolved
  routes travel with the job. Payloads written before this release still fall
  back to the old convention.

  The job itself was also unreachable from a dedicated worker. It was registered
  only as a side effect of dispatching, under the name of an internal per-manager
  subclass, so `guren queue:work` running as its own process failed every
  notification with `Job class not found`. That subclass is gone — since the
  queue registry keys on the class name, every manager overwrote the same entry
  anyway — leaving one `SendNotificationJob` that `NotificationServiceProvider`
  registers on boot via the new `NotificationManager#registerQueueJob()`.

  Also: `createdAt` is serialized explicitly and revived as a `Date`, so drivers
  that persist JSON (Redis, SQS) no longer hand channels a string. `Notifiable`
  gained an optional `notifiableType`, honored by `DatabaseChannel` through the
  newly exported `resolveNotifiableType()`, so a notifiable rebuilt from a
  payload keeps its original type name instead of recording `Object`.

  Because rebuilt notifications are real instances, a user-defined `shouldSend()`
  is now honored on the queued path; the previous shim hardcoded it to `true`.

- Updated dependencies [a7aec95]
- Updated dependencies [7d18f07]
- Updated dependencies [f448a0a]
  - @guren/orm@1.3.0

## 1.4.0

### Minor Changes

- 5196935: Added application modules — a `modules/<name>/` directory convention for composing self-contained slices of an app instead of piling everything into one flat `app/`, `routes/`, and `db/schema.ts`. `defineModule()` (new in `@guren/server`, re-exported from `@guren/core`) declares a module's routes and providers; `Application` folds them into its provider list and route mounting at boot via the new `mountModuleRoutes()`.

  On the CLI side: `guren make:module <name>` scaffolds and auto-wires a module (`index.ts`, `routes.ts`, `db/schema.ts`, plus `src/app.ts`/`db/schema.ts` patching). Most `make:*` generators accept `--module <name>` to scaffold inside a module instead of the project root. `guren check`, `guren audit`, `guren context`, `model:list`, and `doctor` are all module-aware automatically, and once any `modules/` directory exists, `guren check` derives zero-config boundary rules that flag cross-module imports reaching past a module's public surface (`index.ts` or `db/schema.ts`) — no `guren.arch.ts` authoring required. `guren codegen`, `guren audit`, `openapi:generate`, and `guren route:list` all see routes registered inside a module's own `routes.ts`, not just the top-level `routes/web.ts`.

- 0138070: feat: entity-centric context bundles (RFC 0004 Part 1)

  - `guren context <Entity>` joins everything the CLI knows about one model
    into a single markdown/JSON bundle: model metadata (table, columns,
    relationships, reverse references), routes with validation schemas,
    controller actions, Inertia pages with extracted Props, resource,
    policy, factories, seeders, and tests. Same-named models across
    modules are disambiguated with `--module` (`--module app` selects the
    application root), and every join is scoped to the selected location
    when the name is duplicated.
  - `guren context` (whole-project) now reports routes from the full
    `RouteDefinition` payload — the Routes table gains a Controller column
    and JSON output includes controller bindings and schema type strings.
  - `RouteDefinition` gains `bindings` (param name → bound model class
    name) so route model bindings are introspectable.
  - The MCP endpoint exposes the bundle as the `guren_entity_context` tool
    and the `guren://context/{entity}` resource template.

- 97aa6c7: Let apps configure the server-rendered Inertia document through `setInertiaDocument()`.

  The `<body>` class and the critical CSS inlined into `<head>` were hardcoded to page components named `Docs/*`. Any other page whose theme is applied by a client effect painted the stylesheet's default surface color first and only corrected itself once React hydrated — a visible flash on the very first frame.

  `setInertiaDocument({ bodyClass, criticalCss, prepaintScript })` moves that decision to the app. Each field takes a string or a function of the page component, so a docs section can claim a light surface while marketing pages keep a dark one. The same three fields exist on `InertiaOptions` for per-response overrides. Call it at module scope in the app entry so every runtime — the Bun server, serverless handlers, generated worker bundles — picks it up.

  The old `Docs/*` special case is gone, but no scaffold or template ever emitted a page component under that name, so nothing needs migrating:

  ```typescript
  setInertiaDocument({
    bodyClass: ({ component }) =>
      component.startsWith("Docs/") ? "docs-theme" : undefined,
  });
  ```

- 88e6d4f: fix: make the `guren_codegen` MCP tool regenerate changed artifacts

  The tool called the CLI generators without `force`, so as soon as a route
  changed — the one case where regeneration matters — the writer refused with
  "already exists. Use --force to overwrite." A blanket `catch {}` per generator
  swallowed that, and the tool reported `{"generated": []}` as a success. It now
  passes `force: true`, the way `guren codegen` already does, since these
  outputs are generated artifacts that exist to be overwritten.

  Skips are no longer silent. The response carries a `skipped` array naming each
  artifact and the reason it was not produced, and a generator that throws now
  marks the whole run as an error even when other artifacts were written. A
  generator that simply found nothing to describe — an app with no page
  components, for instance — is reported as a skip rather than a failure.

  The tool also generates `.guren/api-client.gen.ts`, which it previously left
  out even though `guren codegen` produces it. Because the API client is built
  from the route manifest, an agent that added a route through MCP got every
  other artifact refreshed while the client silently went stale.

- f7186c7: Add `fetchFallbackEmail` to `OAuthProviderConfig`: an optional async hook consulted when the userinfo response carries no email. `createGitHubOAuthProviderConfig` now supplies a default implementation that fetches the primary verified address from GitHub's `/user/emails` endpoint — GitHub returns `email: null` for accounts with a private email even when the `user:email` scope was granted, which previously made OAuth sign-in fail for those accounts.
- 10a9bd1: Add `emailVerified` to `OAuthUserProfile`. Providers report whether they actually verified an address separately from the address itself — Google sends OIDC's `email_verified`, Discord sends `verified` — and until now that signal was only reachable through the untyped `profile.raw` bag. The field is tri-state on purpose: `true` (the provider asserts verified), `false` (it asserts not verified), `undefined` (no signal, so the app decides its own policy).

  Provider configs declare where to read it via `emailVerifiedKey`, so the shared mapper knows only OIDC's standard `email_verified` claim; the Google and Discord presets each declare their own key, and only boolean values are read. GitHub's `/user` carries no such field, so `emailVerified` stays `undefined` there — except when the private-email fallback runs, which reports `true` because `/user/emails` only yields verified primary addresses. `mapProfile` still owns the whole mapping when set.

  `fetchFallbackEmail` may now also return `{ email, emailVerified }` instead of a bare string, since the signal read from the userinfo response cannot vouch for an address that response did not contain. This is additive: implementations written against the original signature keep compiling, and a bare string deliberately claims nothing, leaving `emailVerified` undefined rather than asserting `true` on their behalf.

  `make:auth --oauth`'s scaffolded `OAuthController` now checks `profile.emailVerified === false` instead of matching provider-specific keys on `profile.raw`. Same behavior, no provider names in generated application code.

- db4450e: Added `@guren/plugin-cloudflare` — the Cloudflare Workers deploy adapter (RFC 0003 Part 1). `createWorkersHandler(app)` wraps a Guren `Application` in a Workers module handler with lazy, deduplicated boot on the first request (bindings arrive with `fetch`, so boot cannot run at module scope) and passes each request's `env`/`ExecutionContext` through to Hono untouched. `getWorkersEnv<Env>()` exposes the first request's bindings to boot-time config behind a write-once holder, and `guren cloudflare:build` assembles a deployable `.cloudflare/` directory: the app's canonical build, a generated worker entry that statically wires the built SSR bundle, copied static assets for Workers Static Assets, and a `wrangler.jsonc` scaffold (D1 binding, `nodejs_compat`, drizzle migrations dir).

  The plugin's provider follows the `definePlugin()` factory shape (`cloudflarePlugin()` — configuration reserved for upcoming session/OAuth-state wiring), so there is no auto-registered class provider; the CLI command works regardless via the `gurenPlugin.commands` manifest.

  Supporting additions: `setInertiaSsrRenderer()` in `@guren/server` registers a process-wide default SSR renderer (per-call `ssr.render` still wins) so filesystem-free runtimes can use a static import instead of the `GUREN_INERTIA_SSR_ENTRY` dynamic import, and `TestApp.fromWorkers(handler, { env })` in `@guren/testing` drives a Workers-style handler with a fake `ExecutionContext` for testing the lazy-boot lifecycle.

- 1a6b738: Reduced session write volume (RFC 0003 Part 3): the session middleware no longer persists on every request, which matters anywhere writes are metered (Cloudflare D1's free tier allows 100k row writes/day — previously every page view consumed one).

  - **Empty new sessions are not persisted and issue no cookie.** An anonymous request that never stores anything now costs zero store operations. Sessions (and their cookie) appear the moment anything is stored. Apps that relied on every visitor receiving a session cookie unconditionally will see it appear on first actual session use instead. (With the default auth stack this happens on the first CSRF-protected page, unchanged for now.)
  - **Flash aging only dirties sessions that carried flash data**, instead of marking every loaded session dirty on every request.
  - **New optional `SessionStore.touch(id, ttlSeconds)`** — rolling expiry for unchanged sessions becomes a TTL refresh instead of a full data rewrite. Implemented in `MemorySessionStore`, `RedisSessionStore` (EXPIRE), and `DatabaseSessionStore` (single UPDATE). Stores without `touch` keep the previous full-write fallback, and touching a missing session is a no-op — an expired session is no longer resurrected as an empty row by its stale cookie.

- f60c041: CSRF protection moves out of the session into signed tokens (RFC 0003 Part 3), using the app keyring via `MessageSigner` (`APP_PREVIOUS_KEYS` rotation supported). The token is **bound to the session** when a logged-in one exists and **stateless double-submit** for guests:

  - **Logged-in (session-bound):** the token carries the session id and is verified against the live session — immune to cookie injection, including a sibling-subdomain attacker who plants their own validly-signed token (it is bound to _their_ session id, not the victim's). This preserves the security posture of the previous session-stored token.
  - **Guest (stateless):** a signed random token verified against the `XSRF-TOKEN` cookie. Guests hold no authenticated state to protect, and nothing is stored server-side — so anonymous page views cost zero session writes and no session cookie. Completing the write-volume work, a guest GET + form POST roundtrip now performs no session store operations at all, which is what makes the default auth stack viable on write-metered databases like Cloudflare D1's free tier.

  The CSRF middleware no longer requires session middleware to be registered; `getCsrfToken()` no longer throws without it. `cookie: false` now works for session-authenticated flows (bound tokens verify without the cookie). Tokens stored in sessions by earlier releases keep verifying via a legacy fallback until those sessions expire, so in-flight sessions survive the upgrade — no action required.

### Patch Changes

- b49e052: Report unhandled exceptions to the console when no reporter is registered.

  An app that never called `reporter()` turned a 500 into a rendered error page and nothing else. On a hosted runtime, where stdout is the only channel back to the operator, that left production failures with no trace to follow — the cause could only be found by bisecting the code. Anything that registers a reporter still owns reporting entirely; this only fills the empty case.

- 7fc5692: Fixed leaked interval timers under `bun --hot`. Each hot reload re-runs the module graph in the same process, and a `setInterval` callback keeps its owner reachable — so the cache sweep, rate-limit cleanup, SSE ping, and scheduler timers built by the previous evaluation went on firing against objects nothing referenced any more, one extra timer per reload. The rate-limit and SSE timers are not `unref()`ed, so those also duplicated work and held the process open on their own; a duplicated scheduler would have run every scheduled task twice per reload. Each owner now parks its teardown on a `globalThis` registry — the same approach `Application.listen()` already uses for the Bun and Vite dev servers — and stops its predecessor before taking over.

  This only applies under `bun --hot`. An owner is identified by the file that built it plus a discriminator (the cache store's name, the rate-limit store's class, the scheduler's timezone), so it is replaced only by a later evaluation of that same file. Nothing is ever torn down automatically in production, tests, CLI commands, or serverless.

  Three things to know. Cache stores are tracked from the cache configuration, so a store built by calling `new MemoryStore()` directly in application code is not covered — every path the templates and examples take goes through cache config. Broadcast managers are tracked from `createBroadcastManager()`, so a bare `new BroadcastManager()` is likewise left alone. And because every manager built through `createCacheManager()` reports that factory as its call site, the store name is the whole of a cache store's identity: two cache managers in one process would share a slot per store name, so the second store under a given name stops the first one's sweep. Apps have one cache manager.

  As part of this, `BroadcastManager` gained a public `disconnectAll()` that closes every SSE connection it is holding, which is what stops those connections' ping timers.

- Updated dependencies [360d1f4]
- Updated dependencies [a2c7b8c]
- Updated dependencies [d5d0c5b]
  - @guren/orm@1.2.0

## 1.3.0

### Minor Changes

- 9576668: Add `definePlugin()` helper for authoring configurable plugins without ServiceProvider boilerplate. Each factory call returns an independent provider class with the configuration captured in a closure, so the same plugin can be registered multiple times with different configurations — replacing the unsafe static-config pattern previously shown in the plugin authoring guide. Supports `deferred`/`provides` for lazy loading. Exported from `@guren/core` alongside `PluginDefinition` and `PluginFactory` types. (RFC 0001, Part A)

  `ProviderManager.register()` now throws when a deferred provider declares no `provides` services — previously such a provider was silently dropped and could never load.

- 15b4be0: Add `detectLocaleMiddleware`: resolves the request locale from the `?locale=` query parameter, a `locale` cookie, or the `Accept-Language` header (region subtags and q-values understood), restricted to a supported-locales allowlist. Sets the `locale` context variable — feeding the `<html lang>` attribute of Inertia responses — and binds request-scoped `t`/`tc` translator helpers when an i18n manager is available (the `setI18n()` global, or one passed via the `i18n` option). Also fixes the `<html lang>` i18n fallback in `Controller.inertia` to read the router-injected container (the previous context-variable lookup never fired in real apps).
- 6e0efe2: Guard OAuth `redirectTo` against open redirects. State creation and verification both sanitize the value: app-relative paths always pass, absolute URLs only when their host is in the new `stateConfig.allowedRedirectHosts` allowlist (wildcards supported); protocol-relative URLs, backslash variants, and non-http schemes are dropped. New `OAuthManager.handleCallback()` returns the profile together with the sanitized `redirectTo`, and `sanitizeOAuthRedirect()` is exported for custom flows. The `guren add oauth` scaffold now demonstrates the safe round-trip (`?redirectTo=` → `handleCallback`).
- 7683c66: Add the `Sanitized<T, Hidden>` type helper (and `DefaultSanitizedKeys`). `auth.user()` sanitizes records at runtime — the password column, remember-token column, and the model's `static hidden` fields are stripped — but the type previously still claimed those fields were present. `auth.userOrFail<Sanitized<UserRecord>>()` strips the conventional credential keys from the compile-time type (distributing over union records); columns with non-conventional names and extra hidden fields go in the second type parameter (`Sanitized<UserRecord, 'twoFactorSecret'>`).
- b1098cf: Wire `TestRequestBuilder.withSession()` to server-side session hydration: the session middleware now reads the `X-Testing-Session` header — only when `GUREN_TESTING` is set, same gate as `X-Testing-User` — parses the JSON payload, and merges it over the stored session data for the request. Tests using `createTestClient(...).get(...).withSession({ ... })` now observe the injected session state instead of an empty session. Malformed or non-object payloads are ignored.

## 1.2.0

### Minor Changes

- 7a30cb5: Localize the root `<html lang>` attribute of Inertia responses. Controllers can set it per response with `this.inertia(page, props, { lang: 'ja' })`, and when the option is omitted it is derived automatically: a request-scoped `locale` context variable (set by locale-detection middleware via `c.set('locale', ...)`) wins over the app-wide i18n locale (`I18nServiceProvider`), falling back to `"en"`.

## 1.1.0

### Minor Changes

- bc79a6a: Resolve the `@/` alias from the project root instead of `app/`. The Vite plugin alias, scaffolded imports (`make:*`, `add resource`), and docs now use root-relative paths like `@/.guren/pages.gen` and `@/app/Http/Resources/PostResource`, removing deep `../../..` relative imports. `guren doctor` gains a `tsconfig-alias` check with autofix. Apps created before this release should update `tsconfig.json` paths to `"@/*": ["./*"]` so newly scaffolded code resolves.

### Patch Changes

- bc79a6a: Auto-register `InertiaServiceProvider` after user providers. Validation errors on Inertia requests are now redirected with the error bag as expected instead of returning a raw JSON 422 that triggered the Inertia error modal. Apps that registered the provider explicitly keep working unchanged.
- f12e754: Fix Inertia SSR on serverless deployments and stop shipping dev import maps in production.

  - The Guren Vite plugin now defaults `ssr.noExternal` to `true` for SSR builds so `.guren/ssr` bundles are self-contained and importable on runtimes without `node_modules` (Vercel, Lambda).
  - `@guren/plugin-vercel` pins `process.env.NODE_ENV` to `"production"` when bundling the function entrypoint; `bun build` otherwise inlines it as `"development"`, disabling every production code path at runtime.
  - The Inertia HTML document no longer emits the esm.sh dev React import map when `NODE_ENV` is `production`.

- Updated dependencies [bc79a6a]
  - @guren/orm@1.0.1

## 1.0.0

### Major Changes

- 73d311c: v1.0 Release Candidate

  New subsystems: OAuth, MySQL adapter, typed broadcasting, OpenAPI generation,
  production error pages, request ID/logging middleware, plugin test harness,
  API-only and worker starter kits.

  DX: Golden path standardization, doctor autofixes, CLI consistency,
  upgrade productization, security defaults.

  Quality: Playwright E2E, CI matrix, nightly canary, benchmarks,
  smoke tests for all starter kits.

  Docs: Task-completion guides (en/ja), plugin authoring guide,
  deployment recipes (Docker, Fly.io, VPS, serverless).

  Governance: API stability tiers, deprecation policy, SemVer guidance,
  RFC process, release cadence, issue triage SLAs.

### Minor Changes

- d3a0d2c: DX fixes from the i18n dogfooding lap:

  - **Middleware `c.header()` now reaches controller responses.** Handlers and controllers return raw `Response` objects, which bypassed Hono's response construction — headers staged via `c.header()` in upstream middleware (e.g. a locale cookie) were silently dropped. Route responses are now rebuilt through `c.newResponse()`, merging prepared headers (`Set-Cookie` appended, the handler's own headers winning otherwise).
  - **`TestApp.withHeaders()` / `withHeader()`**: send custom request headers on every request (Accept-Language, bearer tokens, …). Like `actingAs()` and `json()`, they return a new `TestApp` and compose freely.
  - **`shareInertiaProps()`** merges shared props over previously registered resolvers, so multiple providers can each contribute (auth, i18n, flash, …) without clobbering one another. `getInertiaSharedPropsResolver()` is now exported for manual composition.
  - **Docs**: global middleware must be attached in a provider's `register()` — routes mount before `boot()`, so `app.use()` from `boot()` never applies. Documented in the architecture guide (en/ja).

- 379d57e: First-class file uploads:

  - **`this.file(name)` / `this.files(name)` controller helpers** — read uploaded files from multipart requests (null/empty-safe, composes with other body reads via Hono's cached parseBody). Previously controllers had to call `this.request.parseBody()` and duck-type the result.
  - **`TestApp` accepts `FormData` bodies** — `csrf.post('/tasks/1/attachments', formData)` sends real multipart requests, so upload endpoints are finally testable.

- 57f6f35: Fixes and features from building a real app (Kadai) on the published packages:

  - **@guren/server: entry bundles now share chunks** (tsup `splitting: true`). Each entry point previously bundled its own copy of module-level state, so `registerJob()` via the root entry and `Worker` via `./queue` used different job registries — jobs failed with "Job class not found". The same duplication affected the mail manager and queue driver globals.
  - **@guren/server: new `SyncDriver` (queue) and `LogTransport` (mail)** — the template `.env` defaults (`QUEUE_CONNECTION=sync`, `MAIL_MAILER=log`) previously named drivers that did not exist. Sync dispatch executes jobs inline with no worker process; the log transport writes full messages to server output. The `add queue` / `add mail` blueprints now honor these env vars and default to sync/log.
  - **@guren/orm: multi-relation type fix** — `findWith(id, ['a', 'b'])` and `with(['a', 'b'])` typed their results as a union of single-relation picks instead of an intersection, making relation properties inaccessible.
  - **@guren/orm: `QueryBuilder.paginate()` accepts an options object** (`{ page, perPage }`) in addition to positional arguments, matching `Model.paginate()`.

- 7fbf1de: Accept Hono middleware as a terminal route handler:

  - **`RouteHandler` now includes `(c, next)` signatures**, so any Hono `MiddlewareHandler` — including `broadcast.sseMiddleware()` and `broadcast.authMiddleware()` — can be passed directly to `router.get()` / `router.post()` as the docs show, without wrapper closures or `as Promise<Response>` casts.
  - **Responses set via `c.res` are honored**: a middleware mounted as a handler that finalizes the response through `next()` or `c.res =` no longer gets clobbered by a synthesized `204 No Content`. Plain handlers returning `undefined` still produce `204`.

- c10691c: Three bug fixes ahead of 1.0:

  - **Nested eager loading now works at any depth** (#15). `User.with('posts.comments.author')` previously loaded two levels and silently left deeper relations unloaded when going through the query builder. `QueryBuilder` now delegates the full dotted path to `Model.loadRelationInto`, which recurses correctly.
  - **Auth context is available to middleware registered before `boot()`** (#13). The fallback auth context (apps without `options.auth`) is attached in the `Application` constructor, and the context resolves its session lazily — so `app.use(requireAuthenticated())` before `boot()` responds 401 instead of throwing, regardless of session middleware ordering.
  - **Route contracts accept array-style query strings** (#12). `?tag=a&tag=b` now reaches query schemas as `{ tag: ['a', 'b'] }` (single occurrences stay plain strings), matching the controller-side `validateQuery` behavior. Schemas that expect a plain string for a key clients may repeat should switch to `z.array(...)` or accept both.
  - **`guren add oauth` now generates code that compiles.** The scaffolded controller named its action `redirect`, shadowing the base `Controller.redirect()` helper (infinite recursion) and failing to typecheck; the route-param validator also rejected `string | undefined`. The action is now `redirectToProvider` and the validator handles missing params.

- a1fc6ec: Two security defaults locked in ahead of 1.0:

  - **Strict mass assignment.** When a model defines `fillable`, `create()`/`update()` now throw a `MassAssignmentException` naming any field outside the allowlist instead of silently discarding it (silent drops surfaced as NOT NULL violations far from the cause, and masked injection attempts). Use the new `forceCreate()` / `forceUpdate()` for trusted server-side data, or set `static strictFillable = false` per model to restore the old behavior. The `guarded` path is unchanged.
  - **`auth.user()` never exposes credentials.** The session guard sanitizes user records before caching or returning them: the password column, remember-token column, and the model's `static hidden` fields are stripped. Credential checks still run on the raw record internally, so login and remember-me behave exactly as before — but sharing `auth.user` into Inertia props no longer leaks `passwordHash` to the browser. Custom user providers can opt in via the new optional `UserProvider.sanitize()`. `guren add auth` now generates the User model with `static hidden = ['passwordHash', 'rememberToken']`.

- f7de890: Final API freeze pass before 1.0, driven by an adversarial pre-release review:

  - **`QueryBuilder.update()` now enforces the fillable allowlist** exactly like `Model.update()` (it previously bypassed mass-assignment protection entirely); `QueryBuilder.forceUpdate()` is the trusted-data escape hatch.
  - **Redis stores are now importable**: `@guren/core/redis` (and `@guren/server/redis`) ship `RedisSessionStore`, `RedisRateLimitStore`, `RedisSlidingWindowRateLimitStore`, `RedisApiTokenStore`, `RedisPasswordResetStore`, `RedisEmailVerificationStore`, and the new `RedisOAuthStateStore`. The default `MemoryOAuthStateStore` is now bounded (10k entries with expiry sweep) to prevent memory-exhaustion DoS.
  - **`PaginationMeta` name collision resolved**: the ORM's pagination meta is now `ModelPaginationMeta`; `PaginationMeta` from `@guren/core` unambiguously refers to the resource/paginator shape.
  - **React is a peer dependency**: `@guren/inertia-client` moves `react`/`react-dom` to peerDependencies, and `@guren/server` makes `@guren/inertia-client` an optional peer — API-only apps no longer pull React transitively.
  - **`@guren/testing/vitest` subpath**: vitest/React helpers move out of the root barrel so `bun:test` users don't need the React test stack; the related peer deps are marked optional.
  - **`Hash` is runtime-safe**: it now points at `DefaultHasher`, which delegates to Bun's scrypt on Bun and the Node implementation elsewhere (Lambda on Node no longer crashes).
  - Smaller freeze items: `ApplicationOptions`/`AuthPluginOptions` exported, unimplemented `Command.callSilent()` removed, `FormRequest` marked `@deprecated`, `MemoryQueueDriver`/`SyncQueueDriver`/`RedisQueueDriver` aliases added, internal ORM plumbing removed from the `@guren/core` allowlist, `nodemailer` bumped to v9 (HIGH advisory), stray `./dist/*` export wildcard removed.
  - **Docs**: broadcasting client flow rewritten around the `connected` handshake and `clientId` subscription (the previous example authorized but never subscribed), array-style query params documented, rc → 1.0.0 migration notes added, MySQL support matrix corrected, rate-limiting/serverless guides point at the shipped Redis stores.

- a835522: Secure-by-default hardening and AI-agent tooling:

  - `guren audit` command: validates auth/validation coverage on mutating routes, detects raw SQL, secrets, and mass assignment risks
  - `make:feature` now scaffolds auth checks by default (`--public` to opt out) and supports `--policy`
  - Authorization gate wiring, hardened auth/storage/mail/error rendering
  - Inertia asset version mismatch handling
  - drizzle-orm / drizzle-kit upgraded to 1.0.0-rc.1
  - Migration tracker SQL escaping fix and dependency vulnerability patches

- 42c6053: Make SSE broadcasting actually reachable from clients:

  - **The SSE stream announces the connection** with a `connected` event carrying the `clientId` and any already-subscribed channels. Previously clients had no way to learn their id, and no HTTP path ever subscribed a client to a channel — SSE connections received pings but never a single broadcast event.
  - **`?channels=a,b` query subscriptions** on the SSE endpoint: requested channels are authorized against the connecting user (`sseMiddleware({ getUser })`) and subscribed before the stream starts, so a bare `EventSource` works for public channels.
  - **`POST /broadcasting/auth` subscribes as well as authorizes** when the payload includes the `clientId`, returning `{ authorized, subscribed }` per channel.
  - **Unregistered `private-`/`presence-` channels now default to deny** instead of public access — a missing channel registration no longer silently exposes a private channel.

- ac73182: Added SSR support, ORM relationships, pagination, and authentication enhancements.

### Patch Changes

- c2f318d: Align all packages to rc.10.
- e74eab5: fix(ci): upgrade to Node 24 for npm OIDC trusted publishing
- dcee3ee: fix(server): use figlet importable-fonts for bundled builds
- b3c9414: feat(cli): add @guren/plugin-vercel and remove legacy deploy vercel target
  fix(create-app,orm,cli): fix blog blueprint SQLite support and DX issues
  fix(create-app): comment out VITE_DEV_SERVER_URL in template .env
- 73d311c: Align all packages to rc.9.
- 5fbd7e7: Pinned dependencies to specific versions for consistency across packages
- 83ca2c2: Fix critical scaffold-to-runtime breakages found by dogfooding the published packages:

  - **@guren/server**: stop bundling `@guren/orm` (now a real dependency). The bundled copy created a second `Model`/`DrizzleAdapter` instance, so `configureOrm()` never reached `AuthenticatableModel` and every auth query failed with "database has not been configured" in published apps.
  - **@guren/cli `add auth`**: schema updates and the users migration now respect the app's database dialect (sqlite/postgres/mysql) instead of always emitting Postgres SQL; the migration is generated via drizzle-kit instead of a loose `.sql` file that `db:migrate` never executed; `createApp()` is patched with `auth: {}` so sessions and CSRF actually mount.
  - **@guren/cli `add resource`**: honors `--fields` (previously silently ignored) and adds `--public`; delegates file generation to the `make:feature` templates; registers the route group with typed body contracts — the previous insertion regex never matched the starter template, so routes were silently never registered.
  - **@guren/cli `codegen`**: generates route/data/channel/API-client artifacts by default (previously skipped silently unless `--routes` was passed, leaving `routes.gen.ts` empty).
  - **@guren/orm**: warn when the migrations folder contains loose `.sql` files that the drizzle migrator will not execute; export `jsonb` from `@guren/orm/drizzle`.
  - **@guren/inertia-client**: add missing `./typed-forms` and `./components` export map entries (imports failed to resolve in published apps).
  - **create-guren-app**: `--auth` now runs after dependency installation using the app-local CLI and reports failures honestly (previously it always failed silently when run via bunx, yet printed a success message).
  - Docs: quick start now pins `create-guren-app@rc` (npm `latest` still points at the old 0.2.0 alpha) and reflects the SQLite default.

- 38bd637: Ensure dev asset server resolves and serves Inertia client chunks so the scaffold works in dev.
- da8707f: The release build runs build:create-app so the CLI binary is bundled.
- afe4bfd: Two fixes surfaced by dogfooding i18n in a real app:

  - **CSRF cookie refresh no longer wipes other cookies.** `setXsrfCookie` replaced the `Set-Cookie` header on the finalized response, silently dropping any cookie appended by inner middleware or handlers (e.g. a `locale` cookie). It now appends.
  - **`I18nConfig` accepts a `loader` option** as the i18n guide documents. Previously only `path` existed, so `MemoryLoader` (or any custom `TranslationLoader`) could not be injected into `createI18n` / `new I18nManager()`. `loader` takes precedence over `path`.

- 08ac277: Updated the scaffolded app template so new projects pull in the freshly published prerelease.
- 4011200: Second round of real-app (Kadai) fixes:

  - **@guren/cli codegen: inherited page props are no longer dropped.** `interface Props extends PaginatedPageProps<T> { ... }` now extracts as an intersection of the heritage clauses and the body. Previously only the body was captured — an empty-bodied extends silently degraded the page contract to `{}` (no type checking at all), and adding any own member made the inherited members vanish from the contract, rejecting valid controller props.
  - **@guren/testing: `TestApp.withCsrf()`** primes CSRF like a real browser — GETs a page, captures the session and XSRF-TOKEN cookies, and sends them (plus `X-XSRF-TOKEN`) on subsequent requests, so mutating endpoints are finally testable against apps with CSRF enabled.
  - **@guren/orm: `GUREN_QUIET_DUPLICATE_ORM=1`** silences the duplicate-copy warning for environments where two copies coexist by design (e.g. monorepo dev with src + dist).

- d8c572a: Fix the project created with the `create-guren-app` command so it can start successfully.
- 8ee89bb: Quality hardening: database-matrix runtime gates, upgrade-path protection, and add-on runtime smokes:

  - **PostgreSQL golden-path gate**: the scaffold→auth→CRUD runtime smoke now also runs against PostgreSQL in CI and the release workflow (dedicated `guren_smoke` database locally so developer data is never touched), verifying dialect-aware scaffolds, `resetDatabase()`, and `migrationStatus()` on pg for every release.
  - **`guren upgrade` works for the rc channel**: previously only `--canary` was supported, leaving rc users with no tool-assisted upgrade. `guren upgrade` now aligns every `@guren/*` package to a resolved dist-tag version (default `rc`, override with `--tag`), and warns when nested duplicate `@guren` copies survive in node_modules with the exact dedupe command.
  - **Duplicate-copy runtime guard**: loading two copies of `@guren/orm` (mixed versions) now prints a loud diagnostic explaining why database access fails and how to fix it, instead of failing silently with "database has not been configured".
  - **`Mail#build()` runs automatically**: scaffolded mailables previously threw "Email must have a subject" because `send()`/`queue()` never invoked `build()` — every user following the `add mail` scaffold hit this. Found by the new add-on runtime smoke, which now dispatches the scaffolded queue job and sends the scaffolded mailable on every release.

- 3add058: Fixed registerDevAssets to resolve the bundled Inertia client via @guren/inertia-client/app, rebuilt @guren/server, and confirmed the scaffolded app now loads without blank-screen 404s.
- 7f52ba4: Add open-source metadata, licensing, and community docs to prepare the packages for an initial public release.
- bba40d6: Runtime release gate, unified drizzle-kit migrations, and richer relations:

  - **Golden-path runtime smoke**: the release workflow now boots a scaffolded app and drives login, CRUD, CSRF, and auth rejection over HTTP before publishing — the class of published-artifact-only breakage fixed in rc.20 can no longer ship.
  - **Migrations unified on drizzle-kit**: `createSqliteDatabase`/`createPostgresDatabase`/`createMySqlDatabase` now expose `resetDatabase()` and `migrationStatus()`, making `guren db:reset`, `db:fresh`, and `db:status` work out of the box (all three previously failed on scaffolded apps). `db:rollback` now explains that drizzle-kit migrations are forward-only and points to `db:reset` or a compensating forward migration; the dead flat-SQL rollback tracker was removed.
  - **Relations**: nested eager loading with dot notation (`User.with('posts.comments')` — previously documented but not implemented) and `withCount()` (`users[0].postsCount`) for hasMany/hasOne/belongsTo/morphMany. Relation declarations no longer need `typeof` guards or `as any` casts; the testing mocks now include relation registrars so model modules load cleanly under Vitest.
  - Templates export `resetDatabase`/`migrationStatus` from config/database.ts and ship `db:reset`/`db:status` scripts; relationship docs updated (EN/JA) with the clean declaration pattern and `withCount`.

- 11e876c: first release
- Updated dependencies [c2f318d]
- Updated dependencies [e74eab5]
- Updated dependencies [b3c9414]
- Updated dependencies [73d311c]
- Updated dependencies [7687a0f]
- Updated dependencies [5fbd7e7]
- Updated dependencies [83ca2c2]
- Updated dependencies [38bd637]
- Updated dependencies [d3a0d2c]
- Updated dependencies [379d57e]
- Updated dependencies [c2f318d]
- Updated dependencies [da8707f]
- Updated dependencies [afe4bfd]
- Updated dependencies [57f6f35]
- Updated dependencies [77049eb]
- Updated dependencies [7fbf1de]
- Updated dependencies [08ac277]
- Updated dependencies [c10691c]
- Updated dependencies [a1fc6ec]
- Updated dependencies [f7de890]
- Updated dependencies [4011200]
- Updated dependencies [d8c572a]
- Updated dependencies [8ee89bb]
- Updated dependencies [3add058]
- Updated dependencies [7f52ba4]
- Updated dependencies [bba40d6]
- Updated dependencies [a835522]
- Updated dependencies [42c6053]
- Updated dependencies [ac73182]
- Updated dependencies [11e876c]
- Updated dependencies [73d311c]
  - @guren/inertia-client@1.0.0
  - @guren/orm@1.0.0

## 1.0.0-rc.26

### Minor Changes

- f7de890: Final API freeze pass before 1.0, driven by an adversarial pre-release review:

  - **`QueryBuilder.update()` now enforces the fillable allowlist** exactly like `Model.update()` (it previously bypassed mass-assignment protection entirely); `QueryBuilder.forceUpdate()` is the trusted-data escape hatch.
  - **Redis stores are now importable**: `@guren/core/redis` (and `@guren/server/redis`) ship `RedisSessionStore`, `RedisRateLimitStore`, `RedisSlidingWindowRateLimitStore`, `RedisApiTokenStore`, `RedisPasswordResetStore`, `RedisEmailVerificationStore`, and the new `RedisOAuthStateStore`. The default `MemoryOAuthStateStore` is now bounded (10k entries with expiry sweep) to prevent memory-exhaustion DoS.
  - **`PaginationMeta` name collision resolved**: the ORM's pagination meta is now `ModelPaginationMeta`; `PaginationMeta` from `@guren/core` unambiguously refers to the resource/paginator shape.
  - **React is a peer dependency**: `@guren/inertia-client` moves `react`/`react-dom` to peerDependencies, and `@guren/server` makes `@guren/inertia-client` an optional peer — API-only apps no longer pull React transitively.
  - **`@guren/testing/vitest` subpath**: vitest/React helpers move out of the root barrel so `bun:test` users don't need the React test stack; the related peer deps are marked optional.
  - **`Hash` is runtime-safe**: it now points at `DefaultHasher`, which delegates to Bun's scrypt on Bun and the Node implementation elsewhere (Lambda on Node no longer crashes).
  - Smaller freeze items: `ApplicationOptions`/`AuthPluginOptions` exported, unimplemented `Command.callSilent()` removed, `FormRequest` marked `@deprecated`, `MemoryQueueDriver`/`SyncQueueDriver`/`RedisQueueDriver` aliases added, internal ORM plumbing removed from the `@guren/core` allowlist, `nodemailer` bumped to v9 (HIGH advisory), stray `./dist/*` export wildcard removed.
  - **Docs**: broadcasting client flow rewritten around the `connected` handshake and `clientId` subscription (the previous example authorized but never subscribed), array-style query params documented, rc → 1.0.0 migration notes added, MySQL support matrix corrected, rate-limiting/serverless guides point at the shipped Redis stores.

### Patch Changes

- Updated dependencies [f7de890]
  - @guren/orm@1.0.0-rc.27
  - @guren/inertia-client@1.0.0-rc.25

## 1.0.0-rc.25

### Minor Changes

- a1fc6ec: Two security defaults locked in ahead of 1.0:

  - **Strict mass assignment.** When a model defines `fillable`, `create()`/`update()` now throw a `MassAssignmentException` naming any field outside the allowlist instead of silently discarding it (silent drops surfaced as NOT NULL violations far from the cause, and masked injection attempts). Use the new `forceCreate()` / `forceUpdate()` for trusted server-side data, or set `static strictFillable = false` per model to restore the old behavior. The `guarded` path is unchanged.
  - **`auth.user()` never exposes credentials.** The session guard sanitizes user records before caching or returning them: the password column, remember-token column, and the model's `static hidden` fields are stripped. Credential checks still run on the raw record internally, so login and remember-me behave exactly as before — but sharing `auth.user` into Inertia props no longer leaks `passwordHash` to the browser. Custom user providers can opt in via the new optional `UserProvider.sanitize()`. `guren add auth` now generates the User model with `static hidden = ['passwordHash', 'rememberToken']`.

### Patch Changes

- Updated dependencies [a1fc6ec]
  - @guren/orm@1.0.0-rc.26
  - @guren/inertia-client@1.0.0-rc.24

## 1.0.0-rc.24

### Minor Changes

- c10691c: Three bug fixes ahead of 1.0:

  - **Nested eager loading now works at any depth** (#15). `User.with('posts.comments.author')` previously loaded two levels and silently left deeper relations unloaded when going through the query builder. `QueryBuilder` now delegates the full dotted path to `Model.loadRelationInto`, which recurses correctly.
  - **Auth context is available to middleware registered before `boot()`** (#13). The fallback auth context (apps without `options.auth`) is attached in the `Application` constructor, and the context resolves its session lazily — so `app.use(requireAuthenticated())` before `boot()` responds 401 instead of throwing, regardless of session middleware ordering.
  - **Route contracts accept array-style query strings** (#12). `?tag=a&tag=b` now reaches query schemas as `{ tag: ['a', 'b'] }` (single occurrences stay plain strings), matching the controller-side `validateQuery` behavior. Schemas that expect a plain string for a key clients may repeat should switch to `z.array(...)` or accept both.
  - **`guren add oauth` now generates code that compiles.** The scaffolded controller named its action `redirect`, shadowing the base `Controller.redirect()` helper (infinite recursion) and failing to typecheck; the route-param validator also rejected `string | undefined`. The action is now `redirectToProvider` and the validator handles missing params.

### Patch Changes

- Updated dependencies [c10691c]
  - @guren/orm@1.0.0-rc.25
  - @guren/inertia-client@1.0.0-rc.23

## 1.0.0-rc.23

### Minor Changes

- d3a0d2c: DX fixes from the i18n dogfooding lap:

  - **Middleware `c.header()` now reaches controller responses.** Handlers and controllers return raw `Response` objects, which bypassed Hono's response construction — headers staged via `c.header()` in upstream middleware (e.g. a locale cookie) were silently dropped. Route responses are now rebuilt through `c.newResponse()`, merging prepared headers (`Set-Cookie` appended, the handler's own headers winning otherwise).
  - **`TestApp.withHeaders()` / `withHeader()`**: send custom request headers on every request (Accept-Language, bearer tokens, …). Like `actingAs()` and `json()`, they return a new `TestApp` and compose freely.
  - **`shareInertiaProps()`** merges shared props over previously registered resolvers, so multiple providers can each contribute (auth, i18n, flash, …) without clobbering one another. `getInertiaSharedPropsResolver()` is now exported for manual composition.
  - **Docs**: global middleware must be attached in a provider's `register()` — routes mount before `boot()`, so `app.use()` from `boot()` never applies. Documented in the architecture guide (en/ja).

### Patch Changes

- Updated dependencies [d3a0d2c]
  - @guren/orm@1.0.0-rc.24
  - @guren/inertia-client@1.0.0-rc.22

## 1.0.0-rc.22

### Minor Changes

- 7fbf1de: Accept Hono middleware as a terminal route handler:

  - **`RouteHandler` now includes `(c, next)` signatures**, so any Hono `MiddlewareHandler` — including `broadcast.sseMiddleware()` and `broadcast.authMiddleware()` — can be passed directly to `router.get()` / `router.post()` as the docs show, without wrapper closures or `as Promise<Response>` casts.
  - **Responses set via `c.res` are honored**: a middleware mounted as a handler that finalizes the response through `next()` or `c.res =` no longer gets clobbered by a synthesized `204 No Content`. Plain handlers returning `undefined` still produce `204`.

### Patch Changes

- afe4bfd: Two fixes surfaced by dogfooding i18n in a real app:

  - **CSRF cookie refresh no longer wipes other cookies.** `setXsrfCookie` replaced the `Set-Cookie` header on the finalized response, silently dropping any cookie appended by inner middleware or handlers (e.g. a `locale` cookie). It now appends.
  - **`I18nConfig` accepts a `loader` option** as the i18n guide documents. Previously only `path` existed, so `MemoryLoader` (or any custom `TranslationLoader`) could not be injected into `createI18n` / `new I18nManager()`. `loader` takes precedence over `path`.

- Updated dependencies [afe4bfd]
- Updated dependencies [7fbf1de]
  - @guren/orm@1.0.0-rc.23
  - @guren/inertia-client@1.0.0-rc.21

## 1.0.0-rc.21

### Minor Changes

- 42c6053: Make SSE broadcasting actually reachable from clients:

  - **The SSE stream announces the connection** with a `connected` event carrying the `clientId` and any already-subscribed channels. Previously clients had no way to learn their id, and no HTTP path ever subscribed a client to a channel — SSE connections received pings but never a single broadcast event.
  - **`?channels=a,b` query subscriptions** on the SSE endpoint: requested channels are authorized against the connecting user (`sseMiddleware({ getUser })`) and subscribed before the stream starts, so a bare `EventSource` works for public channels.
  - **`POST /broadcasting/auth` subscribes as well as authorizes** when the payload includes the `clientId`, returning `{ authorized, subscribed }` per channel.
  - **Unregistered `private-`/`presence-` channels now default to deny** instead of public access — a missing channel registration no longer silently exposes a private channel.

### Patch Changes

- Updated dependencies [42c6053]
  - @guren/orm@1.0.0-rc.22
  - @guren/inertia-client@1.0.0-rc.20

## 1.0.0-rc.20

### Minor Changes

- 379d57e: First-class file uploads:

  - **`this.file(name)` / `this.files(name)` controller helpers** — read uploaded files from multipart requests (null/empty-safe, composes with other body reads via Hono's cached parseBody). Previously controllers had to call `this.request.parseBody()` and duck-type the result.
  - **`TestApp` accepts `FormData` bodies** — `csrf.post('/tasks/1/attachments', formData)` sends real multipart requests, so upload endpoints are finally testable.

### Patch Changes

- Updated dependencies [379d57e]
  - @guren/orm@1.0.0-rc.21
  - @guren/inertia-client@1.0.0-rc.19

## 1.0.0-rc.19

### Patch Changes

- 4011200: Second round of real-app (Kadai) fixes:

  - **@guren/cli codegen: inherited page props are no longer dropped.** `interface Props extends PaginatedPageProps<T> { ... }` now extracts as an intersection of the heritage clauses and the body. Previously only the body was captured — an empty-bodied extends silently degraded the page contract to `{}` (no type checking at all), and adding any own member made the inherited members vanish from the contract, rejecting valid controller props.
  - **@guren/testing: `TestApp.withCsrf()`** primes CSRF like a real browser — GETs a page, captures the session and XSRF-TOKEN cookies, and sends them (plus `X-XSRF-TOKEN`) on subsequent requests, so mutating endpoints are finally testable against apps with CSRF enabled.
  - **@guren/orm: `GUREN_QUIET_DUPLICATE_ORM=1`** silences the duplicate-copy warning for environments where two copies coexist by design (e.g. monorepo dev with src + dist).

- Updated dependencies [4011200]
  - @guren/orm@1.0.0-rc.20
  - @guren/inertia-client@1.0.0-rc.18

## 1.0.0-rc.18

### Minor Changes

- 57f6f35: Fixes and features from building a real app (Kadai) on the published packages:

  - **@guren/server: entry bundles now share chunks** (tsup `splitting: true`). Each entry point previously bundled its own copy of module-level state, so `registerJob()` via the root entry and `Worker` via `./queue` used different job registries — jobs failed with "Job class not found". The same duplication affected the mail manager and queue driver globals.
  - **@guren/server: new `SyncDriver` (queue) and `LogTransport` (mail)** — the template `.env` defaults (`QUEUE_CONNECTION=sync`, `MAIL_MAILER=log`) previously named drivers that did not exist. Sync dispatch executes jobs inline with no worker process; the log transport writes full messages to server output. The `add queue` / `add mail` blueprints now honor these env vars and default to sync/log.
  - **@guren/orm: multi-relation type fix** — `findWith(id, ['a', 'b'])` and `with(['a', 'b'])` typed their results as a union of single-relation picks instead of an intersection, making relation properties inaccessible.
  - **@guren/orm: `QueryBuilder.paginate()` accepts an options object** (`{ page, perPage }`) in addition to positional arguments, matching `Model.paginate()`.

### Patch Changes

- Updated dependencies [57f6f35]
  - @guren/orm@1.0.0-rc.19
  - @guren/inertia-client@1.0.0-rc.17

## 1.0.0-rc.17

### Patch Changes

- 8ee89bb: Quality hardening: database-matrix runtime gates, upgrade-path protection, and add-on runtime smokes:

  - **PostgreSQL golden-path gate**: the scaffold→auth→CRUD runtime smoke now also runs against PostgreSQL in CI and the release workflow (dedicated `guren_smoke` database locally so developer data is never touched), verifying dialect-aware scaffolds, `resetDatabase()`, and `migrationStatus()` on pg for every release.
  - **`guren upgrade` works for the rc channel**: previously only `--canary` was supported, leaving rc users with no tool-assisted upgrade. `guren upgrade` now aligns every `@guren/*` package to a resolved dist-tag version (default `rc`, override with `--tag`), and warns when nested duplicate `@guren` copies survive in node_modules with the exact dedupe command.
  - **Duplicate-copy runtime guard**: loading two copies of `@guren/orm` (mixed versions) now prints a loud diagnostic explaining why database access fails and how to fix it, instead of failing silently with "database has not been configured".
  - **`Mail#build()` runs automatically**: scaffolded mailables previously threw "Email must have a subject" because `send()`/`queue()` never invoked `build()` — every user following the `add mail` scaffold hit this. Found by the new add-on runtime smoke, which now dispatches the scaffolded queue job and sends the scaffolded mailable on every release.

- Updated dependencies [8ee89bb]
  - @guren/orm@1.0.0-rc.17
  - @guren/inertia-client@1.0.0-rc.16

## 1.0.0-rc.16

### Patch Changes

- bba40d6: Runtime release gate, unified drizzle-kit migrations, and richer relations:

  - **Golden-path runtime smoke**: the release workflow now boots a scaffolded app and drives login, CRUD, CSRF, and auth rejection over HTTP before publishing — the class of published-artifact-only breakage fixed in rc.20 can no longer ship.
  - **Migrations unified on drizzle-kit**: `createSqliteDatabase`/`createPostgresDatabase`/`createMySqlDatabase` now expose `resetDatabase()` and `migrationStatus()`, making `guren db:reset`, `db:fresh`, and `db:status` work out of the box (all three previously failed on scaffolded apps). `db:rollback` now explains that drizzle-kit migrations are forward-only and points to `db:reset` or a compensating forward migration; the dead flat-SQL rollback tracker was removed.
  - **Relations**: nested eager loading with dot notation (`User.with('posts.comments')` — previously documented but not implemented) and `withCount()` (`users[0].postsCount`) for hasMany/hasOne/belongsTo/morphMany. Relation declarations no longer need `typeof` guards or `as any` casts; the testing mocks now include relation registrars so model modules load cleanly under Vitest.
  - Templates export `resetDatabase`/`migrationStatus` from config/database.ts and ship `db:reset`/`db:status` scripts; relationship docs updated (EN/JA) with the clean declaration pattern and `withCount`.

- Updated dependencies [bba40d6]
  - @guren/orm@1.0.0-rc.15
  - @guren/inertia-client@1.0.0-rc.15

## 1.0.0-rc.15

### Patch Changes

- 83ca2c2: Fix critical scaffold-to-runtime breakages found by dogfooding the published packages:

  - **@guren/server**: stop bundling `@guren/orm` (now a real dependency). The bundled copy created a second `Model`/`DrizzleAdapter` instance, so `configureOrm()` never reached `AuthenticatableModel` and every auth query failed with "database has not been configured" in published apps.
  - **@guren/cli `add auth`**: schema updates and the users migration now respect the app's database dialect (sqlite/postgres/mysql) instead of always emitting Postgres SQL; the migration is generated via drizzle-kit instead of a loose `.sql` file that `db:migrate` never executed; `createApp()` is patched with `auth: {}` so sessions and CSRF actually mount.
  - **@guren/cli `add resource`**: honors `--fields` (previously silently ignored) and adds `--public`; delegates file generation to the `make:feature` templates; registers the route group with typed body contracts — the previous insertion regex never matched the starter template, so routes were silently never registered.
  - **@guren/cli `codegen`**: generates route/data/channel/API-client artifacts by default (previously skipped silently unless `--routes` was passed, leaving `routes.gen.ts` empty).
  - **@guren/orm**: warn when the migrations folder contains loose `.sql` files that the drizzle migrator will not execute; export `jsonb` from `@guren/orm/drizzle`.
  - **@guren/inertia-client**: add missing `./typed-forms` and `./components` export map entries (imports failed to resolve in published apps).
  - **create-guren-app**: `--auth` now runs after dependency installation using the app-local CLI and reports failures honestly (previously it always failed silently when run via bunx, yet printed a success message).
  - Docs: quick start now pins `create-guren-app@rc` (npm `latest` still points at the old 0.2.0 alpha) and reflects the SQLite default.

- Updated dependencies [83ca2c2]
  - @guren/orm@1.0.0-rc.14
  - @guren/inertia-client@1.0.0-rc.14

## 1.0.0-rc.14

### Minor Changes

- Secure-by-default hardening and AI-agent tooling:

  - `guren audit` command: validates auth/validation coverage on mutating routes, detects raw SQL, secrets, and mass assignment risks
  - `make:feature` now scaffolds auth checks by default (`--public` to opt out) and supports `--policy`
  - Authorization gate wiring, hardened auth/storage/mail/error rendering
  - Inertia asset version mismatch handling
  - drizzle-orm / drizzle-kit upgraded to 1.0.0-rc.1
  - Migration tracker SQL escaping fix and dependency vulnerability patches

### Patch Changes

- Updated dependencies
  - @guren/inertia-client@1.0.0-rc.13

## 1.0.0-rc.13

### Patch Changes

- feat(cli): add @guren/plugin-vercel and remove legacy deploy vercel target
  fix(create-app,orm,cli): fix blog blueprint SQLite support and DX issues
  fix(create-app): comment out VITE_DEV_SERVER_URL in template .env
- Updated dependencies
  - @guren/inertia-client@1.0.0-rc.12

## 1.0.0-rc.12

### Patch Changes

- fix(server): use figlet importable-fonts for bundled builds

## 1.0.0-rc.11

### Patch Changes

- fix(ci): upgrade to Node 24 for npm OIDC trusted publishing
- Updated dependencies
  - @guren/inertia-client@1.0.0-rc.11

## 1.0.0-rc.10

### Patch Changes

- Align all packages to rc.10.
- Updated dependencies
  - @guren/inertia-client@1.0.0-rc.10

## 1.0.0-rc.9

### Patch Changes

- Align all packages to rc.9.
- Updated dependencies
  - @guren/inertia-client@1.0.0-rc.9

## 1.0.0-rc.8

### Major Changes

- v1.0 Release Candidate

  New subsystems: OAuth, MySQL adapter, typed broadcasting, OpenAPI generation,
  production error pages, request ID/logging middleware, plugin test harness,
  API-only and worker starter kits.

  DX: Golden path standardization, doctor autofixes, CLI consistency,
  upgrade productization, security defaults.

  Quality: Playwright E2E, CI matrix, nightly canary, benchmarks,
  smoke tests for all starter kits.

  Docs: Task-completion guides (en/ja), plugin authoring guide,
  deployment recipes (Docker, Fly.io, VPS, serverless).

  Governance: API stability tiers, deprecation policy, SemVer guidance,
  RFC process, release cadence, issue triage SLAs.

### Patch Changes

- Updated dependencies
  - @guren/inertia-client@1.0.0-rc.8

## 0.2.0-alpha.7

### Patch Changes

- Fix the project created with the `create-guren-app` command so it can start successfully.
- Updated dependencies
  - @guren/inertia-client@0.2.0-alpha.7

## 0.2.0-alpha.6

### Minor Changes

- Added SSR support, ORM relationships, pagination, and authentication enhancements.

### Patch Changes

- Updated dependencies
  - @guren/inertia-client@0.2.0-alpha.6

## 0.1.1-alpha.5

### Patch Changes

- Ensure dev asset server resolves and serves Inertia client chunks so the scaffold works in dev.
- Updated dependencies
  - @guren/inertia-client@0.1.1-alpha.5

## 0.1.1-alpha.4

### Patch Changes

- Fixed registerDevAssets to resolve the bundled Inertia client via @guren/inertia-client/app, rebuilt @guren/server, and confirmed the scaffolded app now loads without blank-screen 404s.
- Updated dependencies
  - @guren/inertia-client@0.1.1-alpha.4

## 0.1.1-alpha.3

### Patch Changes

- The release build runs build:create-app so the CLI binary is bundled.
- Updated dependencies
  - @guren/inertia-client@0.1.1-alpha.3

## 0.1.1-alpha.2

### Patch Changes

- Updated the scaffolded app template so new projects pull in the freshly published prerelease.
- Updated dependencies
  - @guren/inertia-client@0.1.1-alpha.2

## 0.1.1-alpha.1

### Patch Changes

- Pinned dependencies to specific versions for consistency across packages
- Updated dependencies
  - @guren/inertia-client@0.1.1-alpha.1

## 0.1.1-alpha.0

### Patch Changes

- 7f52ba4: Add open-source metadata, licensing, and community docs to prepare the packages for an initial public release.
- first release
- Updated dependencies [7f52ba4]
- Updated dependencies
  - @guren/inertia-client@0.1.1-alpha.0
