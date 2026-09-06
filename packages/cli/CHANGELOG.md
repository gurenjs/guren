# @guren/cli

## 2.16.0

### Minor Changes

- 20c2bc7: `make:agent`, and `guren check` now reads the agent registry

  `bunx guren make:agent Triager` scaffolds a durable agent — and, more
  importantly, the two things that make it real: it registers the class in
  `config/agents.ts`, and it extends `guren.arch.ts` with the boundary that keeps
  agent code off your models, `db/`, and `@guren/orm`. An agent acts through the
  tool surface or not at all, and that is now enforced by the existing
  `guren check --arch` gate rather than left to review.

  Both edits go through the AST, and anything it cannot patch is reported with
  the exact text to paste rather than skipped — a class that looks registered and
  is not would deploy as an agent that never runs.

  `guren check` gains an agent-registry check, content-activated so an app
  without `config/agents.ts` is unaffected. It fails on a registry the Cloudflare
  build cannot read statically (a spread, a computed key, a `module` assembled
  from a variable — all valid TypeScript that would leave the deploy with no
  agents mounted), on a `module` that does not exist or does not export the class
  it names, and on a scope a registration may not hold. It warns when an agent is
  scoped to a tool no route declares. Under `--json` the report carries what each
  agent's scopes expand to, recomputed from the route graph on every run.

- 7543926: Link docs to the GitHub issues they belong to (RFC 0018 Part 1)

  A concept document under `docs/` may now declare `issues:` alongside
  `entities:` and `related:`: `issues: [412, "acme/shop#398", https://github.com/acme/shop/pull/9]`.
  The task list, progress and assignee stay on the issue; the document carries
  the decision and this one link, so nothing describing a change is committed to
  the corpus that describes the system.

  - `guren check --docs` warns on an entry in no accepted form. It checks shape
    only and never asks GitHub whether an issue exists, so the gate stays
    deterministic and offline.
  - `guren context <Entity>` ends with a **Linked issues** section (and an
    `issues` array in `--json`): every issue the entity's linked docs declare,
    de-duplicated, each naming the docs that declared it. Read from the
    frontmatter alone; a bare number resolves to the `origin` remote's
    repository when there is one.
  - `make:adr --issue <ref>` (repeatable, or comma-separated) prefills
    `issues:`; a malformed reference fails before anything is written.
  - The docs viewer's detail panel shows the issues as outlinks. They are not
    graph nodes and carry no live state.

- 3ab8169: `guren gate`: one exit-coded verdict on a change

  `bunx guren gate` runs the stages the scaffolded CI runs — codegen, typecheck, lint, `check`
  (the `--ci` rule), `audit`, and the test suite — reports every
  stage, and exits non-zero if any fails. A stage that cannot run (no oxlint
  behind an `.oxlintrc.json`, no `typecheck` script, routes that will not load)
  fails rather than skips; only an app with no `.oxlintrc.json` skips lint.
  `--changed` narrows `check` and lint to the files changed against `main`,
  `--deps` adds the dependency scan to the audit stage, and `--json` returns the
  report. `runGate` and `describeGateFailures` are exported for hooks and tools.

  The Claude Code harness gains a `Stop` hook (`.claude/hooks/gate-on-stop.ts`)
  that runs the gate when a turn ends with uncommitted changes and blocks the stop
  once with the findings, so the fix happens in the same turn rather than in CI.
  `.claude/settings.json` is user-owned, so existing apps add the hook entry by
  hand (or rerun `agent:init --force`); `agent:sync` delivers the hook file. The
  `AGENTS.md` workflow for other agents now ends with the same command.

  The edit hook's `guren check` step now applies the `check --ci` rule (warns
  count, advisory checks do not) instead of reporting failures only, so the three
  places that judge a change — the edit hook, the gate, and CI — agree. The hook
  now reaches its oxlint run through `@guren/cli` as well, and reports a CLI it
  cannot resolve rather than staying silent.

  `guren audit` probes the app's routes entry the way `check` does, so an
  API-only app (`routes/api.ts`, no `routes/web.ts`) is audited without
  `--routes`; the flag still overrides.

- 8d54caf: Stop hooks for Cursor and Codex, and `stopGateFindings`

  `agent:init --target cursor` writes `.cursor/hooks.json` and
  `.cursor/hooks/gate-on-stop.ts`; `--target codex` writes `.codex/hooks.json`
  and `.codex/hooks/gate-on-stop.ts`. Both run `guren gate` when a turn ends
  with uncommitted changes and feed a failing stage's findings back into the
  turn: Cursor as an automatic follow-up message (bounded by `loop_limit`),
  Codex by blocking the stop once, the same contract as the Claude Code hook
  (Codex runs hooks in the session cwd, so its config finds the app's `.codex/`
  upward from there, and runs a project hook only after `/hooks` trusts it).
  Every hook gates the app it is installed in, which a monorepo app makes
  distinct from the git root. A host that loads `.claude/settings.json` without
  speaking its contract (Cursor's third-party setting) is left to its own hook,
  so the gate runs once. `agent:sync` now detects a Codex install by its managed
  hook and refreshes it.

  `.claude/settings.json` is merge-hinted like the MCP configs: an app whose
  settings predate the stop hook is shown the snippet to add.
  The hook configs are user-owned like the MCP configs: an existing file is
  left alone and the snippet to merge is printed. Copilot and OpenCode have no
  turn-end hook that can feed output back, so they stay on the `AGENTS.md`
  instruction to run the gate themselves.

  `stopGateFindings(cwd)` is the shared verdict behind every stop hook: `null`
  when the tree is clean or the gate passes, else the failures as text.

- 634bcda: Report CSRF exemptions in `guren audit`

  `Application.declareCookielessAuthPath()` exempts a path from CSRF
  verification. It is public, so any installed package can call it — and a call
  made from `node_modules` is invisible to review: the audit's source scan never
  reads there, and no CLI command can observe the runtime set, because nothing in
  the CLI boots an application.

  `guren audit` now reports both sides.

  - **Application CSRF exemptions** warns on a call in the app's own source. An
    app author's lever is `csrfOptions.exclude`, which reads as a decision the app
    made; suppress with `// guren-audit-ignore` where the framework method is
    genuinely right.
  - **Plugin CSRF exemptions** reads the JavaScript each Guren-facing _declared_
    dependency ships (one that declares a `gurenPlugin` manifest, or depends on
    `@guren/core`/`@guren/server`) and names every package that declares one. A
    plugin reached only transitively is outside the scan, which reports how many
    packages it covered (`csrfExemptionScan.packagesScanned`) so the scope is
    visible rather than implied.
    A package whose published name is outside the `@guren/` scope is a warning;
    first-party packages are listed without one. Detection is a member call, not
    a mention, so a package that merely names the method in a string or a comment
    is not a declarer. It names packages, never paths — each path is an argument
    computed at boot from that package's own configuration, so no static read can
    know it.

  A dependency that could not be read, or that ships more files than the walk
  covers, is its own warning and reports `csrfExemptionScan.status: 'partial'` in
  `--json` — a package the scan could not finish never reads as one that declares
  nothing. Those coverage warnings carry no security classification, matching how
  the audit already reports its own infrastructure failures.

  `optionalDependencies` now count as declared dependencies wherever the CLI asks
  that question, so `guren plugin`, `guren doctor`'s plugin report and deploy
  target detection see a package declared there too.

### Patch Changes

- 923a3ee: `guren check` reads the agent registry path (`config/agents.ts`) from
  `@guren/core/internal/deploy-build` instead of spelling it itself, so the check
  and `guren cloudflare:build` cannot drift to two different files (RFC 0017 Part 2b).
- 05dfef2: The harness entry document lists the `guren_gate` MCP tool.
- 7fafa9f: Trim the comment `make:agent` writes into `config/agents.ts` to the length the shipped `guren/comment-length` lint rule allows. A scaffolded app installs those rules, so `guren make:agent` followed by `bun run lint` failed on the scaffolder's own output.
- 7fe6749: Print an MCP Inspector invocation `tool:dev` users can actually run

  The command printed `npx @modelcontextprotocol/inspector --cli <endpoint> --transport http --header "Authorization: Bearer <token>"`, which exits on `Method is required` because `--cli` mode has no default method. It now prints `--method tools/list`, pins the spec with `@latest` so the resolution does not fall to whatever version the npx cache already holds, shows the `tools/call` tail, and mentions that dropping `--cli` opens the browser Inspector UI.

- 55137f7: `guren tool:log --surface durable` is now accepted

  `durable` is the surface an agent an application hosts itself records under.
  The flag previously refused it as a typo, which would have made a trail written
  by that surface unreadable through this command.

- Updated dependencies [e94645b]
- Updated dependencies [55137f7]
- Updated dependencies [923a3ee]
- Updated dependencies [05dfef2]
- Updated dependencies [59347c1]
- Updated dependencies [20c2bc7]
  - @guren/server@2.17.0
  - @guren/core@1.14.0

## 2.15.1

### Patch Changes

- 866e773: Declare the three remaining camelCase CLI flags with the kebab-case spelling the
  docs already use, so `--help` and the docs agree.

  `routes:types` and `codegen` declared `pagesOut`, and `audit` declared
  `auditConfig`. citty registers only the _declared_ arg name, so `renderUsage`
  advertised `--pagesOut` and `--auditConfig` while the comments and docs refer to
  `--pages-out` and `--audit-config`. They are now declared `'pages-out'` and
  `'audit-config'`, matching how `token:issue` declares `'read-only'` and
  `'allow-unmatched'`.

  Unlike the boolean rename this fixes no parsing bug: these are string args, and
  citty's args proxy resolves either spelling to the other in both directions, so
  `--pagesOut` and `--pages-out` reach the command identically before and after.
  Only the usage line changes.

  Aliases are deliberately not used for this — `renderUsage` renders an alias
  single-dashed, so `alias: 'pages-out'` would print `-pages-out, --pagesOut`.

## 2.15.0

### Minor Changes

- ae5006a: Add `guren add lint`: writes an `.oxlintrc.json` that loads the Guren rules from `@guren/cli/oxlint` (`guren/await-async-assertion` as an error, the `guren/comment-*` rules as warnings), adds `lint` and `lint:fix` scripts, and adds `oxlint` as a dev dependency on a tilde range (oxlint's JS plugin API is alpha, so only patch updates are admitted). `bunx oxlint` runs under Bun, so an app needs no Node install for it.
- 480144a: Publish the `guren` oxlint plugin as `@guren/cli/oxlint`: `guren/await-async-assertion` (a bare `expect(...).rejects` / `.resolves` statement that can never fail its test) and the `guren/comment-*` rules (block length, banners, step labels, change-history wording, `@param` tags that restate the name). Name it from an app's `.oxlintrc.json` as `"jsPlugins": ["@guren/cli/oxlint"]`.
- 0030f77: Agent harness: a `comments.md` rule (what a comment may carry, the 5/8-line limits, the `oxlint-disable-next-line` escape), a Comments section in the `code-review` subagent's checklist, and a `check-after-edit` hook that also runs oxlint on the edited file when the app has an `.oxlintrc.json` (`bunx guren add lint`), reporting warnings as well as errors back to the agent. Refresh an installed harness with `bunx guren agent:sync`.

### Patch Changes

- 41bc2f4: Declare nine CLI flags with the kebab-case spelling the docs already use, so
  `--help` and the docs agree and the documented spelling parses natively.

  `db:migrate`, `db:seed`, `db:reset`, `db:fresh`, `queue:flush`, `upgrade`,
  `agent:init` and `agent:sync` declared `dryRun`, and `upgrade` declared
  `checkOnly`. citty registers only the _declared_ arg name, so `renderUsage`
  advertised `-d, --dryRun` and `--checkOnly` while every guide documents
  `--dry-run` and `--check-only` — and the documented spelling reached the
  command as the truthy string `"false"` rather than a parsed boolean. They are
  now declared `'dry-run'` and `'check-only'`, matching how `token:issue` already
  declares `'read-only'` and `'allow-unmatched'`.

  No flag is removed: the camelCase spellings still resolve through citty's
  proxy, and the `-d` alias is unchanged. Aliases are deliberately not used for
  this — `renderUsage` renders an alias single-dashed, so `alias: 'dry-run'` would
  print `-dry-run, --dryRun`.

  One user-visible behaviour changes for the better. Mixing two spellings of one
  flag resolves to the declared name rather than to the last one typed, so
  `--dryRun=false --dry-run=true` previously ran a real `db:reset` although the
  user's last word asked for a dry run; the declared name is now the documented
  one, so that invocation dry-runs. The reverse mix is still won by whichever
  spelling is declared, not by argument order.

  `upgrade --no-autofix` is untouched and already correct: it is declared as the
  positive `autofix` arg, because citty's `--no-` branch claims `--no-autofix`
  and writes the key `autofix` whatever the arg is called. A `'no-autofix'`
  declaration would advertise a flag that is still ignored, so that flag is not
  part of this rename.

- ab9ea2e: Read a repeated CLI flag as its last value, on every command.

  citty types a `boolean` arg as `boolean` and hands back an array when the flag
  is passed twice, and every array is truthy. `Boolean(args.json)` reads as safe
  and is not: `guren check --json=false --json=false` turned _off_ into _on_, and
  `--json --json=false` ignored the half typed last. Only the `=value` spellings
  can express a false, so a bare `--json --json` never showed it. A helper fixed
  four commands — `tool:call`, `tool:log`, `token:issue` and `context` — and left
  about fifty reading raw, including `db:migrate`, `db:seed`, `check`, `audit`,
  `doctor`, `config:show` and `schedule:list`.

  The rule now lives in the CLI's own `defineCommand()` wrapper, which normalizes
  the parsed args before `setup` and `run`, so no command can bypass it and the
  per-command helpers are gone. A test gates every built-in command on having
  been defined through it.

  The same pass also gives a declared boolean the type citty gave only its
  declared spelling. citty registers the _declared_ name with its parser, so an
  arg declared `dryRun` and spelled `--dry-run=false` arrived as the string
  `"false"` — truthy. `guren db:migrate --dry-run=false`, `agent:sync
--dry-run=false` and `upgrade --check-only=false` now mean what they say,
  repeated or not.

  Commands contributed by plugins keep citty's own parsing: a repeated flag is
  citty's only multi-value channel, and a plugin may mean its array.

- 8afc342: Trim comments in the agent-catalog inputs to the repository's comment rules. No behavior change; the catalog payload is republished under the new version because its inputs changed.
- d3f190d: Compute `schedule:list` / `schedule:run` "next run" with the scheduler's own cron evaluator.

  The CLI carried a second estimator that ignored the task's timezone, the
  day-of-month / month / day-of-week fields, and any expression it had no branch
  for: `* 3 * * *` fell through and reported "now". `getNextRunTime` now walks
  `parseCron` + `matchesCron` (through `toTimezone` for a timezone-bearing task)
  forward from the next minute, which is the same predicate `ScheduledTask.isDue()`
  fires on, so the listed time is the one the scheduler will actually use. An
  expression that cannot match, or a timezone `Intl` does not know, shows as "-".

- fd6110e: Honor `--no-autofix` on `guren upgrade`.

  The flag was declared as `noAutofix`, but citty's argument parser has a
  dedicated `no-` branch that writes the key with the prefix _stripped_: passing
  `--no-autofix` set `autofix: false` and never set `noAutofix` at all. The
  command read `args.noAutofix`, which the args proxy resolved through `noAutofix`
  then `no-autofix` — neither of which existed — so the flag read as `undefined`
  and `guren upgrade` applied automatic fixes anyway, writing files the user had
  asked it not to touch. Only the `--noAutofix` spelling worked.

  The argument is now declared positively as `autofix` (defaulting to `true`), so
  citty's negation lands on the key the command reads and usage advertises
  `--no-autofix`. `--noAutofix` remains supported, because it is the spelling
  `--help` advertised for as long as it was the only one that worked — treat it as
  a documented alias, not as a shim to drop.

- Updated dependencies [b15c329]
- Updated dependencies [39d4fb2]
- Updated dependencies [154d23b]
- Updated dependencies [e135767]
- Updated dependencies [976bd07]
- Updated dependencies [d525672]
- Updated dependencies [8f6ab47]
- Updated dependencies [78f1a51]
- Updated dependencies [526edd1]
- Updated dependencies [78f1a51]
- Updated dependencies [2b4b542]
- Updated dependencies [3482012]
  - @guren/server@2.16.0
  - @guren/orm@2.6.3
  - @guren/core@1.13.1

## 2.14.0

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

- 0346aeb: Emit `inputSources` and `inputBodyNested` in `.guren/agents.gen.ts` (RFC 0016 §2).

  The manifest carried the merged `inputSchema` but not the inverse of that merge, so a client holding it could only guess which contract each argument came from. Guessing by HTTP method is wrong in both directions: a POST route's `query` keys would land in the body, where `validateQuery` never looks, and a path parameter would be posted instead of substituted into a URL that cannot be built without it.

  `inputSources` records the contract each merged property came from (`params` / `path` / `query` / `body`), and `inputBodyNested` marks a route whose non-object body was nested under a `body` key to give the tool an object root — a client that missed it would post `{ body: [...] }` to a route that validates the array itself. Both come straight off `deriveAgentTools()`, so the manifest and a live adapter still cannot disagree.

  Rendered through the same `__proto__`-safe literal writer as the rest of the manifest: the keys are argument names, and an argument may legally be called `__proto__`.

- c9947b9: Add `guren.preflight`, the preflight companion tool on the App MCP surface (RFC 0016 §5.4).

  Preflight could not be an argument of the tool being checked on MCP. A tool advertising an `outputSchema` must answer with `structuredContent` conforming to it unless the result is an error, and a verdict conforms to no route's output — so a tool that sometimes returned a verdict would sometimes violate its own contract, and reporting "allowed" as an error would be worse than not offering preflight at all. The verdict therefore gets a tool of its own: `guren.preflight`, taking `{ tool, input }` and answering with `{ tool, allowed, status, message }` plus the seam's `validated` / `unverified` and, for a refusal, the application's own `errors`. **One meta-tool for the whole catalogue, not one companion per tool** — per-tool companions double the tool count, against RFC 0016 §5.5's own catalogue-quality rule.

  Nothing about it re-implements a check. It resolves the named tool from the same derived set the endpoint serves and dispatches the same re-entrant request an ordinary call does, with `BuildToolRequestOptions.preflight` set, so the route's real middleware runs and the router's preflight seam stops the chain before the handler. A refusal comes back as a **successful** result carrying `allowed: false`: the caller asked whether the call would be allowed, and "no, here is why" answers that. `validated` and `unverified` are absent, not empty, when the request was refused before it reached the seam — a call stopped by authentication has nothing to report about checks it never reached. A response that is neither a verdict nor a refusal means the handler ran, and is reported as an error rather than as a rehearsal that did not happen.

  Checking a tool requires the **same scope** as calling it, or the companion becomes a way to probe the authorization surface of tools the token cannot call; an ungranted name produces the same `AgentToolDenied` (`reason: 'scope'`, naming the checked tool) a direct call would. A tool declaring `approval: 'required'` **is** checkable although it is not callable — that is exactly when "would this be accepted?" is worth asking, and the rehearsal executes nothing. `guren.preflight` is listed only for a token that grants at least one tool, since a token that can call nothing has nothing to rehearse and listing it would map the surface to a caller with no access to it. The call is audited as an `AgentToolInvoked` with `tool: 'guren.preflight'` — an agent probing what it may do is what an audit trail wants to show — recorded under the _checked_ tool's `redact` list, because the arguments being written down are that tool's. The checked tool gets no record: nothing was invoked.

  `@guren/server` exports `PREFLIGHT_TOOL_NAME`, `RESERVED_AGENT_TOOL_NAMES` and `isReservedAgentToolName` — one list with two readers. `guren check` **fails** an agent route whose tool name claims a reserved one (`agent-route-reserved-name:*`), and the endpoint drops such a route rather than serving two tools under one name, which an MCP client answers by rejecting the entire catalogue. Restating the name in either place is how the check comes to keep passing a route the endpoint has already shadowed.

- 2baf014: Stop the attachments scaffold from storing uploads inside the statically served tree, and add a `guren check` rule for apps already in that shape.

  `guren add attachments` used to configure `disk: 'public'`, which the storage scaffold roots at `./public/storage` — inside the directory the root asset server serves. Uploaded bytes were therefore reachable as static assets, by extension, with the content type that matches: an uploaded `.svg` came back as `image/svg+xml`, inline, and its script ran on the app's own origin with the app's own cookies. RFC 0015 already built the way out; the scaffold just did not take it.

  - The scaffolded `config/attachments.ts` now stores new attachments on the private `local` disk (`./storage/app`, outside `public/`) and enables the signed delivery route with `delivery: {}`. That route serves only an allowlist of content types inline, forces a download for everything else, and adds `nosniff` plus a `Content-Security-Policy: sandbox`.
  - `guren add attachments` mounts that route, calling `registerAttachmentRoutes(router)` from the app's route registrar. The entry file is probed from the routes-entry candidates rather than assumed, because attachments work on an API-only app, which ships `routes/api.ts` and no `routes/web.ts`. Unmounted, every attachment URL would 404 — and a delivery failure is a uniform 404 by design, so nothing at runtime would name the cause.
  - New `guren check` rule `attachments-public-disk`: `configureAttachments({ disk })` resolving to a `local` disk whose declared `root` is at or below the app's `public/` directory now fails. This is what tells an app scaffolded before this change that it is still in the old shape; nothing at runtime reports it, because serving the file is the intended behaviour of the disk it was put on. Positive evidence only — a non-`local` driver, a computed `root`, or two declarations disagreeing about one are skipped rather than guessed at, since the rule fails a build.
  - The attachments scans now see through transparent TypeScript wrapping (`as const`, `satisfies`, `!`, `<T>x`) wherever they judge a node's shape. Three spellings of that unwrap had drifted apart across the package (covering 2, 4, and 5 node types), so `@guren/cli`'s `ast-walk` module gains `unwrapTypeAssertion` and `objectLiteral` as the one rule, and `model-parser` and `schema-parser` now call it too.

    This is a behaviour fix, not tidying. The scaffolded `StorageProvider` ends its `disks` map with `as const`, so the `serve: 'redirect'` rule had never once read a real scaffolded app; and `configureAttachments({ … } satisfies T)` made _every_ attachments rule return nothing at all, because the shared entry scan tested for `ObjectExpression` without unwrapping. Both failed silently, since a scan that cannot read a config and a config with nothing to flag produce the same empty result.

  Existing apps are not rewritten. An app that wants the old behaviour keeps it by leaving its config alone and is told so by name; an app that wants the new shape moves `disk` to a disk rooted outside `public/`, declares it private in `disks`, and adds `delivery: {}` plus `registerAttachmentRoutes(router)`. `examples/blog` is one of those apps and now fails this rule; migrating it changes the attachment URLs its pages and E2E specs assert against, so it is tracked separately.

### Patch Changes

- 0a5dd3c: Export `DEFAULT_DELIVERY_ROUTE_NAME` from `@guren/core`.

  The delivery route's default name is a cross-package contract: `guren check`'s
  attachments rules judge, from another package, whether the name the delivery
  route registers under is claimed by more than one route. That rule kept its own
  copy of `'attachments.show'`, which would not have failed loudly if the
  framework's default moved — it would have stopped matching the route that was
  actually registered and reported a genuine collision as fine. The check now
  imports the constant instead of restating it.

- 8c15984: Fix five ways the attachments check and its scaffold misjudged real apps.

  All five were found by review after the rule shipped, and all five are silent by construction — the scans report "cannot read this" and "nothing to flag" as the same empty result, so each one looked like a clean app.

  - **An API-only app failed `guren check` immediately after `guren add attachments` ran.** The scaffolder mounts the delivery route in `routes/api.ts`, but the delivery rule fell back to `routes/web.ts`, found no entry file, and treated that as positive evidence nothing could have mounted the route. `route-registrar` now owns `resolveRoutesEntry()`, and the rule, both `doctor` probes and `routes-check` all resolve the entry through it instead of open-coding the probe with four different not-found policies.
  - **`as const` on a string switched the disk rule off.** `literalString()` read the assertion node rather than the literal under it, so `disk: 'media' as const` or `root: './public/uploads' satisfies string` answered "no value declared" — indistinguishable from a dynamic value, so the rule withdrew. It now unwraps, one level below the object unwrapping added with the rule.
  - **A disk symlinked into the served tree passed.** The containment test was lexical, but `guren storage:link` symlinks `public/storage` to `storage/app/public` and the storage guide documented `local` rooted at exactly that path — so an app that followed the documentation had its uploads statically reachable and was told it was fine. Containment now canonicalizes both sides and reads the served directory's own entries, judged against the `attachments/` prefix the engine actually writes to (so the scaffold's own root, which `storage:link` does not expose, is not falsely failed).
  - **The storage guide documented a shape `guren add storage` no longer scaffolds**, which is what made the previous item reachable. Both locales now show the scaffold's actual disks and carry an explicit warning against rooting an upload disk anywhere the served tree exposes.
  - **Re-running a scaffolder could emit a duplicate import.** `insertImport()` tested for its own exact statement, so a binding merged into a neighbouring import — the idiomatic form, and what any formatter produces — read as absent and a second `import { x } from 'y'` was appended, breaking compilation. It now decides on the AST: a name counts only when the module imports it as a value under its own name, so a commented-out or template-literal lookalike, a `type`-only import, and `X as wanted` (which binds the name from a different symbol) all still insert.
  - **The route graph `guren check` loads once and shares was itself read from `routes/web.ts`.** On an API-only app that left the agent-manifest, route-contract and agent-route checks judging a file the app never had, and the attachments delivery rule loaded the app's module a second time — two loads that could resolve different entries and disagree, in one run, about what the app mounted. The graph now resolves the entry the same way and the delivery rule reads its definitions.

  The rule's failure message and the scaffold's comment no longer claim stored XSS. Document content types served out of `public/` are forced to download since the `static-documents` guard landed, so that claim would have been untrue — and a build-failing rule must not assert something the framework stopped doing. What the rule reports instead is the access-control half the guard never addressed: bytes reachable by URL with no signature, no expiry and no authorization check, with the XSS case returning wholesale under `rootPublicAssets: { inlineDocuments: true }`.

- 29c4887: Fix two `guren check` scans that silently misread config wrapped in a transparent TypeScript assertion.

  Both read a call argument positionally and tested it for `ObjectExpression` without unwrapping first, so `satisfies` or `as const` around the object made the whole declaration invisible. That failure is silent by construction: these scans report "cannot read this" and "nothing to flag" as the same empty result.

  - Route registrar wiring read `defineModule({ … })` bare, so `defineModule({ … } satisfies ModuleDefinition)` looked like a module with no descriptor at all. The scope then fell back to the conventional `modules/<name>/routes.ts`, and a module whose registrar lives anywhere else — `routes/index.ts`, say — had its whole routes directory reported as unmounted.
  - The deploy-runtime scan read `createApp({ … })` the same way, so `createApp({ auth: {} } satisfies AppOptions)` dropped the session signal and the app passed the backed-session-store check instead of being warned. The file's generic identifier scan already walked through these wrappers; only this positional read did not.

  Both now go through `objectLiteral()` from `ast-walk`, the one rule for reading an object literal through transparent wrapping.

- 7e4aed6: Fix the CLI reads that silently misread source wrapped in a transparent TypeScript assertion.

  Each tested a node's shape (`ObjectExpression`, `ArrayExpression`) without unwrapping `as const` / `satisfies` / `!` / `<T>x` first, so a wrapper made the declaration invisible. The failure is silent by construction: these scans report "cannot read this" and "nothing to flag" as the same empty result.

  - `defineModel(users, { … } satisfies ModelOptions)` dropped every option at once, so `guren audit` reported a model with a `fillable` allowlist as having none, and a wrapped `base: AuthenticatableModel` lost its authentication classification.
  - A string-array config read as unreadable when the array itself carried the wrapper — `static fillable = ['title'] as const`, the idiomatic spelling — with the same consequences plus a skipped denied-credential-column check.
  - A wrapped drizzle column map made the whole table invisible to `parseSchemaTables`, and so to the schema checks, attachments table bindings, `make:feature`, and `guren context`. Wrapped column options read as opaque, so `timestamp('created_at', { withTimezone: false } as const)` skipped the Postgres `timestamptz` warning instead of earning it.
  - `broadcast('c', 'e', { id: 1 } as const)` rendered as `unknown` in `.guren/channels.gen.ts`, typing every listener's argument as unusable rather than as the shape it carries. A wrapped _name_ in the same call was worse still — the channel vanished from the generated types entirely — though that half is already fixed on main; a regression test now pins it.
  - `export default { … } as const` was absent from the inert-default-export set, so a shared-constants module was treated as possibly holding a console command and drew a registration warning nothing could resolve.
  - `mcpPlugin({ … } satisfies McpPluginOptions)` read as unreadable, and that scan's positive-evidence-only rule turned it into silence — an agent route requiring approval went unreported despite having nowhere to queue it.

  A review sweep of the same files found more of the same class, now fixed too: a `defineModel` `base:` option, a `static passwordHashField = '…' as const`, the entries of a wrapped allowlist array, a relationship name, and the drizzle table and column names — a lost column name made the `timestamptz` warning cite the property instead of the SQL column and drop its `USING` hint.

  Two widenings the unwrap could otherwise have caused are closed in the same pass. A `fillable: undefined as string[] | undefined` still reads as the absent option it is, rather than as mass-assignment protection the runtime does not apply. And a drizzle options object carrying a spread now reads as unreadable whether or not it is wrapped — `timestamp('c', { ...SHARED })` may well set `withTimezone`, so concluding "unset" warns about a column that was already right.

  All now go through `objectLiteral()` / `literalString()` / `unwrapTypeAssertion()` from `ast-walk`, the one rule for reading through transparent wrapping. That rule also gains its first direct tests: five wrapper spellings were handled but only two were exercised anywhere, and `ParenthesizedExpression` was unreachable through the shared parser's plugin set at all.

- Updated dependencies [09c56ce]
- Updated dependencies [e4b1ba4]
- Updated dependencies [1fbbb04]
- Updated dependencies [0346aeb]
- Updated dependencies [c9947b9]
- Updated dependencies [0346aeb]
- Updated dependencies [0a5dd3c]
- Updated dependencies [39db410]
- Updated dependencies [bf4020f]
- Updated dependencies [691f12a]
- Updated dependencies [1eb4303]
- Updated dependencies [58f2835]
- Updated dependencies [cfef2ad]
- Updated dependencies [7bcd5d6]
- Updated dependencies [202cd67]
- Updated dependencies [a6e3a1f]
- Updated dependencies [4831473]
- Updated dependencies [1414267]
- Updated dependencies [202cd67]
- Updated dependencies [0076c39]
  - @guren/server@2.15.0
  - @guren/core@1.13.0
  - @guren/orm@2.6.2

## 2.13.0

### Minor Changes

- e72244a: Check, audit, and context support for agent-exposed routes (RFC 0016 Phase 1c).

  - `guren check` gains agent-route rules, running in the normal suite for any app whose routes declare `.agent()` metadata (an app with none contributes nothing). Failures: a route with agent metadata and no name (the tool name is the tool's identity), a tool name outside the MCP grammar `^[A-Za-z0-9._-]{1,128}$`, two routes resolving to one tool name, and a non-read-only tool with neither an authorization capability on its middleware chain nor `this.authorize(...)` in the action — authentication is not authorization, so `this.auth.userOrFail()` or an API-token check still fails, with its own message. Warnings: a route that declares no output schema or resource hint, an action that answers with `this.inertia(...)`, a body-carrying route with no `body` schema, a read-only tool whose action deletes, updates, or force-writes records (both an explicit `readOnlyHint: true` on a mutating verb and the GET/QUERY default — read-only is what exempts a route from the authorization rule, so it is held against the body), a controller file that could not be read at all, and any verdict the check could not reach because the handler body is one it does not read — an inline handler, or a controller outside the sources it scans. A routes file that fails to load is reported once, as `route-graph`, for the route-contract and agent-route checks together.
  - `guren audit` treats agent-exposed routes more strictly: a body-validation finding that is a warning for an ordinary route becomes a failure when the route is an agent tool (same finding key, so existing `config/audit.ts` entries keep applying). New `agent-annotation:` rule: `destructiveHint: false` declared on an action that deletes, updates, or force-writes records warns, as does the same claim over an action body the audit could not read; a controller file that could not be read is reported as `controller-unreadable:`.
  - `guren context <Entity>` gains an `## Agent Interfaces` section describing each agent-declared route as the tool it becomes (name, description, input parts, output, authorization, annotations, approval). `ContextRoute` carries the declared `agent` metadata and a derived `authorization` field, which names an ability only when the middleware chain makes exactly one derivable.
  - The coding-agent harness gains an `agent-interface` skill, plus `.agent()` coverage in the routing rule file and the API digest. `CONTEXT_ROUTE_FEATURES` is exported so a consumer resolving this package from an app — the development MCP endpoint does — can tell "this app exposes no agent tools" from "this CLI is too old to answer".

- 327b4b5: Generate the agent tool manifest, and inspect it from the CLI (RFC 0016 PR-1b).

  - `guren codegen` writes `.guren/agents.gen.ts` for apps whose routes declare `.agent()` metadata, between the data types and the API client. Every tool is derived through `deriveAgentTools()` — the same call a protocol adapter makes — so the manifest and a live server cannot disagree about a tool's name, schemas, or exposure. What codegen adds is the half only the CLI can see: a route's `resource` hint carries a Resource _class name_, so the payload type behind it is appended to the tool description and emitted as a `Data.*` reference in `AgentToolOutputTypes`. Apps with no agent routes get no file, and a previously generated one is removed.
  - `guren tool:list` prints the tools an app exposes (method, path, MCP/WebMCP exposure, ability, annotations); `guren tool:inspect <name>` shows one tool's full derivation. Both derive live from the route graph rather than reading the manifest, so a stale or absent one cannot answer for what an agent would see. `--json` on either.
  - `guren check` and `guren doctor` account for `.guren/agents.gen.ts` conditionally, and in both directions: the manifest is expected when the derivation yields at least one tool, and a file left behind after the last `.agent()` was removed is reported as stale rather than passing green. Both findings name `guren codegen`, which is the command that resolves either — so the remedy always clears the state it was printed for.

- a259c3b: Add `guren tool:call` and `TestApp.agent()` for invoking agent tools (RFC 0016 §6)

  `guren tool:call <name> --input '{"title":"x"}'` boots the application and
  invokes one agent tool through the framework's own dispatch contract — the same
  derivation, request building and response mapping an MCP client's call goes
  through, so there is no CLI-only code path to drift. Its tools come from the
  booted app's route graph rather than a routes file, so a tool it can name is a
  tool it can reach. `--as user:42` authenticates the call (development only: it
  sets `GUREN_TESTING=1` for the process, and says so), `--preflight` asks for a
  verdict instead of an execution, and `--json` emits a machine-readable result.
  A call that comes back as an error result exits non-zero.

  `@guren/testing` gains `app.agent()`: `call(name, input, { as, preflight })`
  returns a result carrying `assertOk`, `assertStatus`, `assertDenied` and
  `assertStructured<T>()`, chainable on the pending call like every other
  `TestApp` request, plus `tools()` for the derived catalog. Calls inherit the
  app's standing headers, so `(await app.withCsrf()).agent()` composes.
  `TestApp.fromFetch()` and `fromWorkers()` carry no route graph and say which
  constructor to use instead of reporting an empty tool list.

- a748a05: Add `guren token:issue`, which mints an API token scoped to the agent tools an app exposes (RFC 0016 §5.1).

  ```
  guren token:issue --name ci-agent --user 42 --tools 'posts.*' --read-only --expires 30d
  ```

  `--tools` takes a comma-separated list of full scopes (`tool:posts.store`, `tools:read`, `tools:*`, `tools:posts.*`) or their shorthands (`posts.store`, `read`, `*`, `posts.*`). The tool list every scope is judged against is derived live from the route graph — the same `deriveAgentTools()` call `tool:list` and a running adapter make — so what the command prints is what a dispatcher will honour.

  This is the issuer half of the split the scope grammar describes: a token guard must grant less on anything it cannot parse, so it ignores a malformed ability silently, while here the same entry is a typo a human is still looking at. Every refusal happens before anything is written:

  - a scope the grammar cannot parse is rejected by name, showing how a shorthand was read when that differs from what was typed;
  - a scope matching no current tool is rejected too — it is either a typo or a _latent grant_, a stored pattern that would activate with no further consent the moment a matching tool is added. `--allow-unmatched` accepts one deliberately and warns in exactly those terms;
  - `tools:*` requires `--yes`;
  - `--expires` accepts `30d` / `12h` / `45m` and refuses both zero and a duration past the Date range — either end mints a token every expiry check reads as already expired. Omitting it issues a non-expiring token and warns.
  - an empty `--user` or `--name` is refused, which a `required` flag alone does not catch: a token with no user authenticates as nobody, and one with no name is unidentifiable when someone comes to revoke it.

  `--read-only` intersects the grant with the read-only tools and stores the concrete `tool:<name>` entries it resolved to, never the pattern: the grammar has no "read-only subset of `posts.*`" form, so a concrete list is the only faithful encoding — and it is fail-closed, since a write tool later joining that family joins no stored entry. Under `--read-only` a scope resolving only to write tools is refused rather than silently dropped, `--allow-unmatched` included: concrete entries cannot activate later, so that combination could not keep the flag's promise.

  A grant covering both read-only and write tools warns about the lethal-trifecta shape without refusing it. `--json` emits one machine-readable object carrying the token, the granted tools split read/write, and the warnings. The plain token is printed once and stored hashed.

  Repeated flags are read last-wins throughout: citty arrays a repeated flag and an array is truthy, so `--yes=false --yes=false` would otherwise authorize a `tools:*` grant the user twice declined, and a repeated `--user` would be stored comma-joined as a principal nobody is. `--user` keeps a digit string that is not its own numeric spelling (`0042` stays a string; `42` becomes a number for a serial key). `--app` now resolves the application entry from the root it names, so the token lands in the store of the same app its tools were derived from. Only tools exposed on MCP count toward a grant — a bearer token reaches no other surface. An application whose `boot()` rejects fails the command instead of minting against a half-configured store.

- ea515ae: Add `guren tool:dev`, which serves this application's agent tools locally with a throwaway bearer token and prints the MCP Inspector invocation that connects to it (RFC 0016 §6).

  The endpoint is the application's own — the command mounts nothing and inspects nothing. What it adds is the one thing that makes the real endpoint awkward to try: a token, without asking anyone to mint a lasting credential to look at a catalogue.

  The token is ephemeral by construction rather than by policy. It is issued into a `MemoryApiTokenStore` the command creates and then installs over whatever store the app configured, so nothing is written to the app's real store and nothing survives the process — "revoking" it is exiting. The override works because `@guren/plugin-mcp` resolves the store per request rather than at boot.

  Before printing anything the command asks the running app whether the endpoint is really there: a mounted one answers 401 without a bearer, an app that never registered the plugin answers 404, so a missing `mcpPlugin()` is named as such instead of surfacing later as a confusing client error. `--path` covers a plugin mounted elsewhere, `--as <id>` picks the user tool calls authenticate as (the default is a placeholder matching no record, so listing works and a call whose policy loads a user fails visibly), and the command refuses to run with `NODE_ENV=production`.

### Patch Changes

- 8f43757: Correct the agent-interface skill's account of what ships. It told every scaffolded app that `expose`, `approval`, and `redact` were "recorded now; acted on when those surfaces ship" — `@guren/plugin-mcp` honours all three today, hiding unexposed tools, refusing approval-required ones fail-closed, and masking the named fields in the audit events. Two things in that table genuinely have not shipped — `expose.webMcp` and the approval _queue_ — and the skill now names those two instead of disclaiming the whole set.
- 51e5d6a: Controller actions written as class fields (`store = async () => {}`, `show = () => this.inertia(...)`) are now recognised everywhere the CLI reads a controller.

  `Router` dispatches to a function-valued class field exactly as it does to a method declaration, but four of the five class-member walks in the CLI tested only for a method declaration. `guren check` and `guren doctor --next` never reported an empty field action, `guren context <Entity>` left one out of the bundle entirely with nothing to say it had been skipped, and `spec:generate`'s screens view attributed the page such an action renders to no route at all. All five now share one answer to which members of a controller are actions, and member names are read through the same rule the rest of the CLI uses — so a quoted key (`'store'() {}`) counts, and a computed one (`[store]() {}`) is skipped rather than guessed at from its literal text.

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

- Updated dependencies [8f43757]
- Updated dependencies [0cf0260]
- Updated dependencies [a3a96ae]
- Updated dependencies [e72244a]
- Updated dependencies [327b4b5]
- Updated dependencies [ea515ae]
- Updated dependencies [5cbccb0]
- Updated dependencies [a9077f4]
- Updated dependencies [ec10be6]
- Updated dependencies [a259c3b]
- Updated dependencies [15f969a]
- Updated dependencies [1161036]
- Updated dependencies [bc70b7f]
- Updated dependencies [3b55863]
- Updated dependencies [cfb4a8d]
- Updated dependencies [89aa23f]
- Updated dependencies [1218a8a]
- Updated dependencies [9e19202]
- Updated dependencies [4335cbc]
  - @guren/server@2.14.0
  - @guren/core@1.12.0

## 2.12.0

### Minor Changes

- 677b4c8: Add attachments codegen (RFC 0013 Open Question 4, RFC 0010 §2): `guren
codegen` now reads each model's `Attachable(...)` declaration and emits
  `.guren/attachments.gen.ts` with `AttachmentsMap` (collection name → 'one' |
  'many', keyed by model class name) and `AttachmentVariantsMap` (declared
  variant names per collection). Apps without Attachable models get no file —
  a stale one is removed — and a declaration that cannot be statically read is
  skipped with a warning rather than emitted partially. The Vite plugin
  regenerates the map when `app/Models/**` (or a module's) changes, `guren
context <Entity>` lists the entity's attachment collections, and `guren
check` flags models mixing in `Attachable(...)` in an app with no
  `configureAttachments()` call.
- f6037db: Delivery-route wiring checks (RFC 0015 Part 4). `guren check` now flags a
  `configureAttachments({ delivery })` with no `registerAttachmentRoutes()`
  route in the loaded route definitions — private attachment URLs would be
  minted that 404, and every delivery failure is a uniform 404 by design —
  and a `serve: 'redirect'` disk whose storage config declares a driver
  that can never presign (`local`, `memory`), which at serve time silently
  downgrades to proxy. Both judged on positive evidence only; anything not
  statically readable is skipped, never guessed. The attachments scaffold's
  config comment now points at the delivery route.

### Patch Changes

- 0096603: fix(cli): `agent:sync --prune` no longer deletes rules files your project wrote

  `.claude/rules/` and `.agents/rules/` were claimed as whole directories, so
  `--prune` removed any file there the current harness does not ship — including
  the project's own conventions file, which is exactly what the same command's
  output tells you to keep ("keep project-specific rules in files of your own").

  The claim is now by rule filename, the way skills have been claimed since
  v2.9.0: only the rule files the harness ships, plus the filenames earlier
  harness versions shipped, are reported or removed. A rules file of your own,
  including one in a subdirectory, is left alone and no longer listed at all.

  Renamed framework rules are still cleaned up: the native `guren-*` copies by
  their prefix, and the copies in the canonical roots under the names past
  releases wrote.

- Updated dependencies [36257a7]
- Updated dependencies [fa7e6c7]
  - @guren/server@2.13.0
  - @guren/core@1.11.0

## 2.11.0

### Minor Changes

- a19ff6f: Add the `guren add attachments` blueprint (RFC 0013 Part 4): appends the
  attachments table to `db/schema.ts` for the app's dialect, writes
  `config/attachments.ts` and an `AttachmentsProvider` that wires
  `configureAttachments()` at boot, registers the `attachments:prune`
  console command, and installs the storage blueprint first when the app has
  no `StorageProvider`.
- 6fc3156: Restyle the `make:auth` and `make:feature` scaffold output with the Guren UI design tokens: pages render in the guren.dev light/dark themes via `bg-g-*` / `text-g-*` utilities, flash and error messages become diagnostic rows, and the destructive delete action is an outline + confirm instead of red text. Both commands now ensure the app carries `resources/css/guren.css` and its `app.css` import (idempotent — apps scaffolded by create-guren-app ship them already). The blog blueprint's dashboard page moves in lockstep.
- d8abe78: Add `guren make:feature --attach "cover:one,images:many"` (RFC 0013 Part 4):
  wraps the generated model in the `Attachable` mixin (`hasOneAttached` /
  `hasManyAttached` with `image: 'require'`), wires the store action to read
  uploads via `this.file()` / `this.files()` and `Model.attach()`, and makes
  the destroy action call `Model.purgeAttachments()` before deleting the row —
  deletion is explicit because the polymorphic attachment rows carry no foreign
  key. The flag is refused, with guidance to run `guren add attachments` first,
  when the app has no `configureAttachments()`. `guren add resource` passes
  `--attach` through.

### Patch Changes

- Updated dependencies [104c9b6]
- Updated dependencies [d1b1eb6]
- Updated dependencies [451755c]
  - @guren/server@2.12.0
  - @guren/core@1.10.0

## 2.10.0

### Minor Changes

- b637f7e: Teach the agent commands about attachments (RFC 0013 Part 3):
  `guren check` now fails when `configureAttachments()` binds a table its
  `db/schema.ts` does not export (the layer takes the table untyped, so this
  otherwise only surfaces at runtime), and `guren audit` recognizes uploads
  handed to a typed `attach()` as validated by the attachment declaration's
  pipeline instead of demanding `validateBody()` for them.
- 4fd7ca9: Emit payload types data.gen.ts cannot copy as import-type references

  A Resource whose payload type is exported but has no copyable object body — a
  `z.infer<typeof Schema>` alias, an intersection, a merged interface — is now
  emitted as `export type X = import('../app/Http/Resources/XResource').XData`
  instead of being omitted with a warning. One zod schema can therefore serve as
  the single source of truth for a route's `output:` contract and its Resource's
  `Data.*` type. Unexported and generic declarations stay refused; the
  unexported warning now says that exporting the declaration fixes it.

- ca7f360: Stop casting record columns in scaffolded resources

  `make:feature`, `guren add resource` and `make:resource` wrote
  `id: this.resource.id as number` and `title: this.resource.title as string`
  into every generated resource. The record is `typeof table.$inferSelect`, so
  each column is already typed and the casts only hid mistakes: `as string` on a
  column that is later made nullable swallows the `null` while the resource keeps
  compiling, and `as number` hard-codes a primary key an app with a UUID does not
  have. The key's type is now read off the record (`id: PostRecord['id']`).

  `json` columns keep their assertion, in every dialect: `jsonb()`, `json()` and
  `text({ mode: 'json' })` all infer `unknown` unless the schema pins a `$type`.

  Generated resources also declare their payload as the `Resource` class's second
  type argument instead of overriding `toJSON()` to cast. That argument arrives in
  the `@guren/core` released alongside this one, so upgrade `@guren/core` and
  `@guren/cli` together — `bunx guren upgrade` does that, and a lone CLI upgrade
  would scaffold a resource the installed core cannot type.

### Patch Changes

- Updated dependencies [6832953]
- Updated dependencies [02930f4]
- Updated dependencies [b637f7e]
- Updated dependencies [ca7f360]
  - @guren/core@1.9.0
  - @guren/server@2.11.0

## 2.9.1

### Patch Changes

- 7d7ded5: Declare the optional siblings these packages import so their types stop being `any`.

  `@guren/cli` reaches `@guren/openapi`, and `@guren/testing` reaches `@guren/core`,
  through a dynamic `import()` only. Neither was declared, so under each package's
  `tsconfig.build.json` (which clears `paths` so the declaration emitter cannot
  write stray `.d.ts` files beside a sibling's source) the specifier was
  unresolvable, the import was silenced with `@ts-ignore`, and everything inferred
  from it degraded to `any`.

  Both are now declared as **optional peer dependencies**, which resolves them to
  the sibling's real declarations. Neither npm nor bun installs an optional peer
  automatically, so nothing changes about what an app installs — but an app that
  does have the sibling now gets it type-checked, and the mismatch this surfaced
  in `@guren/testing` (its structural `Application` constructor type disagreed
  with the real one about `providers`) is fixed rather than hidden.

- 8871c4c: Build with tsdown instead of tsup, and emit declarations with the native TypeScript 7 compiler. The public file layout of every package is unchanged (same `dist/*.js` / `dist/*.d.ts` entry names, shebangs, and `exports`); only the internal chunk names differ. tsup is unmaintained and its declaration bundler needs the JavaScript compiler API that TypeScript 7 no longer ships.
- 49f7edb: Keep scaffolded apps and the framework compiling under TypeScript 7.

  - Scaffolded `tsconfig.json` no longer sets `baseUrl`, which TypeScript 7 rejects (TS5102); `paths` already resolves from the tsconfig directory without it.
  - `guren doctor` warns on a root `baseUrl` (TypeScript 7 rejects it), and its autofix removes one while adding the `@/*` alias.
  - A `resources/js/vite-env.d.ts` declares the virtual `@vite/client` module, since TypeScript 6+ checks that side-effect imports resolve.
  - The dev banner's JSON import uses the standard `with { type: 'json' }` attribute instead of the removed `assert` form.

- c7626e7: Recognize every spelling of a project-root `baseUrl` in `guren doctor`

  The tsconfig alias check compared `baseUrl` against the literals `"."` and
  `"./"`, so a root `baseUrl` written any other way — an absolute path equal to
  the project root, `"./."`, or `""` — fell into the "repoints the alias" branch.
  That reported the wrong cause and turned the autofix off, leaving behind a
  `baseUrl` TypeScript 7 rejects (TS5102). The comparison now resolves both paths
  instead of enumerating spellings.

- Updated dependencies [deaa5c0]
- Updated dependencies [8871c4c]
- Updated dependencies [49f7edb]
  - @guren/server@2.10.1
  - @guren/core@1.8.1
  - @guren/orm@2.6.1

## 2.9.0

### Minor Changes

- 7ad63f0: Report a routes or health file that could not be read, instead of an empty result

  `guren context` rendered `## Routes (0)` / `No routes loaded.` and exited 0
  whether the app had no routes or its routes file had thrown on import —
  `loadContextRoutes` caught every failure and returned `[]` with no message.
  The reason is now carried on `ProjectContext.routesError`, printed under the
  Routes heading, and included in `--json`. A routes file that is simply absent
  is still not an error: an api-only or mid-scaffold app legitimately has none.
  `guren context <Entity>` now makes the same distinction, which it did not
  after #482 — it reported a missing routes file as one that could not be read.

  Every loader that degrades a missing file to an empty result now shares one
  rule for what "missing" means, `isDefinitelyAbsent()`. `fileExists` rethrows
  anything that is not `ENOENT`, so a `routes` that is a regular file crashed
  `guren context`, `guren context <Entity>` and `spec:generate`/`check --spec`
  outright; `existsSync` does the opposite and answers "no", so a dangling
  `app/health.ts` or `guren.arch.ts` symlink was silently ignored and the
  command reported a clean result from a configuration it never read. Only
  `ENOENT` now means absent; everything else reaches the loader, whose error is
  what gets reported. Adopted by the three routes callers and by health,
  `guren.arch.ts`, and `config/audit.ts` discovery. Absence stays silent only on
  the _default_ path: a `--routes` or `--health` the caller named is a typo or a
  wrong app root when it is not there, and is reported like any other unreadable
  file.

  `fileExists` keeps the old semantics at its remaining call sites, and two of
  them are worth naming rather than leaving to be rediscovered. Inside
  `guren check`, `route-path-check.ts` skips its scan on a file it reads as
  absent, while `console-check.ts` and `routes-check.ts` already report — but
  report the wrong reason, telling you to create a file you can `ls`; all three
  also still crash outright on a non-ENOENT probe. And `app-surface.ts` reads a
  dangling `routes/web.ts` as the negative evidence that an app cannot render a
  page, which is the expensive direction for a rule its own doc says must run on
  positive evidence only. They are left for one change together, since the
  question of whether a skipped scan belongs in the report is worth settling
  first.

  `guren health:check` had the same shape with worse output: a health file that
  existed and failed to import was logged at debug level (invisible by default)
  and reported as "No health manager found", followed by instructions to create
  the file the user already has — while `--json` answered `"status": "healthy"`
  off the built-in memory and uptime checks. It now names the file and the
  reason, carries a failing `health-config` check into the report, and exits 1.
  An explicit `--health <path>` that does not exist, or that imports cleanly and
  exports no recognizable manager, is reported the same way: the user named that
  file, so anything stopping it from yielding a manager is a failure rather than
  a search miss. The default candidate list stays a search, and is now deduped
  by canonical path so a case-insensitive filesystem cannot report one file
  twice — including when that file is a dangling symlink, where `realpath`
  cannot answer and the link's own inode identifies it instead. A file exporting
  both a placeholder `health` and a real `healthManager` now finds the real one:
  the export was picked by truthiness and only then tested for shape, so its
  checks never ran. A load failure is reported even when a _later_ candidate
  does yield a manager, so a broken `app/health.ts` beside a working leftover no
  longer answers `"status": "healthy"`. And `--health` with an empty value is
  treated as no flag at all: the mode switch and the path list read it
  differently, so `--health=` applied named-file strictness to the default
  search and failed an app that passes without the flag. `--json` no longer
  prints its console prose to stdout either — that prose was landing in front of
  the document, so the output only parsed when something else had already
  silenced consola. And a report from the app's own manager is normalized before
  it is rendered or added to: nothing type-checks what crosses the `import()`
  boundary, and one without a `checks` array used to kill the command outright.

  Test fixtures are written into temp directories with no `node_modules`, where
  Bun's last resort for a bare specifier is to install it — from the global
  cache, and from npm on a miss. Auto-install is now disabled in each fixture,
  so one that needs `@guren/*` links the workspace copy explicitly rather than
  silently binding the published one.

- fc15bb8: Add a route contract check to `guren check`: a `params` schema key or a `bind` key that names a parameter its route path never declares.

  Both are silent today. A required `params` key the path cannot supply makes every request to that route fail validation with a 422 before the handler runs; an optional or defaulted one never fails at all, and quietly hands the controller `undefined` or a schema default in place of a value from the URL. A `bind` key with no matching path parameter is skipped when the request is resolved, and the controller's `this.model()` then throws `No model binding found` — at request time, from a route that type-checks.

  The check reads _registered_ route definitions rather than the routes file's AST, because the path a route registers is the joined one (`group()` prefixes and `resource()` expansions already applied) and a params schema is usually imported from somewhere the routes file does not spell out. A required stray key reports as a failure, an omissible one as a warning, and a schema whose shape cannot be read reports as a stated skip rather than passing silently. Only the direction that is always a defect is reported: a path parameter the schema leaves out is harmless, since zod strips what it does not declare.

  Plain `guren check` still sets no exit code, as it never has; `guren check --ci` gates on these results along with the rest of the suite.

## 2.8.0

### Minor Changes

- f6f16fd: `guren agent:sync` no longer overwrites managed files silently. Files already matching the latest template are skipped and reported as up to date (line-ending-only differences count as up to date, so a CRLF checkout is not warned about forever); a file whose contents differed — an older version or a local edit — is listed as replaced, with a warning that local edits to framework-managed files do not survive a sync. A new `--dry-run` flag on both `agent:sync` and `agent:init` reports what a run would write, replace, or prune without changing any file; combined with `--prune` it says what would be removed, and the closing hint repeats the flags the preview ran with. `AgentHarnessResult` gains `replaced`, `unchanged`, `mode`, `dryRun`, and `pruneRequested` fields, and `written` now reports only the files actually written.
- 1e44a1d: `guren check --arch` can now enforce boundaries at the type level. Type-only imports (`import type`, `export type ... from`, and `import('...').X` in a type position) still compile away and are skipped by default, but a rule — or the whole rule set — can opt in with `includeTypeImports: true`, and the `defineArchRules` JSDoc now states the default explicitly. Violations found this way are labeled `(type-only)` in the report.

### Patch Changes

- 49b1d04: Exempt the agent-catalog changeset gate on a moved `@guren/cli` version rather than on a manifest-only diff. A push or squash carrying both a catalog change with its changeset and the `changeset version` commit that consumes it no longer fails the gate, and a manifest edit that leaves the version alone is now gated rather than waved through.
- 352a76f: `guren check` no longer demands a console registration for files under `app/Console/Commands/` that declare no command. A constants or helper module living next to the commands used to produce a warning that could never be resolved. The registration check now covers only files that could surface a command: a class (declaration or expression) with a superclass or a `signature`/`handle` member, a re-export with a source, or a default-exported identifier or call. Files that fail to parse stay in the check, since they cannot be shown to declare no command — and are no longer double-reported as "skipped" by the coverage summary. `guren context` lists commands through the same predicate, so the two commands agree about what a helper module is.

## 2.7.1

### Patch Changes

- 10459aa: Report a routes file `guren context <Entity>` could not read, instead of reporting that the entity has no routes.

  The entity bundle loads the routes file for real — it imports it to read the definitions off a router — and caught every failure of that import as an empty result. An app whose routes could not be loaded therefore rendered exactly what an app whose entity has no routes renders: `## Routes (0)` and `No routes reference this entity.`, exit 0. Every reader of that bundle, agent or human, had no way to tell a confident answer from a failed one. The reason is now printed in place of that line, with the note that the list is incomplete.

## 2.7.0

### Minor Changes

- 14a0b2d: Ship the agent-catalog sources and generator behind `gurenjs/agent-skills`

  Adds `packages/cli/templates/agent-catalog/`: the two on-ramp skills
  (`guren-new-app`, `guren-harness`) and the manifests published to the
  Claude Code plugin marketplace, the Agent Skills CLI, and Agent Plugins v1
  clients as `gurenjs/agent-skills` (RFC 0011). The rendered payload is not
  committed; `scripts/build-agent-catalog.ts` renders it and
  `audit:agent-catalog` asserts, in CI, that every `guren` command and flag
  the skills name is one the CLI registers, every target is in
  `AGENT_TARGETS`, and the root `plugin.json` conforms to the vendored Agent
  Plugins v1 schema.

  To make that audit derivable, the builtin command registry moves from
  `bin.ts` into an importable `commands.ts` with no top-level side effects.
  Nothing user-facing changes: `guren --help` lists the same commands.

- fc22c89: `agent:sync --prune` no longer deletes skill directories under names the framework never shipped

  The stale-file scan claimed `.claude/skills/` and `.agents/skills/` as whole
  directories, so any skill directory the current harness did not plan was
  reported stale and, with `--prune`, deleted. Those directories are shared
  with installers the framework does not control — `npx skills add` and Agent
  Plugins clients copy third-party skills straight into them, flat and
  unnamespaced — which made every such skill a prune candidate, including the
  framework's own catalog-distributed ones (RFC 0011).

  The skills roots are now claimed per skill directory: the ones the harness
  ships, plus a `RETIRED_CANONICAL_SKILLS` list of names it used to ship, so a
  skill that leaves the canonical set is still cleaned up. Anything else under
  those roots is never entered, listed, or deleted. Rules roots and the
  `guren-*` native rules are unchanged. The change can only delete less than
  before; a user who relied on `--prune` to clear third-party skills now
  removes those by hand.

- 6ea8279: Report what `db:make` actually generated instead of an unconditional "Migration generated."

  `drizzle-kit generate` exits 0 whether it wrote a migration or printed "No schema changes, nothing to migrate.", and the CLI reported ✔ off that exit code. Paired with the empty-folder warning `db:migrate` now prints, a user whose `db/schema.ts` has no pending changes got a loop with nothing in it explaining why: warning → `db:make` → ✔ → `db:migrate` → the same warning.

  `makeMigration()` now diffs the migrations folder around the child process and resolves that folder the same three ways it decides drizzle-kit's arguments — an explicit `--out`, the `out` the drizzle config declares, or the default. `db:make` names the migration it generated, and warns `No migration generated in db/migrations — db/schema.ts has no changes since the last one.` when there was none, pointing at the schema rather than back at `db:make`. The command still exits 0.

  The folder is reported only when it was positively resolved: a drizzle config that declares no `out`, or one that throws on import, leaves the previous message rather than naming a folder drizzle-kit may not have written to.

  `makeMigration()` now resolves to a `MakeMigrationResult` rather than `void`, and that type is exported alongside `MakeMigrationOptions` so a caller can name what it receives.

- 50bdfec: Report an empty migrations folder from `db:migrate` instead of "Database migrations completed."

  `migrateDatabase()` returns before it touches a connection when the folder holds no drizzle-kit migrations, so the CLI reported success for a run that applied nothing and created no database. On a fresh app that is the last green line before `db:seed` fails on a missing table, far from the cause.

  The driver handles now resolve a `MigrationRunSummary` (`migrationsFolder`, `migrationsFound`, `looseSqlFiles`) from `migrateDatabase()` and `resetDatabase()`, and `db:migrate` warns `No migrations found in db/migrations — nothing was applied.`, pointing at `bun run db:make`. `db:reset` and `db:fresh` report the same run, where the ✔ was worse: they drop every table first, so the reported success described a database that had just been emptied. All three now carry `migrationsFound` and `looseSqlFiles` in their `--json` output whenever the app's ORM reports them. A folder holding loose `.sql` files gets the warning without the `db:make` hint — those migrations exist, they are just in a shape the drizzle migrator skips, which the ORM already explains. The command still exits 0, and a `config/database.ts` whose migration function reports nothing keeps the previous message.

  `create-guren-app` also names `db:make` in the closing reminder it prints after scaffolding authentication, the one step of that sequence the reminder left out.

- c8489f9: Report an empty seeders folder from `db:seed` instead of "Database seeders executed."

  `runSeeders()` loops over zero seeders without complaint, so the CLI reported success for a run that wrote nothing. The scaffolded `db/seeders/` ships holding only `.gitkeep`, which makes this the next green line after an empty `db/migrations` on the fresh-app path — the same defect class, one step further from the cause.

  `runSeeders()` and every driver's `seedDatabase()` now resolve a `SeederRunSummary` (`seedersFolder`, `seedersRan`, `filesWithoutSeeder`), and `db:seed` warns `No seeders found in db/seeders — nothing was seeded.`, pointing at `bunx guren make:seeder`. A folder whose files exported no seeder gets the warning without that hint and is told what a seeder module must export instead — those files exist, they are just in a shape the loader skips. `db:reset --seed` and `db:fresh --seed` report the same run, where the ✔ claimed a database that had just been emptied and not repopulated; when both halves came back empty the migration warning wins, since seeding a schema that was never re-applied could not have worked anyway. All three carry `seedersRan` and `filesWithoutSeeder` in their `--json` output whenever the app's ORM reports them.

  `db:reset --seed` and `db:fresh --seed` also refuse up front, before dropping anything, when the app's `config/database.ts` exports no seed function at all: they previously emptied the database and then reported it seeded. `db:seed` already refused the same config.

  The commands still exit 0 on the empty-folder diagnostic — it is not a failure — and a `config/database.ts` whose seed function reports nothing keeps the previous message.

- 4464071: ### Deprecated

  - **Class-based seeder API (`BaseSeeder` / `Seeder`, `SeederRunner`, `createSeederRunner`, `resetCalledSeeders`, and the `SeederClass` / `SeederInterface` / `SeederRunnerOptions` types)** — Write seeders with `defineSeeder` instead. Deprecated in 2.9.0, will be removed in 3.0.0. Detected by `bunx guren upgrade --check-only` as `seeder-class-convention`.

  A seeder class is not itself unsupported. `db:seed` loads seeders through `runSeeders()`, which accepts a `defineSeeder` handler, an exported `seed`/`run`/`Seeder`, or a default export — including an exported class whose prototype has a `run` method, which it constructs and calls as `run({ db })`. That last shape is deliberate: `packages/orm/tests/seeder.test.ts` covers it as "supports class-based seeders with run method".

  What `BaseSeeder` gets wrong is the signature it imposes. Its `run()` is declared to take no parameters, so it hides the one argument a seeder needs. A subclass cannot simply correct that: declaring `run(ctx: SeederContext)` fails to compile against the base (`TS2416: Target signature provides too few arguments. Expected 1 or more, but got 0`). Widening it to an optional `run(ctx?: SeederContext)` does compile, but then the subclass must handle a missing context, and that case is real: `call()`, `callOnce()`, `callMany()` and `callParallel()` construct child seeders and invoke `run()` with no arguments at all, so a parent that received a context cannot pass it down. The result is a seeder that is counted as having run while its context handling is left to chance.

  `SeederRunner` is the orchestration those classes were written for, and no Guren command reaches it. It runs a single seeder per call — a class passed in, a name registered with `register()`, or a name resolved to `<seedersPath>/<Name>.ts` defaulting to `DatabaseSeeder` — constructing it with `new` and invoking `.run()` with no context. `db:seed` does none of that; it runs every seeder in the folder.

  Nothing is removed and no existing call changes its result. This adds `@deprecated` JSDoc naming the replacement, a once-per-process runtime warning from the `BaseSeeder` and `SeederRunner` constructors, and a `seeder-class-convention` entry in the deprecation registry so `bunx guren upgrade --check-only` reports affected files. No codemod ships with it: the migration moves a class body into a handler and has to resolve how each `call()`/`callOnce()` child receives `db`, which is not a mechanical rewrite.

  These exports are re-exported from `@guren/core`, which makes them Stable under `contributing/api-stability.md`, so the deprecation policy's minimum of two minor versions applies before removal. Deprecated in 2.9.0, that permits removal from 2.11.0 onward: `removedIn` targets 3.0.0 on the assumption that 3.0.0 follows 2.11.0, which is also what keeps this removal in the same batch as `local-disk-per-object-visibility`. If 3.0.0 is cut earlier than that, this entry moves to the following major rather than being removed early.

  The sibling `BaseFactory` / `Factory` / `defineFactory` exports live in the same directory and are deliberately untouched — `make:factory` scaffolds `class …Factory extends Factory<typeof Model>`, `Factory` being the `BaseFactory` alias.

### Patch Changes

- 08203e5: Install the catalog plugin at user scope in the published README.

  The two skills it ships are for the step before a project exists, and they are the same two whatever you are building. `--scope project` wrote them into whichever repository the user happened to be standing in — which at that moment is either nothing or something unrelated — and shared an on-ramp with the collaborators of an app that already has the harness installed. It is also not the scope the plugin CLI defaults to.

- cdf34f8: Let `agent:sync --prune` remove a stale managed file whose name differs from a planned one only by case.

  The stale scan compared paths case-insensitively, so that a case-preserving filesystem — where the write loop refreshes a planned file through a differently-cased directory entry it found on disk — would not classify the file it had just written as stale. On a case-sensitive filesystem those two names are two separate files: after a rename, `.claude/rules/ORM-MODELS.md` and `.claude/rules/orm-models.md` both exist, and the lowercased comparison hid the genuinely stale one from prune permanently.

  The scan now matches exact paths first, and for a case-only mismatch spares the entry only when it and the planned path are the same file on disk (same device and inode). A filesystem that cannot answer that question leaves the entry alone — neither reported nor deleted — rather than spending an irreversible delete on a claim it could not establish.

- d7f3034: Accept `guren context --entity <Model>`, which citty silently dropped

  `context` declared its `entity` argument `type: 'positional'`. When a value is passed to a positional as a flag, citty 0.1.6 discards it entirely — it reaches neither `args.entity` nor the unconsumed positionals in `args._`, and no unknown-flag error is raised — so `guren context --entity User` ran as if no entity had been named. This command's no-entity branch is the whole-project map, so it printed that and exited 0: the wrong output, with nothing signalling the argument had been ignored.

  The flag spelling is one the docs teach rather than an invented one. `--entity <Model>` is a real string flag on both `make:adr` and `docs:graph`, documented in the CLI guides in English and Japanese and in the agent harness template, so `context --entity User` is a natural thing to write after reading them.

  `entity` is now `type: 'string'` and falls back to `args._[0]`, which accepts `guren context User`, `--entity User`, and `--entity=User` alike; a string arg still leaves an unconsumed positional in `_`, so the documented positional form is unchanged, including alongside `--module`. `guren context --help` now lists `--entity=<User>` under OPTIONS rather than as an `[ENTITY]` argument, and its description names the positional spelling.

  `queue:retry` has the same optional-positional declaration and is deliberately left as it is: its `id`/`--all` guard reports the missing id and exits 1 when the value is dropped, so the wrong spelling is already refused loudly rather than acting on the wrong input.

- 5923bfe: Fix `guren context` misreading a flag that is passed twice

  citty hands an argument back as an array once its flag is repeated, and
  `guren context` read all five of its own straight through.
  `--entity User --entity User` exited 1 on `entityName.toLowerCase is not a
function`, and `--app . --app .` exited 1 inside `resolve()`. The other three
  never said anything untrue out loud: `--module app --module app` exited 1
  blaming a module named `app,app`; `--routes web.ts --routes web.ts` exited 0
  reporting the entity's routes as none, because the same `resolve()` failure
  lands in the `catch` that exists for a routes file the CLI genuinely cannot
  load; and `--json=true --json=false` printed JSON, because every array is
  truthy. Each of the five now resolves to the value passed last.

- 630b908: Point `db:make` at a `drizzle.config.json` instead of overriding it with defaults.

  `makeMigration()` probed only `drizzle.config.{ts,mts,js,mjs}`, so an app whose
  only drizzle config is the JSON one drizzle-kit names as its own default fell to
  the no-config branch and was handed explicit `--schema db/schema.ts --out
db/migrations`. drizzle-kit then reported `dialect: undefined` — blaming the user
  for a value they had declared, in a file nothing had read. `drizzle.config.json`
  is now probed last, after the loadable formats, matching drizzle-kit's own
  `.ts` > `.js` > `.json` preference.

  This does not make JSON configs work: `bun x drizzle-kit` runs drizzle-kit
  through its `#!/usr/bin/env node` shebang, and under Node its `import()` of the
  config needs a `type: json` import attribute it does not pass, so such an app now
  gets drizzle-kit's own error naming the config file it could not load. That is
  the honest failure — the previous one described a different problem entirely and
  pointed away from the config that caused it. Nothing regresses either: on the
  pinned drizzle-kit, the flags branch those apps leave cannot succeed for anyone,
  since a run passing `--schema`/`--out` without `--dialect` is rejected. Apps with
  a `.ts`, `.mts`, `.js` or `.mjs` config, and any run passing `--schema`/`--out`
  explicitly, are unaffected.

- 8c19ac3: Undo the table-cell escaping in the docs viewer's renderer instead of splitting on it. `escapeMarkdownTableCell` doubles a backslash and then escapes every pipe, so a `screens.md` Props column holding a TypeScript union (`A \| B`) rendered as two cells with a stray backslash, pushing the rest of the row one column right. Row splitting now scans for unescaped pipes and reads `\\` as one unit, so a cell that ends in a backslash still lets the delimiter behind it split.
- ec57e11: Honor `--name` on `make:migration` (`db:make`), and take the last value of a repeated flag.

  `guren make:migration --name add_posts_table` — the form the database guide documents — generated a migration under a name drizzle-kit invented (`20260819113244_unusual_triton`) rather than the one given. The argument was declared as a positional, and citty resolves positionals and string flags from different places: `--name <value>` arrived with neither a `name` key nor the value among the positionals, and no unknown-flag error to say so, so drizzle-kit was called with no name at all and fell back to naming the migration itself. Nothing about the run looked like a failure — the migration is generated and correct, only misnamed, which is the kind of thing noticed later when hunting for it by name. Both spellings work now: `--name <name>`, and the bare positional (`guren make:migration add_posts_table`) that the scaffolding skills use.

  Repeating any of the command's three flags is also handled. citty types a `string` argument as `string | undefined` and then hands back a `string[]` when the flag appears twice, which each argument failed on differently: `--schema a/schema.ts --schema b/schema.ts` was comma-joined into a path nothing can open and still exited 0, and once `--name` started being read it would have thrown `options.name?.trim is not a function`. The last value wins, as it does everywhere else.

- 4979e05: `make:seeder --help` no longer calls its argument a class name. The command
  scaffolds a `defineSeeder` handler, which is what `db:seed` runs; the old
  wording was the last user-reachable trace of a class-per-run seeder
  convention the CLI never had.
- a59d0b6: fix(cli): pass the dialect drizzle-kit requires when `make:migration` overrides the config

  `make:migration` never stated `--dialect`, which drizzle-kit requires and will
  not infer, so two paths could not generate anything on any app:

  - The documented override flow. `--schema`/`--out` suppress `--config`
    entirely, so `guren make:migration --schema ./custom/schema.ts --out
./custom/migrations` failed with `dialect: undefined` even against a config
    that declared one.
  - The no-config fallback, whose `db/schema.ts` / `db/migrations` defaults were
    therefore unreachable in practice.

  Restoring `--config` alongside the overrides is not available: drizzle-kit
  refuses the two together ("You can't use both --config and other cli options
  for generate command"). So the overrides now carry everything the config would
  have supplied — `dialect`, `driver`, and any un-overridden `schema`/`out`.

  As a result, overriding only `--schema` no longer relocates the migrations to
  the default folder; the config's `out` is kept, so one app's history stays in
  one directory.

  A config field that `generate` exposes no flag for cannot be restated this way
  — `breakpoints: false` is the one such case, since `--breakpoints` has no
  negation. The command now names any such field in a warning instead of letting
  the generated SQL differ from what the config asked for.

  Apps with no drizzle config can now state the dialect themselves with a new
  `--dialect` flag. When nothing declares one, the command stops before spawning
  drizzle-kit and names the missing field and the fix, rather than surfacing
  `dialect: undefined` against flags the user never typed. A config declaring
  `schema` as a list is likewise refused, because `--schema` takes one value and
  a repeated flag silently keeps only the last.

- Updated dependencies [2faefea]
- Updated dependencies [50bdfec]
- Updated dependencies [c8489f9]
- Updated dependencies [6cbb012]
- Updated dependencies [4464071]
  - @guren/core@1.8.0
  - @guren/orm@2.6.0

## 2.6.2

### Patch Changes

- c0a32ac: Report the CLI version for `guren --version`

  `guren --version` printed `ERROR  No version specified` and exited 1, behind a
  full usage dump. The root command is built with citty, whose `--version`
  handler reads `meta.version`, and the root command's `meta` only ever set
  `name` and `description` — so the flag reported the absence of a version rather
  than the version.

  The root command now carries its own package version, read from the manifest at
  startup rather than written into the source as a literal, which would drift at
  every release:

  ```
  $ guren --version
  2.6.1
  ```

  This is the obvious capability probe for tooling and AI agents that need to know
  which Guren CLI an app has — whether `agent:init --target` is available, for
  instance. citty ignores flags it does not recognise, so without a working
  `--version` there was no cheap way to detect an older CLI: passing an
  unsupported flag to it exits 0 and silently does something else.

  The version prints on plain stdout, like every other command that emits a
  payload rather than a diagnostic (`model:list`, `context`, `route:list`). citty's
  own `runMain` logs it through consola, which makes the version unreadable
  exactly where it gets read: consola's non-TTY reporter prefixes the level, so CI
  and any piped caller saw `[log] 2.6.1`, and a configured log level could drop the
  line entirely. `guren --version` now emits a bare version line regardless of
  `CI`, `NODE_ENV`, or log level.

  An unreadable manifest leaves `meta.version` unset rather than throwing. The
  root command module is evaluated for every command, so that failure costs only
  `--version`, which falls back to the message above, and never `make:model`.

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

- Updated dependencies [9e1ce65]
- Updated dependencies [7251560]
- Updated dependencies [866919c]
- Updated dependencies [32e03dd]
- Updated dependencies [2be4b64]
- Updated dependencies [39b17e7]
  - @guren/orm@2.5.0
  - @guren/core@1.7.0

## 2.6.1

### Patch Changes

- b927659: Stub the database clients a Lambda or Vercel app does not use

  A Postgres app failed to bundle for either platform with
  `Could not resolve "mysql2"` — naming a database its author never chose — and
  `@aws-sdk/client-rds-data` behind it. `@guren/orm` names each dialect's client
  in a _literal_ dynamic import, and a bundler follows those whether or not the
  branch can be taken, so every client the app did not install broke the build.

  Workers could stub all of them, because D1 is the only database there is.
  Here the client the app _does_ use is load-bearing, so the build now reads
  which dialects `config/database.ts` declares and stubs only the rest.
  Detection is a union, never a single answer — an app legitimately pairs
  Postgres with sqlite and picks at runtime — and it fails open: when no
  factory can be read, nothing is stubbed and the build says so. Over-stubbing
  would ship a function that builds clean and cannot reach its own database,
  which is a far worse failure than the loud one this replaces.

  Pass `databaseDialects` to `buildLambdaOutput`/`buildVercelOutput`, or
  `guren lambda:build --database postgres,sqlite`, for an app whose config
  reaches a factory without naming it.

  `buildVercelOutput` is now **async**. It bundled by spawning `bun build`,
  whose CLI has no way to replace a module — no alias flag, no plugin flag — so
  this platform had no stub mechanism at all. It now uses Bun's JS API, which
  takes plugins. Update `scripts/vercel-build.ts` to `await buildVercelOutput({
... })`; the scaffold emits that from now on.

  That missing mechanism was also why a scaffolded app could not be bundled for
  Vercel at all: the disabled MCP endpoint's `import("@guren/cli")` resolves and
  the CLI's own `import("@guren/openapi")` behind it does not. The Vercel build
  now stubs the same dev-only modules Lambda has stubbed since it shipped —
  Vite and the MCP endpoint — which also drops the dev tooling those dragged
  into the function. `bun:sqlite` is deliberately **not** stubbed here: the
  function runs on Vercel's Bun runtime, so sqlite is a working database on this
  platform, unlike on Workers and Lambda.

  Both plugins also pass `throw: false` to `Bun.build`: it rejects with a bare
  "Bundle failed" by default, discarding the one line that matters — the module
  it could not resolve.

  An opt-in `GUREN_TEST_BUNDLE=1` test per platform bundles a Postgres app with
  no other client installed. Each installs the ORM from a tarball rather than a
  local path, because a linked install resolves out into this repository's own
  `node_modules` where every client exists. The assertions are behavioural
  rather than about the stub's text: resolution happens before dead-code
  elimination, so the message a stub throws is not in the output either way.

- Updated dependencies [b927659]
- Updated dependencies [15cfaf5]
  - @guren/core@1.6.2

## 2.6.0

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

## 2.5.0

### Minor Changes

- e698600: `agent:sync` now reports files left behind in framework-managed directories when a canonical rule or skill is renamed or removed — including the stale `.cursor/rules/guren-*.mdc` and `.github/instructions/guren-*.instructions.md` copies Cursor and Copilot keep auto-loading — and `agent:sync --prune` deletes them. Without `--prune`, sync never deletes anything, so user files under colliding names stay safe by default.
- 4bb4472: The generated API client derives params from path literals, types `json()` from bound output schemas, and closes a union-route-name type hole.

  Route params are no longer stored on the generated `ApiRoutes` entries as a `params` field. Both `ApiRequestOptions` and `request()` now derive them from each entry's `path` literal — the same string the server routes on — through one shared emitted fragment (`PathParamKeys`, `HasPathParams`, `PathParamsOf`) that the route manifest module's `RouteParams`/`RouteArgs` are also expressed with, so a future change to the entry shape can never silently flip `request()`'s call arity and the rule has a single spelling across the generated modules. `ApiRouteParams<T>` remains exported with the same meaning, and `@guren/inertia-client`'s hand-mirrored copy of the rule is now pinned to the fragment's exact text by a test.

  `request()` now returns `Promise<TypedResponse<...>>`: on routes that bind an `output` schema, `json()` resolves to that schema's parsed shape instead of `any`; without one it resolves to `unknown`, so asserting the shape at the call site stays explicit.

  The path predicate is deliberately not distributed over a union route name. Previously `'posts.index' | 'posts.show'` accepted `params: {}` and could send a path with `:id` unresolved; now a union name requires every member's params, which forces the safe call in both directions.

  To make those extra params true runtime no-ops, the generated client's param substitution switched from a per-key `path.replace(':key', ...)` loop — which let a param whose name prefixes another (`:id` vs `:identifier`) corrupt the path — to the same token-based `substituteParams` the route manifest module already uses, now emitted from one shared fragment. `@guren/inertia-client`'s typed `<Link>`/`<Form>` components adopt the same substitution.

- e984c3d: `guren check` warns about route paths using `:name*`, which reads as a wildcard and is not one.

  Hono takes everything between `:` and an optional `{constraint}` as the parameter name, with no special meaning for `*` — so `router.get('/files/:slug*', ...)` registers a single-segment parameter named literally `slug*`. `/files/a/b` 404s, and the controller's `req.param('slug')` is undefined. The syntax looks enough like a wildcard that Guren's own routing guide recommended it, so apps carry the mistake with nothing to tell them: the route registers, the app boots, and the only symptom is a 404 for every URL the author expected to match.

  The check reads `routes/` and each module's routes files, including the single-file `modules/<name>/routes.ts` shape, and covers `get`/`post`/`put`/`patch`/`delete`/`query`, `on(method, path)`, `group(prefix)`, and `resource(path, controller)` — the last two spread one path over every route they cover. Constrained parameters are left alone, including `:path{.+}`, `:path{.*}` and nested-brace constraints, as is Hono's real `*` wildcard segment. Each finding names the parameter Hono actually binds and prints the corrected path (`:slug{.+}`) to match across segments.

  The finding is a plain `warn`, so a plain `guren check` still exits 0, but `check --ci` gates on it the way it does on an unmounted route registrar — both are routes that 404 with nothing else to report them. An app upgrading with a `:slug*` route already in it will go red there until the path is fixed.

- 44f96d8: `guren codegen` names the Resource classes it could not extract a `Data.*` type from, instead of dropping them in silence.

  `generateDataTypes` recognises a documented subset of `toArray()` shapes. A Resource outside it type-checks, serves, and passes its own tests — the only symptom was a `Data` member that never appeared, under a run that reported success and, having matched the class pattern, then wrote `// No resources found`. Each miss now names the class, its file, and the shape to declare (`export interface PostResourceData { … }` plus `toArray(): PostResourceData`, what `make:resource` scaffolds). Two near misses get their own message, because the fix differs: an annotation naming a type declared in another file has to be moved rather than written, and an annotation in a shape codegen does not read (`Types.PostPayload`, `PostData<T>`) is quoted back rather than reported as no annotation at all. Warnings return from `generateDataTypes` the way `generateApiClientTypes` already returns its own, so `guren codegen` prints them and the MCP `guren_codegen` tool forwards them; the exit code is unchanged.

  Four shapes are also read correctly now, all of which previously produced a wrong type or none:

  - A type body was captured up to the first `\n}`, so a one-line `interface PostResourceData { id: number }` ran past its own closing brace and swallowed the class declaration below it, emitting a `data.gen.ts` that did not compile — costing the app every other resource's type as well.
  - Locating that body required the declaration to carry `extends` or `=`, so a plain `interface PostPayload { … }` named by `toArray(): PostPayload` was dropped.
  - A commented-out draft of the interface being looked for was matched ahead of the real declaration, describing a payload the app had stopped sending.
  - A template literal type whose `${ … }` holds another template ended at the inner backtick, truncating the body mid-property.

  Comments and string literals are now blanked (offsets preserved) before anything is matched, and bodies are read by counting brace depth. Output for shapes that already worked is byte-identical.

- b4295fc: Scaffold schemas from the dialect-specific `@guren/orm/drizzle/{pg,mysql,sqlite}` barrels

  Follow-up to #379: generated `db/schema.ts` files now import every column
  builder from the barrel matching the app's dialect, and `guren add auth` /
  `guren add resource` merge new builders into that barrel instead of the mixed
  `@guren/orm/drizzle` (PostgreSQL) or raw `drizzle-orm/*-core` (MySQL/SQLite)
  specifiers. Apps scaffolded before the barrels keep working: builders already
  in scope are left untouched, and only genuinely missing ones are imported via
  the barrel, which requires `@guren/orm` >= 2.3.0.

- c9d7c38: `guren agent:init` now installs the agent harness for multiple agents via `--target` (claude, codex, cursor, copilot, opencode, or `all`). Non-Claude agents get `AGENTS.md` plus the shared `.agents/rules/` and `.agents/skills/` trees they read natively; Codex and OpenCode also get their MCP client config (`.codex/config.toml` / `opencode.json`), left untouched with a printed snippet when the file already exists. `guren agent:sync` refreshes every installed family it detects on disk.
- 1f815fd: Routes can declare their response shape by naming the Resource that builds it, and the generated API client types `json()` from it.

  `RouteContractOptions` gains a `resource` field: a Resource class, a one-element array (a collection), or a plain object of either (an envelope) — `resource: { data: [PostResource] }` mirrors `this.json({ data: PostResource.collection(posts) })`. Unlike `output`, nothing runs at request time; the hint is purely a type-level declaration, so the response shape lives in one place (the Resource's `toArray()` type) instead of being restated in Zod.

  `definitions()` serializes the hint to class names (`RouteDefinition.resource`), and `guren codegen` resolves those against the Resource classes it already extracts into `.guren/data.gen.ts`, emitting the assembled shape (`{ data: Data.Post[] }`) as the route's `response` type — the same slot an `output` schema fills, and `output` still wins when both are declared. A hint naming a Resource class codegen cannot find warns and leaves that route's response untyped rather than claiming a shape the server does not send. `generateApiClientTypes` returns those warnings (`{ outputPath, warnings }`, the same contract as `generateOpenApiSpec`), and the MCP `guren_codegen` tool forwards them in its payload alongside `generated`/`skipped`.

  The blog starter's `posts.search` route now declares `resource: { data: [PostResource] }`, so its search page reads `json()` typed instead of asserting the shape at the call site.

### Patch Changes

- 2291ac0: `guren codegen` refuses to emit a `Data.*` type it would have to guess at, and says which declaration it could not read.

  Three shapes each yielded _some_ brace body with no warning — the wrong one, which is worse than none: the frontend gets a type that compiles and lies about the payload.

  - `interface PostResourceData extends Record<string, { nested: true }> { … }` emitted the generic argument, not the body. Detected by the heritage clause's unbalanced angle brackets, which is what a clause cut off at the wrong brace looks like.
  - Two `interface PostResourceData` blocks in one file emitted the first and dropped the second's members, though TypeScript merges them.
  - `type PostResourceData = { id: number } & { title: string }` emitted only the first term. An alias's right-hand side runs to the end of the statement, so a body followed by `&`, `|`, or a conditional `extends` is not the whole type.

  `type PostResourceData = { id: number }[]` and `= { … }['payload']` emitted the object operand as if it were the whole type; both are refused now too.

  Declarations are matched at the top level only. A type of the same name inside a namespace, an ambient module, or a function body is a different type that merely shares it: its members were emitted as the Resource's payload when nothing at the top level declared one, and it counted as a second block against a top-level declaration that was in fact the only one.

  A generic declaration is refused too, as it always was, but now says so: `{ id: T }` copied out of `interface PostResourceData<T>` would not compile, and "not a plain object type" sent the author to rewrite a shape that was never the problem.

  Each is now named, with the reason and the shape to write instead. A `type X = { … }` whose body stands alone still reads exactly as before, and output for every shape that already worked is byte-identical.

- 1379993: `make:module` and `--module` refuse a name starting with a digit.

  A module name is not only a directory. Codegen PascalCases it to qualify the identifiers it emits for that module, so a Resource in `modules/billing/` is exported as `Data.BillingInvoice`. `modules/2fa/` yields `2faInvoice`, which is not a TypeScript identifier — the Data-type generator has to drop the definition and tell the author to rename the directory. The validator accepted the name, so the scaffolder created a module the generator would later refuse.

  The one segment that reaches the front of an identifier is the first, so only its leading character is constrained: `s3` and `billing-2fa` are still accepted, `2fa` and `2FA` are not, and the error names the reason rather than leaving it to be discovered at codegen time.

  This is deliberately a break for an app that already has a `modules/<digit…>/` directory: the directory keeps working everywhere it is discovered from disk (`check`, `context`, `codegen`), but `make:controller Invoice --module 2fa` and its siblings now refuse it. The name was never usable end to end — its generated Data types were already being dropped — so the refusal moves an existing failure to the point where it can still be fixed with a rename. The runtime check in the generator stays as a backstop, since a `modules/` directory can be created by hand.

- 5e1bb0d: The generated API client now compiles against its own documented usage, and the blog starter puts it to work on an HTTP QUERY search endpoint.

  `createApiClient<ApiRoutes>()` rejected every real call site: the `Record<...>` generic constraint turned away the generated `ApiRoutes` interface (interfaces carry no implicit index signature), and param-less routes — emitted as `params: Record<string, never>` — were misread as requiring a `params` argument because `keyof Record<string, never>` is `string`, not `never`. The constraint is now a mapped-object type and the param check matches the emitted shape, with a compile-level test that runs `tsc` over the generated module and its documented usage.

  The blog blueprint gains `QUERY /posts/search` (RFC 10008): a route-bound Zod body schema, a read-only controller action, a starter test driving `TestApp.query()`, and a search box on the posts page calling the endpoint through the generated typed client — the first template consumer of `createApiClient`.

- 7b34556: `resetDatabase()` now re-applies migrations after dropping, matching `guren db:reset`

  The Postgres, MySQL, SQLite, and Aurora Data API factories dropped every table
  and stopped there, so the next query failed with `relation "posts" does not
exist` — far from the reset that caused it. `resetDatabase()` now migrates
  afterwards and leaves a migrated database, the same end state the CLI's
  `db:reset` produces.

  Suites already following the documented reset-then-migrate pattern keep
  working: the second `migrateDatabase()` call sees an up-to-date tracker and
  no-ops. D1 is unchanged — its resets go through wrangler.

- ca3c2a4: The `:name*` route path check reads paths through the shared path-param pattern.

  The rule was written when no shared lexer existed, so it carried its own segment reading: split on `/`, take everything up to a `{`, strip a trailing `?`. `PATH_PARAM_PATTERN` now answers the same question — it anchors params at a segment boundary, consumes an attached constraint whole including one level of nesting, and keeps a trailing `*` as part of the label, which is the finding itself. Detection and the suggested rewrite are both driven by it, so the check and the code generators can no longer come to disagree about what a path binds.

  No behaviour change for any path a scaffolder or guide produces; the shared pattern is stricter than the old reading only for a label with punctuation in it (`:name.:ext*`).

- b7b2b09: `where(callback)` and `orWhere(callback)` compose parenthesized condition groups, Laravel's `where(fn ($q) => ...)`.

  Until now `orWhere()` always pushed a top-level OR, so "(title LIKE ? OR excerpt LIKE ?) AND published = true" was inexpressible from application code — any AND filter next to an OR keyword chain (a published flag, tenancy, soft deletes) was silently OR'd away. The callback form collects conditions on a nested builder and folds them into a single group AND-ed with the rest of the query (`orWhere(callback)` ORs the whole group instead). Sequential semantics inside the callback match the top level: `.where(a).where(b).orWhere(c)` reads `(a AND b) OR c`, and callbacks nest. Groups render through the existing Drizzle condition tree, verified against the real sqlite driver alongside SoftDeletes and global scopes.

  The blog starter's `posts.search` action now groups its keyword OR chain this way, so filters added after it apply to every match.

- Updated dependencies [7b34556]
- Updated dependencies [b7b2b09]
  - @guren/orm@2.4.0
  - @guren/core@1.6.1

## 2.4.0

### Minor Changes

- 3e39cc1: `guren audit` now audits routes registered with custom HTTP verbs (`router.on('PURGE', ...)`) instead of silently skipping them.

  Route auditing enumerated the methods it knew: only POST/PUT/PATCH/DELETE were checked for authentication and only POST/PUT/PATCH/QUERY for body validation. A route registered with any other verb fell through both checks, so an unvalidated body plus a missing auth guard produced zero findings and the audit reported a clean pass.

  Method handling is now driven by a single fail-closed classification (`describeMethod`): GET/HEAD/OPTIONS stay unaudited (safe, body-less), QUERY keeps its body check without demanding auth, DELETE stays auth-only, and any other verb is treated as unsafe and body-carrying, so it gets both the authentication and the validation check. That includes TRACE — formally safe per RFC 9110, but deliberately left to the fail-closed default here. Apps using custom verbs may see new findings; genuinely body-less custom verbs can be suppressed via `config/audit.ts`. Output for apps using only GET/HEAD/OPTIONS/QUERY/POST/PUT/PATCH/DELETE is unchanged.

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

- Updated dependencies [0e615fc]
- Updated dependencies [dd9a5df]
  - @guren/core@1.6.0
  - @guren/orm@2.3.0

## 2.3.1

### Patch Changes

- c8cc7c4: Stop the agent testing rule from documenting a TestApp form that throws

  The harness rule shipped `const app = TestApp.fromFetch((req) => app.fetch(req))`
  as the way to wrap an existing app. The arrow is not the problem — the shadowing
  is. Inside it, `app` resolves to the `const app` being declared on that same line,
  which is the `TestApp`, and `TestApp` has no public `fetch`. An agent that copied
  the line got `TypeError: app.fetch is not a function` at the first request, from
  text that reads fine.

  `TestApp.fromApp(app)` was added for this footgun and is now published, so the rule
  documents it as the way to test against a real `Application`: it boots the app and
  binds `fetch` itself. `fromFetch` stays for the case it actually models — an
  arbitrary fetch function — with an example that does not shadow. The `(not async)`
  note travels with `fromFetch`, since `fromApp` must be awaited.

  Existing apps pick this up through `guren agent:sync`, which owns everything under
  `.claude/rules/`.

- e38ac75: Refuse plugin env entries that target the framework's own security gates

  `guren plugin <pkg>` applies the `gurenPlugin.env` entries from the installed
  package's manifest, and `applyEnvEntries` validated only the _shape_ of the key
  (`/^[A-Z][A-Z0-9_]*$/`). Values and comments were interpolated raw, so a
  manifest could append `GUREN_TESTING=1` — which alone makes the server trust an
  `X-Testing-User` header — or smuggle the same line through a newline inside an
  innocuous entry's value, where a reviewer skimming key names would not see it.
  `.env.example` is committed, so either line propagates to every clone.

  Two refusals, both throwing rather than filtering in silence: keys in the
  reserved `GUREN_*` namespace, and values or comments containing a line break.
  A plugin has no legitimate reason to do either, so failing the install is the
  right outcome; malformed keys keep their existing silent-skip behaviour.

  The check runs as soon as the manifest is read — before the provider is wired
  into `src/app.ts` and before any publish is written — so a refused manifest
  does not leave a half-activated install behind. `applyEnvEntries` re-checks,
  which covers any other caller.

  This is hardening, not a fix for a confirmed exploit — the same command already
  writes a provider import into `src/app.ts`, so a hostile package that reaches
  this code path has other paths too.

- cb46086: Report the port `guren dev` actually bound, and stop swallowing `PORT=0`

  `guren dev` carried its own copy of the entrypoint idiom this release removes
  elsewhere: `Number.parseInt(process.env.PORT ?? '', 10) || 3333`, which turns
  `PORT=0` into 3333 so "let the OS pick a free port" could not be expressed.

  It also announced `http://${hostname}:${port}` from the values it _requested_,
  without awaiting `listen()`. Those are not the bound values once the framework
  walks past a busy port — so the one line telling you where to point your browser
  was the line most likely to be wrong, and it printed the raw `0.0.0.0` wildcard
  rather than something dialable. It now awaits `listen()` and reports the address
  it returns, falling back to the requested values for an app whose installed
  `@guren/server` predates that return value.

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

- Updated dependencies [e38ac75]
- Updated dependencies [5e38d18]
  - @guren/orm@2.2.2

## 2.3.0

### Minor Changes

- 3453540: `guren check` now reports a `routes/*.ts` file whose registrar nothing reachable from the app's entry registrar calls.

  Such a file compiles, type-checks, and reads as wired from the inside — its only symptom is a 404 in production. That is the state `guren add admin|oauth|resource|auth` left behind in any app scaffolded from the blog blueprint, because the wiring step matched only a registrar whose parameter was literally named `router`. Fixing the scaffolders does nothing for the apps already in that state; this reports them, and names the import-and-call line to add. It also covers the files nothing wires automatically — `make:route` writes its routes file and leaves mounting to you.

  Mounting spreads outward from the entry file (`routes/web.ts`, or `--routes`) and is tracked per exported name: a file counts as mounted once some already-mounted file uses a binding that traces back to one of its registrar exports. So a nested registrar, a barrel re-export, a namespace import, an `await import()`, and a registrar the entry only re-exports all count — while an import with no call, an import of some _other_ export from the same file, and a registrar called only from a file that nothing calls in turn do not. A module's own `modules/<name>/routes.ts` is out of scope: `defineModule({ routes })` mounts it without going through the entry registrar. Content-activated — an app whose `routes/` holds nothing but the entry file contributes no results.

  Two wirings it cannot see, both reported as unmounted: a chain that leaves `routes/` (`web.ts` → `app/routing.ts` → `routes/admin.ts`), and a registrar reached by anything less direct than importing its file.

  Reported as a `warn`, like the console-command registration check, so plain `guren check` still exits zero. `guren check --ci` gates on non-advisory warns, so a project already using that flag will start failing on an unmounted routes file — which is the point, but it can surface on upgrade rather than on the commit that introduced it.

  That gate is in the CI workflow both app templates scaffold, and `make:route` deliberately leaves mounting to you — so `make:route` now says so on the spot rather than letting the next push explain it.

  Also fixes the entry file being _assumed_ to be `routes/web.ts` when no `--routes` was given: `guren check` and `guren doctor` now share one candidate list, so the API-only scaffold (`routes/api.ts`, no `routes/web.ts`) is read against its real entry.

### Patch Changes

- 72bd945: Guard the `add admin` dashboard by default, like `make:feature`

  `guren add admin` emitted `router.get('/admin', [AdminDashboardController, 'index'])`
  with no middleware and a controller with no auth call, and wired it into
  `routes/web.ts`. Nothing was disclosed — the page renders three hardcoded zeros —
  but it diverged from `make:feature`, which guards by default and offers
  `--public` to opt out, and the guide did not mention that the route was open. The
  first real query added to that dashboard made it an unauthenticated admin page.

  The route now carries `requireAuthenticated({ redirectTo: '/login' })` and the
  action calls `this.auth.userOrFail()`; `--public` restores the previous output.

  The middleware is attached inline rather than through an `'auth'` alias. This
  file lands in apps that may never have run `guren add auth`, and
  `aliasMiddleware('auth', …)` writes into the router shared with `routes/web.ts`,
  so registering it here would silently replace an alias the app configured with
  different options. On an app without auth installed the request is redirected to
  a `/login` that does not exist yet, rather than failing to boot.

- 4b2b283: Refuse `add admin` on an API-only app instead of scaffolding an unusable dashboard

  `guren add admin` scaffolds an Inertia dashboard, and on an app created from the
  `api` blueprint every file it wrote was unusable. The controller imports
  `@/.guren/pages.gen` and returns an Inertia response, so it did not typecheck
  against a `@guren/inertia-client` the API starter never installs — and running
  page codegen then added an import of that absent package. The route wiring
  targets `routes/web.ts`, which the API starter does not have (it registers
  `registerApiRoutes` from `routes/api.ts`), so `routes/admin.ts` was written but
  mounted by nothing and `GET /admin` returned 404. The CLI then printed that
  `/admin` requires a signed-in user and redirects to `/login`, which is not what
  the resulting app did.

  The blueprint now checks before its first write and fails with a message naming
  what it looked at, leaving nothing behind. Rejecting rather than emitting a JSON
  variant is deliberate: an admin endpoint worth generating needs a guard, and the
  auth stack that guard points at (`guren add auth`) is itself Inertia-shaped, so
  the API variant would either reference sign-in pages the CLI cannot install or
  be an unguarded stub.

  Detection requires positive evidence of the API-only shape — a readable
  `package.json` that does not declare `@guren/inertia-client`, **and** no
  `routes/web.ts` or `routes/web.js`. Either signal alone can be true of a working
  fullstack app (deps hoisted to a workspace root; a differently named entry file,
  which the route wiring already reports), and for a refusal the expensive mistake
  is blocking a command that would have worked. Every "cannot tell" — including a
  `package.json` that exists but cannot be read — permits the scaffold.

  The shared dependency probe behind it (`appDependsOn`) also replaces three
  hand-rolled copies of the same `package.json` read, in `guren plugin`,
  `guren make:test`, and the i18n type codegen. The codegen copy swallowed read
  errors and the new one has to as well: its augmentation is optional output, so
  an unreadable manifest must leave the translation keys as plain strings rather
  than abort the run.

  The `--public` next step is also reworded to describe what `routes/admin.ts`
  contains rather than how the running app behaves, so it can no longer contradict
  the wiring step when that step reports it could not reach a registrar.

- 2a6eef4: Refuse the auth scaffold on an API-only app instead of writing pages it cannot render

  `guren add auth` and `guren make:auth` scaffold an Inertia sign-in experience, and
  on an app created from the `api` blueprint none of it worked. The controllers
  return Inertia responses and the pages they name (`resources/js/pages/auth/*.tsx`,
  `resources/js/components/Layout.tsx`) are React components, so nothing typechecked
  against a `@guren/inertia-client` the API starter never installs. The route wiring
  targets `routes/web.ts`, which that starter does not have — it registers
  `registerApiRoutes` from `routes/api.ts` — so `routes/auth.ts` was written and
  mounted by nothing, and the CLI still printed that you could visit `/login`.

  Auth also patches `db/schema.ts` and generates a users migration, so the check runs
  before the first write rather than before the first file: a run stopped halfway
  through those leaves changes no `--force` rerun undoes. It refuses with a message
  naming both signals it read and leaves the app exactly as it was.

  The refusal points at the token flow the framework already ships —
  `createBearerTokenMiddleware` over a `DatabaseApiTokenStore` or
  `RedisApiTokenStore` — rather than scaffolding it. Generating that variant is a
  separate piece of work, not a smaller one: it needs a parallel set of controller
  and route templates for each of the four sign-in shapes this command supports, an
  `api_tokens` table and migration alongside the users one, a routes target other
  than the hardcoded `routes/web.ts`, and an answer for the registration, password
  reset, and email verification flows, which mail absolute links whose only landing
  pages are the ones being refused.

- 078bc93: Adapt `make:controller` and refuse `make:view` on an API-only app instead of writing Inertia files that cannot typecheck

  On an app scaffolded from the `api` blueprint, the controller `guren
make:controller` generated was the one file the app's own tsconfig would flag:
  it imports `@/.guren/pages.gen`, which codegen never writes there, and returns
  `this.inertia(...)` against a `@guren/inertia-client` that is not installed.
  Unlike the multi-file scaffolds (`add auth`, `add admin`, `add resource`), which
  refuse such an app, a lone controller has an obvious API dialect — so the
  template now adapts: on an app the two signals those refusals already read
  (no `@guren/inertia-client` dependency, no `routes/web.ts` or `routes/web.js`)
  confirm as API-only, the generated controller returns `this.json(...)` and can
  be wired into `routes/api.ts` as written. The refusals those scaffolds print
  now point at this command rather than telling you to write the controller by
  hand.

  `make:view` refuses on the same signals, because a page has no JSON dialect to
  adapt to — and the stray component would not stay harmless. The api starter's
  tsconfig skips `resources/`, but its own `dev` script runs `guren codegen`,
  which folds every page under `resources/js/pages` into `.guren/pages.gen.ts` —
  a file that tsconfig does include, importing the `@guren/inertia-client` the
  app never installs. One `make:view` flipped `typecheck` and `build` red two
  commands later, far from the command that caused it.

  The judgment stays positive-evidence only: whenever the signals cannot confirm
  an API-only app — no manifest to read, a hoisted workspace dependency, a web
  routes entry present — both commands behave exactly as before, and
  installing `@guren/inertia-client` switches an app back to the Inertia
  templates. Both commands judge the root the file is written into (resolved
  once and reused for the write), not the process directory, so `cwd`-passing
  callers such as the MCP server get the same answer the write acts on.

- eaafc8b: Refuse `make:feature` on an API-only app, the same way `add resource` does

  `guren make:feature` reaches the same Inertia-shaped scaffold as `guren add
resource` without passing through the blueprint registry, so the refusal that
  protects `add resource` did not cover it: on an API-only app it wrote the same
  unusable pages, controller, resource, validator, and model. It now refuses with
  the same message, after the same pure parsing — a usage error is still reported
  as one — and before its first write.

  Unlike the blueprints, which refuse an explicit `cwd` up front, `make:feature`
  honours one, so its check judges the root it writes into rather than the
  directory the process happens to sit in.

- ae79279: fix(cli): detect controller body accessors in `guren audit`

  The A03 body-validation rule only recognized raw request reads (`this.request.json()`, `req.parseBody()`, …), so an action that read the payload through the documented controller helpers was reported as a pass ("does not consume the request body"). `this.input()`, `this.only()`, `this.except()`, `this.file()` and `this.files()` are now detected, including their generic forms — nested type arguments such as `this.input<Record<string, unknown>>('meta')` included.

  An action that only calls `this.has()` still passes, since a presence check yields no unvalidated value, but its finding no longer claims the body went unread.

  The accessor list is derived from a classification of `Controller`'s full public/protected surface, pinned by a test that re-parses `Controller.ts` — a new accessor added there now fails that test instead of silently defaulting to undetected. The `validateBody`/`validateBodySafe` detection is derived from the same classification, so it can no longer drift out of step with it.

- e22b10f: Stop codegen writing a pages manifest into an app that cannot compile one

  `.guren/pages.gen.ts` imports `@guren/inertia-client`. An app scaffolded from the
  `api` blueprint does not install that package, and its `tsconfig.json` includes
  `.guren/**` (but not `resources/`), so a manifest generated there fails `tsc` on
  its first line. Nothing prevented one: `generatePageTypes` wrote a manifest
  whenever `resources/js/pages` contained a component, and that directory can fill
  up without anyone asking for it — a hand-copied page, a checkout, a generator
  written later — while the api starter's `dev` script runs codegen on every start.

  `guren check` already claimed this could not happen ("codegen never emits it in an
  API-only app"), and `guren doctor` leaned on the same claim silently. Neither
  enforced it. Codegen now owns the rule: `planPageManifest` answers "does this app
  get a pages manifest?" from the page components _and_ `isConfirmedApiOnlyApp`, and
  check and doctor read that answer rather than restating it.

  Withholding the file inverts the risk that predicate was written for — where a
  wrong answer used to block a command loudly, it would now quietly deny a file
  every controller imports — so the suppressed state is reported rather than
  silent. `guren codegen` warns instead of printing a generated path, the MCP
  codegen tool reports the reason rather than "nothing to generate", and check and
  doctor both surface it, most sharply when a manifest generated before the app took
  this shape is still on disk: that leftover is what fails the typecheck, and both
  tools used to call it healthy on the strength of it merely existing. It outlives
  the page components that produced it, so it is reported even once they are
  deleted. Codegen does not delete it — if the rule is ever wrong about an app,
  removing the manifest turns a type error into a mystery — so the report names the
  file and both corrections: delete it, or declare the `@guren/inertia-client`
  dependency and `routes/web.ts` that make this a fullstack app.

  Severity follows the same rule: the leftover manifest really does fail `tsc`, so
  `guren check --ci` gates on it, while page components an API-only app simply never
  renders are advisory — failing a build over unused files would be its own bug.

  `make:view`'s refusal stands, but its reason changes with this: a page component
  in such an app is no longer a delayed `typecheck` failure, it is a screen nothing
  can reach, and the refusal is about saying so at the command that caused it. Its
  doc comment and the CLI guide now say that instead of restating a chain codegen
  no longer lets happen.

- b590b24: Wire providers into the app entry through one registrar that writes once

  Three implementations of "register a provider in the app entry and report the
  outcome" coexisted — the blueprints' `installProvider`, `make:auth`'s
  `wireProvider`, and two inline copies inside `make:auth` for the framework's own
  mail and OAuth service providers. They are now one shared helper, which closes
  the gaps between them.

  `guren add cache` — and every other infrastructure blueprint, and `guren plugin`
  — probed only `src/app.ts`. An app that keeps its entry at the root (`app.ts`,
  which `guren add auth` and `guren make:module` both already found) was reported
  as having no app file at all. The entry now comes from one shared candidate
  list, and the generated import is relative to whichever entry was found, so a
  root `app.ts` gets `./app/Providers/CacheProvider.js` rather than a path that
  climbs out of the project.

  `guren add auth` still added each provider's import _before_ registering it, as
  did `guren plugin`. On an app whose `providers: [ ... ]` array cannot be located
  — a hand-edited entry, or one that never had the array — the run reported a
  failure having already written an import nothing references, which stops the app
  compiling under `noUnusedLocals`. `guren plugin` was the worst of the two: it
  throws rather than warning, so it left the orphan import behind and refused to
  finish.

  Registering before importing, as the blueprints already did, is not the whole
  fix. The two patches each read and rewrite the entry independently, so whichever
  runs second can fail on its own — a permissions change, a full disk, an
  interrupt — and the state that leaves, "registered but not imported", is worse
  than the one being avoided: an unresolved identifier throws at runtime rather
  than merely failing a lint. Both edits are now composed in memory, through a
  pure `insertProvider` beside the existing `insertImport`, and applied in a
  single write. An entry that cannot take one half receives neither. This is the
  shape `addRouteRegistrarCall` already used for the same reason, and what
  `insertImport`'s own documentation was written for.

  `guren make:module` had the same import-first hazard against its
  `modules: [ ... ]` patch, and is fixed the same way.

  Reporting stays per command, because the three callers genuinely differ: the
  blueprints warn and name what to register by hand, `guren add auth` narrates
  each step, and `guren plugin` throws and collects structured messages rather
  than touching the console. Only the entry resolution and the patch primitive are
  shared. One nicety falls out of the consolidation — inside a single
  `guren add auth` run, the framework's own service providers now report the way
  the scaffolded ones always did, instead of staying silent when they were already
  registered.

- be4fa25: Refuse `add resource` before it patches anything, instead of failing halfway through

  `guren add resource` edits two files the app owns: it appends a table to
  `db/schema.ts` and registers the CRUD routes in `routes/web.ts`. Refusing the
  API-only app took the common case out of that path, and named what it left
  behind: an app that declares `@guren/inertia-client`, or that has no manifest to
  read at all, is permitted on purpose — a shape check has to answer "cannot tell"
  with "proceed" — and still walked into an unguarded `readFile`. That is what this
  finishes.

  Both reads were unguarded, so those apps failed with a raw `ENOENT: no such file
or directory` and a seven-frame `node:fs` stack. Missing `db/schema.ts` failed
  first and wrote nothing; missing `routes/web.ts` was the damaging one, because
  that read runs _after_ the schema patch — by then eight scaffolded files were on
  disk _and_ the app's own `db/schema.ts` carried a table for routes that were
  never registered. Deleting the scaffold does not undo that.

  The blueprint now settles both patches before its first write: the schema file
  must exist, the routes file must exist, and — unless the routes are already
  registered — the routes file must expose a registrar to patch. Each refusal names
  the file it wanted and writes nothing. The last of the three replaces a throw
  that already had this message but only reached it after the schema patch and the
  scaffold.

  The order of the two checks matters and is deliberate: the shape refusal runs
  first, so an app it recognizes hears about being API-only rather than about a
  missing file.

  Scoped to those three questions on purpose. This is not a promise that the
  patches will succeed: a target that exists but cannot be read or written still
  fails in the writer, exactly as before. What it removes is the failure the
  command could see coming.

  Reordering the two patches was the other option and does not work: it only
  chooses which of the app's files is left half-edited. Routes-first would patch
  `routes/web.ts` with a controller and validator import for a table that does not
  exist, which is the worse of the two, since that is the edit that stops the app
  compiling.

  `add admin` still warns rather than throwing in the comparable case, and that
  asymmetry stays. Its output is self-contained — a controller, a page, and its own
  `routes/admin.ts` — so a warning leaves a complete scaffold the developer can
  wire by hand. `add resource` has no such fallback: its controller and validator
  imports are dead without registration, and its patches target files it did not
  create.

- d7f4cb5: Refuse `add resource` on an API-only app instead of half-scaffolding and then crashing

  `guren add resource` is Inertia-shaped end to end, and on an app created from the
  `api` blueprint it wrote eight unusable files before failing. The four page
  components under `resources/js/pages/<collection>/` are React, the controller
  returns Inertia responses and imports `@/.guren/pages.gen`, and none of it
  typechecks against a `@guren/inertia-client` the API starter never installs.

  The failure then arrived from the wrong place. `updateResourceRoutes` opens
  `routes/web.ts` unconditionally, and the API starter registers
  `registerApiRoutes` from `routes/api.ts` instead, so the run ended in a raw
  `ENOENT: no such file or directory, open '.../routes/web.ts'` with a stack trace
  through `node:fs` — not a message about the app being the wrong shape for the
  command. Everything already written stayed on disk.

  That included one file the user wrote themselves: `updateResourceSchema` runs
  before the route wiring, so a `posts` table was appended to `db/schema.ts`.
  Deleting a scaffold does not undo that, which is what makes this worse than the
  same bug in `add admin` — there, every casualty was a new file.

  The blueprint now goes through `assertNotApiOnly()`, the same refusal the `admin`
  and `auth` scaffolds use, and fails with a message naming the Inertia-shaped
  output and the two signals it read, leaving nothing behind. The check runs after
  the name and `--fields` parsing, which are pure, so a bad invocation on an
  API-only app is still reported as a bad invocation rather than masked by the
  app's shape.

  An app that does declare the client but has no `routes/web.ts` is still
  permitted, and still fails inside `updateResourceRoutes` — as does any app whose
  routes file has no registrar, which has always thrown after the schema write.
  That residue is untouched here and pinned by a test so the two failures cannot
  be mistaken for each other.

- c84d760: Stop `add resource` from reading an unrelated path as "these routes are already registered"

  `guren add resource` skips its route registration when the app already has the
  routes, and one of the two signals it looked for matched the collection slug as
  a quoted-path suffix. An app with an unrelated `router.get('/admin/posts',
...)` therefore answered yes for a `Post` resource: the run reported success,
  `db/schema.ts` got the `posts` table, eight files were scaffolded, and the
  controller and validator imports were appended to `routes/web.ts` — but no route
  group was ever registered. The two imports are then bindings nothing uses, which
  stops the app compiling under `noUnusedLocals`.

  The path signal is now anchored on both sides, matching the full literal the
  registration emits (`'/posts'`), the way the sibling `'posts.index'` signal
  already was. The imports also moved inside the guard: they exist for the group,
  so a run that (correctly) skips registration — an app that hand-wired `/posts`
  itself — no longer appends imports nothing uses either.

  Both signals are still needed and neither is redundant. An app that hand-wired
  `/posts` has none of the generated `.name()` calls, so the path literal is the
  only thing left to recognise it by — anchoring any tighter than the quoted path
  would register a second, conflicting set of routes over it.

  One behavior change beyond the fix: an app that registers the resource under a
  prefix without the literal (`router.group('/blog/posts', ...)` with no `posts.*`
  route names) now gets a `/posts` group inserted rather than being skipped. That
  app genuinely has no `/posts` routes, so registering them is the correct reading
  — but it is a change from what the previous match did. A nested prefix that does
  contain the literal (`router.group('/admin', (admin) => admin.get('/posts', ...))`)
  still suppresses registration; that is the honest boundary of matching source
  text rather than resolving the route table.

- 633c9bc: Extend `guren check`'s route registrar wiring to application modules

  The wiring check flagged a `routes/*.ts` file whose registrar nothing reachable
  from the app's entry registrar calls — but only under the project's own
  `routes/`. `make:route Foo --module billing` writes to
  `modules/billing/routes/Foo.ts`, where the file that has to mount it is not the
  app's entry at all: a module mounts routes through `defineModule({ routes })`,
  which names exactly one registrar, `modules/billing/routes.ts`. A file beside
  it was mounted by nothing, and no check reported the gap.

  The check now asks the same question once per scope: the project's `routes/`
  against the app's entry, and each module's `routes/` against the registrar its
  own `defineModule({ routes })` names — resolved from the descriptor, the same
  link the runtime follows, rather than guessed from a conventional filename.
  That resolution is what keeps both directions honest: a descriptor with no
  `routes` property mounts nothing however well-wired `routes.ts` is internally
  (reported as one warning at the descriptor, since that is where the fix is),
  and a descriptor naming `routes/index.ts` mounts that file even when a stale
  `routes.ts` sits beside it. A `routes` value the check cannot trace to a file
  skips the module rather than judging it against the wrong entry — this check
  misses orphans, it does not invent them. Scopes share no state, so one
  module's registrar cannot credit another module's identically named
  `registerRoutes`, and mounting a module's file from `routes/web.ts` does not
  count — that import crosses the module boundary without making the module
  mount anything. The `--changed` gate wakes for `modules/<name>/routes` and
  `modules/<name>/index.ts` edits too — deleting `routes:` from `defineModule()`
  severs every module route while changing only the descriptor. Modules without
  a `routes/` directory — the shape `make:module` scaffolds — contribute
  nothing, as before.

  `make:route`'s next-step hint now says `guren check` reports the gap, which
  used to be true only at the project root.

- 2c5886e: Wire scaffolded route files into the registrar the framework actually calls

  `guren add admin`, `guren add oauth`, `guren add resource`, and `guren add auth`
  located the app's route registrar with a regex that only matched `export
function register*Routes(router: Router)`. An app scaffolded from the blog
  blueprint names that parameter `baseRouter`, so the routes file was written but
  never imported or called — and because the wiring ran inside a `try {} catch {}`,
  nothing was reported.

  The registrar is now found by parsing `routes/web.ts` and selecting the export
  the route loader itself resolves, so any parameter name, a multi-line signature,
  an arrow-function or default-export registrar, and a `Router` imported under an
  alias all wire correctly, while an unrelated exported helper that merely takes a
  router does not. The generated call passes the registrar's own parameter, which
  is the only name guaranteed to be in scope. The call and its import land in one
  write, so a routes file that cannot be patched is left untouched instead of
  gaining an import for routes nothing registers — and that outcome is now
  reported rather than swallowed.

- d3da91c: Wake the screens spec drift gate for module files under `--changed`

  `guren check --spec --changed` decides which spec views to regenerate by
  matching changed paths against each view's source patterns. The screens view
  listed only `modules/*/routes.ts` and `modules/*/index.ts`, but the route
  graph is a runtime import: `loadRouteDefinitions` evaluates
  `modules/<name>/index.ts` and everything the module registrar reaches from
  there — files under `modules/<name>/routes/` (where `make:route --module`
  writes), a prefix constant, or any other module file. A change touching only
  such a file reported `screens.md` as fresh while it was stale, and `--spec`
  sets the exit code, so CI waved the drift through. The screens view's module
  source now matches the whole `modules/<name>/` tree; over-selection only
  costs a regeneration, and the modules view already matched any source file
  for the same reason.

- Updated dependencies [72bd945]
- Updated dependencies [72bd945]
- Updated dependencies [de3298b]
- Updated dependencies [19f7119]
- Updated dependencies [b210a53]
  - @guren/core@1.5.2
  - @guren/orm@2.2.1

## 2.2.0

### Minor Changes

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

### Patch Changes

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

- Updated dependencies [80ef7b1]
- Updated dependencies [80ef7b1]
- Updated dependencies [80ef7b1]
- Updated dependencies [80ef7b1]
  - @guren/core@1.5.1
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

- fe70ee7: Add typed allowlist options to `defineModel`: `fillable`, `hidden`, `visible`, `accessors`, and `appends` can now be passed as options, checked at compile time against the table's columns (and, for `fillable`, fields contributed by the `base` such as `AuthenticatableModel`'s virtual `password`). Accessor functions receive the table's inferred record, and `appends` may only name declared accessors. `static` declarations keep working and shadow the options. `guren audit` and `guren check` recognize the option form with the same shadowing order.

### Patch Changes

- 3ab375c: `guren audit` flags outbound links built from the request host

  The auth scaffold used to build password-reset links from the request:

  ```js
  buildPasswordResetUrl(
    `${new URL(this.request.url).origin}/reset-password`,
    token,
    email
  );
  ```

  A request URL is reconstructed from the `Host` header, which any client can
  forge, so an unauthenticated attacker could `POST /forgot-password` with a
  victim's address and `Host: attacker.tld` and have the app mail that victim a
  genuine single-use reset token pointing at the attacker's server.

  Routing scaffolded links through `app/Auth/AppUrl.ts` fixed the _generated_
  output, which does nothing for the two populations that still have the bug:
  apps scaffolded before that release — told to hand-patch or re-run
  `guren add auth --force` — and anyone who wrote the controller themselves.
  `guren audit` ships with the CLI those users already run, so it is the one
  mechanism that reaches them. It returned green on the exact code the fix calls
  exploitable; it now warns:

  ```
  [warn] [A07] app/Http/Controllers/Auth/ForgotPasswordController.ts:26: Absolute
  link built from the request host — the Host header is client-controlled, so a
  forged host makes the app send a genuine single-use token pointing at the
  attacker's server.
       → Build the base URL from process.env.APP_URL instead of the request
  ```

  The rule fires on a request-derived origin (`new URL(req.url)`), on a
  `host`/`x-forwarded-host` header read off the request, and on a request URL
  handed straight to a link builder — but only in a file that also names one of
  the framework's outbound-link builders (`buildTokenUrl` and its
  `buildPasswordResetUrl`, `buildVerificationUrl`, and `buildOAuthRedirectUrl`
  aliases). That second half is what keeps the generated `app/Auth/AppUrl.ts`
  clean: its non-production fallback returns a request origin on purpose, and it
  builds no link. Gating on behaviour rather than exempting the helper by path
  means the exemption survives a rename. Middleware that parses the request URL
  only to reach its path never matches. Use `// guren-audit-ignore` for a link
  that never leaves the app.

  Because that gate is a hand-maintained name list, a builder added to
  `@guren/core` would otherwise reach users as an affirmative _pass_. An audit
  test enumerates `@guren/core`'s `build*Url` exports against the list, with
  `buildOAuthAuthorizeUrl` as a documented exclusion — it builds the provider's
  authorize URL, a real but different risk this finding's wording would
  misdescribe.

  The boundary, stated so a green audit doesn't imply more than it checks: a
  controller that mails a link assembled by hand, without going through those
  builders, is not covered. Widening the gate to guessed-at mail helper names
  would trade a real false-positive cost for speculative coverage. The finding is
  worded conditionally for the same reason — co-occurrence in one file is not
  proof the host reaches the link.

  Note the rule also fires on `process.env.APP_URL ?? new URL(req.url).origin`.
  That is deliberate rather than a false positive — the fallback is fail-open, so
  a forged host still works whenever `APP_URL` is unset, which is exactly the
  production misconfiguration the scaffolded helper throws on instead.

  Findings are classified A07 / CWE-640, so `--json` consumers and the console
  prefix stay consistent with the other rules.

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

- 5944166: Share the signed-in user with Inertia pages from `guren add auth`'s AuthProvider

  The `AuthProvider` scaffolded by `guren add auth` configured the auth manager
  but never registered a shared Inertia prop resolver, so `props.auth.user` was
  always `undefined` on every page. The `Layout.tsx` generated by the same command
  reads exactly that prop to choose between "Sign in" and "Log out" — so a
  freshly scaffolded app rendered the guest navigation even while signed in, and
  the only way out was to hand-wire `shareInertiaProps` yourself.

  The generated provider now has a `boot()` that shares the (already sanitized)
  user, matching the `blog` blueprint's provider, which got the same treatment
  earlier. Both copies are now pinned to the same snippet in the CLI's test suite
  so they cannot silently drift apart again.

  Existing apps are unaffected — re-run `guren add auth --force`, or add the
  `boot()` by hand:

  ```ts
  import { shareInertiaProps, AUTH_CONTEXT_KEY } from '@guren/core'
  import type { AuthContext } from '@guren/core'

  boot(): void {
    shareInertiaProps(async (ctx) => {
      const auth = ctx.get(AUTH_CONTEXT_KEY) as AuthContext | undefined
      return { auth: { user: await auth?.user() } }
    })
  }
  ```

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

### Minor Changes

- 2c944f0: Flag Postgres timestamp columns declared without a time zone in `guren check`

  Every Guren scaffold now emits `timestamp(name, { withTimezone: true })` for
  Postgres, but nothing caught an offset-less column in a schema written by hand
  or by an AI agent reproducing an older pattern. `guren check` now warns on one.

  `timestamp without time zone` stores a bare wall clock, and who reads it decides
  what that clock meant: `defaultNow()` records the wall clock of the _database
  session's_ zone while the app reads the column back as UTC — so on a non-UTC
  session the stored instant is simply wrong — and any non-Drizzle reader (psql, a
  report, another service) sees a different instant than the app does for values
  the app wrote itself.

  ```
  [warn] posts.createdAt time zone: Postgres column 'created_at' is 'timestamp
         without time zone', which stores a bare wall clock: ...
       → In db/schema.ts, declare it as timestamp('created_at', { withTimezone: true })
         and generate a migration. ...
  ```

  Postgres only, decided per table by the factory that declared it (`pgTable`),
  not per file — so a schema mixing dialects is judged a table at a time. MySQL
  has no `timestamptz` and its `TIMESTAMP` is already UTC-normalized, so its bare
  `timestamp('created_at')` is correct and stays silent even though it is spelled
  identically; sqlite stores epoch integers via `integer(..., { mode })`.

  The result is a `warn` in the core suite, which means it is **informational**:
  plain `guren check` has never set an exit code, and only `--arch` / `--docs` /
  `--spec` gate CI. This will not fail a build — fixing an existing column
  requires a migration whose `USING` clause needs a human decision about which
  zone the stored rows were written in.

  Silence is not proof. The schema is read statically and nothing resolves an
  identifier back to what it names, so several legal spellings are skipped rather
  than misjudged: columns introduced by a spread (`...timestamps`, the
  shared-column idiom), builders reached through an alias (`timestamp as ts`) or a
  namespace (`p.timestamp(...)`), options passed as an expression
  (`timestamp('created_at', SHARED_OPTIONS)`), and tables declared in a file the
  schema merely re-exports. Reporting a column that is actually fine would cost
  more than missing one — the fix this suggests is a migration.

  `parseSchemaTables` grew the facts the rule needed: `SchemaTable.dialect`, plus
  `SchemaColumn.withTimezone` (as written — `true`, `false`, or absent),
  `SchemaColumn.columnName` (the database name, so the suggestion quotes the
  column rather than the object key it is declared under), and
  `SchemaColumn.opaqueOptions` (set when the options were not an inline object, so
  an absent one reads as "not visible" rather than "not set").

- 63fd323: Let `defineModel()` reshape the inferred create payload without a cast.

  `defineModel(table)` infers `createType` from the table, which requires every
  non-defaulted column — the wrong shape for a model that fills a column in
  itself. `AuthenticatableModel` is the standing example: it hashes a plain
  `password` into `passwordHash`, so callers pass the former and not the latter,
  and until now the only way to say so was to skip `defineModel()` entirely and
  redeclare the type markers by hand.

  Two type-level options replace that:

  ```ts
  export class User extends defineModel(users, {
    base: AuthenticatableModel,
    optionalOnCreate: ["passwordHash"],
    requireOnCreate: ["password"],
  }) {
    static guarded = ["id", "passwordHash", "rememberToken"];
    static override hidden = ["passwordHash", "rememberToken"];
  }
  ```

  `optionalOnCreate` makes columns optional — they keep their type, callers just
  need not supply them. `requireOnCreate` goes the other way, accepting both
  table columns (Drizzle marks defaulted ones optional) and named fields
  contributed by `base`. Both are checked against the real keys, so a typo fails
  to compile, and neither has a runtime effect. Neither closes the payload
  either: a create type always admits unknown keys as `unknown`, so
  `fillable`/`guarded` remain what reject an unwanted field at runtime.

  `make:auth` now generates this shape — with `requireOnCreate` only when
  password sign-up is the sole way in, since OAuth accounts are created without
  one — and guards `passwordHash` against mass assignment, which the scaffolded
  model previously left on its default.

  The `createType` option is deprecated in favour of these: it needs a value to
  infer from, which is exactly the cast this removes. It still works, and
  `defineModel<TTable, TBase, TCreate>()` still means what it did — the two new
  type parameters go after `TCreate`, not before it.

  Also fixes `guren audit`: its sensitive-column check resolved a model's table
  only from `static table = users`, so it silently skipped any model written as
  `defineModel(users, …)` — including every model this release migrates.

- f5911d4: Ship a `.gitignore` with scaffolded apps and offer an initial commit.

  npm strips files literally named `.gitignore` from published tarballs, so every
  app scaffolded from the registry came out without one — `git init` immediately
  staged `node_modules/`, build output, and the generated `.env`. Templates now
  carry the file as `_gitignore` and the scaffolder restores the dot after each
  template layer copies — collected from the copy itself, so a `--force` scaffold
  never renames files it did not write. The default list also covers
  `public/assets/`, `.guren/ssr/`, and `.DS_Store`.

  `create-guren-app` (and `guren new`) gained a `--git` / `--no-git` flag that
  initializes a repository and creates an initial commit once the harness and
  optional auth scaffolding are in place. It is prompted in an interactive
  terminal, off in non-interactive ones, and skipped when the target directory is
  already inside a git repository or already contained files — an initial commit
  must never sweep up anything the scaffolder did not write.

- ec0233d: Scaffold Postgres timestamp columns as `timestamptz`

  Every timestamp a Guren scaffold emitted for Postgres was `timestamp without
time zone`: `add resource`'s `date` fields, the `createdAt` it appends, the
  `createdAt`/`updatedAt`/`emailVerifiedAt` on `make:auth`'s users table, and the
  `users` table `create-guren-app --db postgres` writes. All of them hold an
  instant, so all of them are now `timestamp(name, { withTimezone: true })`.

  A column without a time zone stores a bare wall clock, and who reads it decides
  what that clock meant:

  - `defaultNow()` records the wall clock of the **database session's** time zone,
    while the app reads the column back as if it were UTC. Whenever the database
    session is not on UTC, a `createdAt` is silently off by that offset — the
    wrong instant is written, not merely displayed.
  - Values the app writes itself are UTC wall clock, so anything that is not
    Drizzle — `psql`, a raw `postgres` query, a report, another service — reads
    them as local time and sees a different instant.

  Drizzle parses the offset-less column as UTC, so an app that only ever reads
  through its own models stays self-consistent; `timestamptz` is what makes the
  column mean the same instant to everyone else.

  This changes generated code only — existing schemas are untouched. To adopt it
  in an app that has already migrated, change the column in `db/schema.ts` and
  generate a migration, then fix up the `USING` clause. Drizzle emits a bare
  `::timestamp with time zone` cast, which reinterprets stored values against
  whatever the session's time zone happens to be; name the zone the values were
  actually written in instead:

  ```sql
  ALTER TABLE "posts"
    ALTER COLUMN "published_at" SET DATA TYPE timestamp with time zone
    USING "published_at" AT TIME ZONE 'UTC';
  ```

  `'UTC'` is right for values the app wrote. If the column also carries
  `defaultNow()` rows, they were written in the database session's zone — check
  it with `SHOW TimeZone` before converting, and split the conversion if the two
  sets of rows disagree.

- 1bccf80: feat: the schema walkers read the zod 4 API only, and refuse zod 3 loudly

  The TypeScript-type renderer (`guren codegen`, `guren context`) and the OpenAPI
  generator previously walked both Zod majors. The two dialects disagree about
  the meaning of `_def.type` — v3 stores a nested schema there, v4 the type
  name — and that ambiguity is what produced the walker bugs that had to be
  fixed twice. Since every Guren scaffold has always pinned zod 4, the walkers
  now read the v4 layout exclusively.

  A schema authored with the zod v3 API — whether from the old `zod@3` package
  or the `zod/v3` subpath that zod 4 itself ships — is detected (only v3 sets
  `_def.typeName`) and refused with an explicit message instead of being
  rendered wrong or silently dropped: the CLI warns once per process, the
  OpenAPI document records a warning naming the schema's location. The message
  lives in `@guren/core/internal/zod-compat` as `ZOD3_UNSUPPORTED_MESSAGE`, so
  the two surfaces cannot drift apart. Detection runs on every node, not just
  at the walk's entry — a v3 node nested inside a v4 object (which nothing but
  the type system prevents) is refused too, and the OpenAPI request-body
  `required` probe survives the `safeParse` throw such a hybrid produces in
  zod 4 rather than crashing document generation.

  Dropping the v3 dialect also deletes code that was unreachable under v4:
  the `pipeline`, `discriminatedunion`, and `nativeenum` case labels (v4 names
  them `pipe`, `union`, and `enum`), the `effects` and `branded` wrapper names
  (v4 has no such nodes — `.brand()` adds nothing at runtime), and the
  function-shaped `_def.shape` read.

  Two behavior improvements ride along, both in enum handling (`z.nativeEnum`
  produces the same node as `z.enum` in zod 4). Documented values are now read
  from zod's own computed set (`_zod.values`) instead of re-derived from the
  entries object, so what the document lists is what zod parses by
  construction: reverse mappings of a numeric TypeScript enum (`{ A: 0,
'0': 'A' }`) no longer leak into the OpenAPI `enum` list, and the derivation
  has no false positives — a hand-rolled reverse-mapping filter would wrongly
  drop a member whose string value collides with another key (`{ A: 'B',
B: 1 }`). A mixed string/number enum also documents as
  `type: ['string', 'number']` rather than `number`. The `zod/v3` subpath was
  never used by any Guren template, example, or generated app.

### Patch Changes

- 55d6a28: Make the generated API client CSRF-safe by default. `createApiClient()` now
  copies the `XSRF-TOKEN` cookie into the `X-XSRF-TOKEN` header on
  state-changing requests, so `client.request('posts.store', { body })` no
  longer gets a 403 from the CSRF middleware that ships enabled by default.

  The copy happens only when the request targets the page's own origin — the
  cookie belongs to that origin, and sending it to a third-party `baseUrl`
  would disclose the page's CSRF token. A cross-origin client, or one talking
  to a server configured with `csrf({ cookie: false })`, supplies its own
  `X-XSRF-TOKEN` header; caller-supplied `X-XSRF-TOKEN` / `X-CSRF-TOKEN`
  headers are left untouched whatever their casing. The cookie is read through
  `globalThis`, so the generated module stays import-safe during SSR.

  Requests also carry an explicit `credentials: 'same-origin'` — the fetch
  default, now overridable through the new `credentials` option.

- 5c91e8e: Append a compact Guren API signature digest to the `guren context` project map
  so coding agents see the exact ORM, controller, and testing signatures at
  session start — before their first edit attaches the glob-scoped rule files.
  The digest rides on every markdown rendering of the map: the agent harness's
  SessionStart hook and the markdown format of the `guren_get_context` MCP tool.
  Installed apps pick it up with a CLI upgrade alone.
- e2c82da: Type the seeder context against the app's own database dialect

  `SeederContext.db` was hard-typed as `PostgresJsDatabase`, so every seeder was
  typed against PostgreSQL no matter which database the app configured. On MySQL
  and SQLite that made the seeder reject its own `db/schema.ts` — `db.insert()`
  does not accept a `mysqlTable`/`sqliteTable`, and `.onDuplicateKeyUpdate()` is
  not a method on the PostgreSQL insert builder at all. The runtime was always
  fine: the callback receives the real database.

  It was invisible in the default scaffold because `db/` was outside the app's
  `tsconfig.json` `include`, but not everywhere — the API-only template already
  typechecks `db/`, so `guren add auth` on a `--db mysql` API app failed
  `bun run typecheck` on the seeder it had just generated.

  `SeederContext` and `SeederHandler` are now generic over the database, with the
  same `PostgresJsDatabase` default as before, so existing seeders keep compiling.
  `PostgresSeederContext`, `MySqlSeederContext`, `SqliteSeederContext`, and
  `AwsDataApiSeederContext` are exported for the other drivers that seed (D1 does
  not — its `seedDatabase()` throws), and scaffolded apps re-export the one they
  configured from `config/database.ts` as `AppSeederContext`:

  ```ts
  import { defineSeeder } from "@guren/core";
  import type { AppSeederContext } from "../../config/database.js";

  export default defineSeeder(async ({ db }: AppSeederContext) => {
    /* ... */
  });
  ```

  `guren add auth` and `make:seeder` now annotate what they generate, and `db/`
  joined the default template's `tsconfig.json` `include` so the generated
  seeders and schema are actually typechecked. `runSeeders()` and `loadSeeders()`
  accept any dialect's database, which drops the casts the MySQL, SQLite, and
  Aurora Data API drivers needed.

- 22f2526: Remove the `blog` blueprint and guard against unpublishable template layers

  `--blueprint blog` never worked from a published `create-guren-app`. Its overlay
  layer resolved to `examples/blog`, which lives outside the package and is not
  covered by the `files` field, so from npm the command failed with a raw ENOENT
  inside `cp` after already copying the base template — leaving a half-scaffolded
  directory behind. `--help` advertised the blueprint the whole time.

  The blueprint was also broken independently of packaging: its hand-maintained
  copy of the blog schema had drifted from the columns its controllers used, and
  it pinned `@inertiajs/core` to a major version behind the `@inertiajs/react` the
  template installs, so a generated app did not typecheck even inside the
  monorepo. Restoring it means shipping a curated template under `templates/` with
  smoke coverage, which is tracked separately; advertising it meanwhile was worse
  than removing it. `--blueprint blog` now reports the blueprints that do exist.

  Template layers are now named rather than pathed, so a layer outside the
  published `templates/` directory is a type error instead of something a test has
  to catch. `scaffoldAppBlueprint()` also verifies each template exists before it
  copies anything, so a corrupted install reports which blueprint and directory are
  missing instead of an ENOENT, rather than failing part-way through the copy.

- Check the table a model actually binds, not one guessed from its class name

  `guren check`'s model-schema result derived a table name from the model class
  (`Post` → `posts`) and asserted that string appeared somewhere in the schema
  file's raw text. That reported two kinds of nonsense: a model binding the
  wrong identifier passed as long as the guessed name occurred anywhere in the
  schema — a column name or a comment was enough — and any model not named
  after its table (`Post` bound to `blog_posts`, `User` bound to `accounts`)
  warned even though it was correct.

  The check now resolves the identifier the model actually binds —
  `defineModel(x)`, `static table = x`, or either reached through a mixin like
  `SoftDeletes(defineModel(x))` — and matches it against the tables the
  project's schema declares, following an aliased import
  (`import { posts as postTable }`) back to the schema's exported name first.
  This is the same model-to-table join `guren context <Entity>` and `guren
audit` already use.

  A model whose binding cannot be read, or a schema that declares no readable
  tables, is skipped rather than warned on — neither is evidence of a problem.

  Still informational: this result is a `warn` in the core suite and does not
  set the exit code.

- 02eb9cd: Keep `--db mysql` scaffolds on the MySQL dialect end to end

  `create-guren-app --db mysql` generated a `db/schema.ts` that imported
  `mysqlTable, int, varchar, timestamp` from `@guren/orm/drizzle`. That subpath
  re-exports the PostgreSQL column builders under the unqualified names, so the
  MySQL `users` table was built out of a pg `timestamp`. Nothing reported it:
  drizzle-kit still emitted the same MySQL DDL and the app still typechecked.

  It did leak further, though. `guren add auth` and `add resource` merge new
  columns into the schema's `drizzle-orm/mysql-core` import and skip any name
  already visible in some import line — so with a pg `timestamp` in scope, every
  later date column silently stayed on the wrong dialect too. The scaffold now
  imports from `drizzle-orm/mysql-core`, matching what the patchers emit and what
  the SQLite scaffold already did.

  The demo-user seeder `guren add auth` writes is now dialect-aware. It used
  `.onConflictDoNothing()` unconditionally, which does not exist on MySQL's query
  builder — `db:seed` threw `onConflictDoNothing is not a function` on every MySQL
  app. MySQL now gets the equivalent `.onDuplicateKeyUpdate()` form.

- 396194d: Use one pluralization rule across scaffolding and `guren check`

  `guren add resource Category` wrote `export const categories` into
  `db/schema.ts` but generated `import { categorys } from '../../db/schema.js'`
  in `app/Models/Category.ts` — the model did not compile. `guren check` then
  looked for a table named `categorys` and warned that the table it had just
  written was missing. Any entity ending in consonant + `y`, or in
  `s`/`x`/`z`/`ch`/`sh`, hit this: `Category`, `Box`, `Match`, `Dish`.

  The three sites derived the name independently. `make:feature` and the
  `resource` blueprint carried byte-identical copies of one rule (`-ies` / `-es` /
  `-s`); `make:model` and `check` used a separate `+ 's'`. They now share
  `collectionName()` in `packages/cli/src/inflect.ts`, and the schema writer and
  `check` share one `tableNameFor()` so the table name has a single derivation
  rather than two that happen to agree.

  `check`'s lookup was also wrong for every multi-word model regardless of
  plural form — `UserProfile` resolved to `userprofiles` while the table is
  `user_profiles`, so it warned on models that were fine.

  `make:route` was a fourth rule again — it stripped one trailing `s` unless the
  name ended in `ss`, so `make:route categories` scaffolded a `CategorieController`
  that `make:feature Category` never generates. It now singularizes the same way.

  Names that reach a database identifier tolerate already-plural input, so
  `make:model News` keeps importing `news` rather than `newses`. Route paths,
  page directories, and generated type names pluralize directly and are
  unchanged — a lone trailing `s` cannot be read reliably (`News` and `Status`
  are structurally identical), so only the names that have to agree across files
  pay for that tolerance.

  `guren check`'s model-schema result stays informational (a `warn`, and it does
  not set the exit code). It still infers the table name rather than reading what
  the model binds, so an app whose table does not follow the scaffolder's
  convention can see this warning either way — the name in the message is now the
  one the scaffolder would have written.

- 559cc79: Render route `body` types as the request shape, not the parsed one

  `ApiRoutes[...]['body']` is consumed as the wire type — generated pages hand it
  to `useForm`, and `createApiClient()` callers build request payloads from it —
  but codegen emitted the schema's post-parse type. Those differ for every
  coercing schema, and `z.coerce.date()` made the difference fatal: the body was
  typed `Date` while a browser can only send an ISO string, so a `make:feature`
  scaffold with a date field did not type-check at all.

  `body` now renders the input side, where a coerced date is a `string` and a
  coerced number is `number | string`. `response` still renders the parsed side,
  and `guren context` keeps showing params/query as the controller receives them.
  A `.pipe()` now resolves both sides independently; `.transform()` continues to
  report its input type, since a transform's output is a function with no
  recoverable type.

  Field _presence_ follows the same split, which it previously did not: a
  `.default()`, `.prefault()` or `.catch()` field may be omitted from a request
  but is always there once parsed, so it is optional in `body` and required in
  `response`. `.readonly()`, `.brand()` and `.nonoptional()` are now understood
  too — the first two previously made an optional field look required.

  **Regenerating may surface new type errors in app code**, and they are pointing
  at something real. A form field previously typed `Date` was already sending a
  string over the wire; one typed `number` may receive `"3"` from an input. Widen
  the local type, or narrow the schema if the route genuinely does not coerce.

  Fixed alongside, all of which blocked the same scaffold from compiling:

  - `z.array()` threw on Zod 4 and took `guren codegen` down with it, for any
    route whose body or output schema contained an array.
  - Zod 3's `ZodPipeline` was not recognized at all, so `z.string().pipe(...)`
    rendered as `unknown` on apps still pinned to Zod 3.
  - `RouteBody<>` constrained its registry to a type with an index signature,
    which the generated `ApiRoutes` interface can never satisfy — the type could
    not be used with the one registry it exists for. The constraint is gone, and
    generated form pages now use `RouteBody<ApiRoutes, 'posts.store'>` in place of
    indexing `ApiRoutes` directly.
  - A scaffolded `json` field validated with `z.record(z.unknown())`, which needs
    an explicit key type on Zod 4 and produces a value Inertia's `FormDataType`
    rejects. It is now `z.record(z.string(), z.any())`, edited through a textarea
    that tolerates mid-edit JSON while flagging it, and rendered with
    `JSON.stringify` instead of being passed to React as an object. A json column
    is also no longer used as the Index page's heading, where React refused to
    render it. Scaffolding a json field now emits a `useState` flag on the form
    pages, so a parse failure is visible rather than silently submitting the last
    value that parsed. Apps that customized this validator keep their own version;
    only newly scaffolded features change.
  - A scaffolded `date` field cast its column straight to `string` in the
    resource, and fed a full ISO timestamp to `<input type="date">`, which renders
    nothing for anything longer than `YYYY-MM-DD`. The resource now normalizes
    through `new Date(...)`, so it survives SQLite handing back a string where
    Postgres hands back a `Date`.
  - The scaffolded Edit page named its submit event `event`, shadowing the record
    prop for any entity whose variable name is also `event`.

  Two known limits, both deliberate:

  - Coerced types are rendered narrower than Zod would actually accept.
    `z.coerce.number()` also takes a `boolean` and `z.coerce.boolean()` takes
    anything at all, but a generated `body` is a type callers must _satisfy_, so
    it stays JSON-native and usable — a bare `boolean` is what drives a
    checkbox's `checked`. Widen the schema if a route really means "anything".
  - `RouteBody<>` returns `Record<string, unknown>` for a registry entry with no
    `body`, including a malformed one. Constraining the registry is not an option:
    a generated `interface` can never satisfy an index signature, which is the
    bug being fixed here.

- 460e0e2: refactor: share the Zod v3/v4 compatibility primitives between the two schema walkers

  `@guren/cli`'s TypeScript-type renderer and `@guren/openapi`'s schema-object
  renderer each carried their own copy of the knowledge needed to read a Zod
  schema without caring which major produced it: type-name lookup, the `Zod`
  prefix normalization, wrapper unwrapping, pipe-side selection, object-shape
  reading, and enum/literal value extraction. Knowledge added to one never
  reached the other — a Zod 4 array keeps its element in `_def.element` while
  `_def.type` holds the string `'array'`, and reading them in the wrong order
  silently dropped the element type. That single bug had to be found and fixed
  twice, months apart, once per package.

  Those primitives now live in `@guren/core/internal/zod-compat`, a deep-import
  internal module in the same vein as `internal/deploy-build`. Both walkers read
  from it, so a version quirk learned once is known in both places.

  The set of type names that carry exactly one nested schema moves too, as
  `SINGLE_CHILD_WRAPPERS` plus the two partitions each walker needs. The walkers
  had looked like they disagreed here — one held a five-name set, the other a
  twelve-name one — but the CLI simply handled the other seven as explicit
  `switch` cases. They differ in how they partition the vocabulary, not in what
  is in it, so the membership is now stated once.

  The type switches themselves stay where they are: one produces TypeScript type
  strings, the other OpenAPI schema objects. Their leaf vocabularies have
  legitimately diverged (the CLI renders `void`/`any`/`never`, which OpenAPI
  cannot express), and that is a rendering decision rather than version
  knowledge.

  Both `isOptional`s also stay with their callers, but not because each is right
  for its own purpose — the CLI reads one side of a `.pipe()` and the OpenAPI
  walker requires both, and each can be fooled by a pipeline the other handles.
  Deciding omissibility correctly means simulating a parse, which is a separate
  piece of work; the two approximations are now labelled as such where they live.

  Three incidental hardenings come along for the ride. The CLI's inner-schema
  lookup now skips non-object candidates instead of taking the first non-nullish
  one; a nested node with no readable type name renders as `unknown` rather than
  throwing; and two degenerate schemas that used to emit invalid TypeScript now
  render correctly — an empty `z.enum([])` as `never` instead of an empty string,
  and `z.literal(undefined)` as `undefined` rather than being dropped by
  `JSON.stringify`.

- d9165df: Generate the templates' drizzle pins from `packages/orm`, by the rule `guren upgrade` already owns

  `scripts/sync-template-deps.ts` kept the templates' `@guren/*` ranges pointed at
  the workspace versions, but it filtered on `@guren/`, so `drizzle-orm` and
  `drizzle-kit` in `packages/create-app/templates/*/package.json` were still
  matched to `packages/orm/package.json` by hand. That pairing is exactly what the
  `@guren/*` sync exists to prevent: `@guren/orm` names an _exact_ `drizzle-orm`
  version under `dependencies`, so a template pinning a different one scaffolds an
  app with a second nested copy — the app builds its table descriptors against one
  copy while the adapter runs on the other.

  The rule now lives in one place, `packages/cli/src/drizzle-pins.ts`, and takes a
  manifest plus `@guren/orm`'s own manifest. `guren upgrade` passes the published
  one for the tag it is upgrading to, exactly as before; the sync passes
  `packages/orm/package.json` and applies the result to every template. Nothing
  about the upgrade path changes — the planner returns the rewrites instead of
  performing them, so `--check` can report the same verdict it would write.

  Refusals are part of that verdict, not narration. Everything the rule declines to
  rewrite comes back with a reason, because a caller reading only the changes would
  take "there is drift here I will not touch" for "aligned" — which is how a
  template pinned at `workspace:*` used to leave the CI gate reporting a match.
  `guren upgrade` prints all of them and moves on, since the app manifest is the
  user's to edit; the sync fails on the two a maintainer can fix in this repository
  (a specifier naming a location, and a `packages/orm` that stopped pinning one
  exact version), and tolerates the two about npm rather than this checkout.

  `drizzle-kit` stays the one version a human still picks when the pair diverges:
  it is not a dependency of `@guren/orm`, only of apps and templates, and the two
  packages have never shared numbers on their stable lines. Both callers check the
  companion release exists before writing it, and say what they left alone when it
  does not:

  ```
  packages/create-app/templates/default/package.json: drizzle-kit@1.0.0-rc.4-de6c356
  does not exist on npm — leaving devDependencies.drizzle-kit at "1.0.0-rc.4". Pick
  the drizzle-kit release matching drizzle-orm 1.0.0-rc.4-de6c356 yourself.
  ```

  `audit:template-deps` and `sync:template-deps` share that lookup, so anything the
  CI gate reports as drift the sync can actually fix. An aligned manifest
  short-circuits before any request, which is the steady state CI runs in — the
  gate stays offline until a pin actually moves. When it does move and npm cannot
  answer, that is a refusal too, not a crash: an npm outage says so and leaves the
  companion alone rather than failing a PR that touched nothing related.

- Updated dependencies [fe0c13d]
- Updated dependencies [63fd323]
- Updated dependencies [fe0c13d]
- Updated dependencies [e2c82da]
- Updated dependencies [d7e80fe]
- Updated dependencies [df90e04]
- Updated dependencies [460e0e2]
- Updated dependencies [cda337b]
- Updated dependencies [1bccf80]
  - @guren/core@1.5.0
  - @guren/orm@2.0.0

## 1.6.0

### Minor Changes

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

- 4e8ccc2: Add `@guren/plugin-lambda`: first-class AWS Lambda deployment tooling.

  `guren plugin @guren/plugin-lambda` registers `lambdaPlugin()` and scaffolds
  `src/lambda.ts` (the module whose exports become Lambda handlers). The plugin
  contributes a `lambda:build` command that assembles a `.lambda/` directory:
  a self-contained ESM bundle for the Node.js runtime with
  `process.env.NODE_ENV` pinned to `"production"`, the SSR bundle plus Drizzle
  migrations alongside it, static assets staged for S3, and an
  `env.json` describing the function environment. Dev-only modules
  (`bun:sqlite`, `vite`, the MCP endpoint's generators) are replaced with
  throwing stubs so the bundle neither ships dev tooling nor fails to import on
  Lambda.

  `import.meta.url` is pinned so the framework's
  `new URL('../db/migrations', import.meta.url)` convention keeps resolving
  against the function root. Bundling collapses every module onto the output
  file's own URL (`file:///var/task/handler.js`), which would otherwise point
  that expression one directory too high and silently skip
  `configureOrm()`/`seedDatabase()` at boot.

### Patch Changes

- a7aec95: Add `createAwsDataApiDatabase()` for Aurora Serverless v2 via the RDS Data API.

  The factory mirrors the other database factories (`getDatabase`, `migrateDatabase`,
  `configureOrm`, `seedDatabase`, `resetDatabase`, `migrationStatus`) on top of
  `drizzle-orm/aws-data-api/pg`. The Data API is HTTP-based, so Lambda apps get a
  Postgres-compatible connection without a connection pool, RDS Proxy, or VPC
  placement. Connection settings resolve from options or the `DATABASE_NAME`,
  `DATABASE_RESOURCE_ARN`, and `DATABASE_SECRET_ARN` environment variables;
  `@aws-sdk/client-rds-data` is an optional peer dependency. Unlike the other
  factories, `getDatabase()` does not run pending migrations automatically —
  on Lambda that check costs serialized Data API round trips on every cold
  start. Run migrations out of band, or opt back in with `migrateOnStart: true`.

- 0dabfaa: fix: `guren check` and `doctor --next` no longer claim a controller is untested when it is only named differently

  Controller-test detection matches filenames — `<Name>Controller.test.ts` beside
  the controller or under `tests/`, the layouts `make:test` scaffolds. It reported
  a miss as `No test file found for TaskController.`, an assertion about coverage
  that the check cannot make.

  An app that groups tests by feature hits this on every controller. Worse,
  `doctor --next` promoted each miss to a numbered next step with a `make:test`
  command — on a real app that was 10 of 21 steps, every one of them proposing to
  duplicate coverage that already existed.

  Detection is unchanged; what it says about itself is not. Both reporting sites now
  share one sentence, `describeControllerTestMiss`, which names the miss as a naming
  one, lists the paths probed, and says detection is by filename only. `doctor
--next` retitles the step from `Add tests for X` to `Confirm test coverage for X`,
  and both the check's suggestion and the step's description ask for that
  confirmation first — the structured `title`, `command`, and `suggestion` fields
  are what agents and the MCP surface act on, so cautious prose alone would not have
  changed the outcome.

  Detection was left alone deliberately. The documented way to test a controller is
  to boot the app and drive its routes through `TestApp`, and such a test
  references neither the controller class nor its file — so no amount of parsing
  the test would find the link, and guessing from filename shape (`tasks.test.ts`
  → `TaskController`) would silence real gaps to hide this one. The bound is now
  recorded on `controllerTestCandidates` so callers keep phrasing results as
  "no test named after this controller". Note the same bound in the other
  direction: a `TaskController.test.ts` that never mentions the class still counts,
  because only the filename is ever examined.

  `guren context <Entity>` has its own filename matcher with the same blind spot;
  that one is untouched here.

- d857bd8: A failing `guren` command now reports its error once instead of twice.

  citty's `runMain()` logs a thrown error twice — once with its stack, once as a
  bare message — and then exits the process itself, so the CLI's own error
  handler never ran. The root command is now wired through a local wrapper that
  keeps `--help`, `-h`, `--version`, unknown-command usage, and plugin
  subcommand proxying intact while owning the error path.

  A command name inherited from `Object.prototype` is also rejected properly
  now. `guren valueOf` used to fail with a raw internal `TypeError`, and
  `guren toString` took a different path than any other unknown name.

- c8f89d7: Console commands generated by `make:command` are now runnable.

  `make:command` wrote a class to `app/Console/Commands` that nothing ever
  registered — no template, example, or bootstrap built a `ConsoleKernel`, so the
  generated file was dead code unless the user hand-wired a kernel with no
  documentation describing how.

  Scaffolded apps now ship `src/console.ts`, which exports a `ConsoleKernel` as
  `kernel` (the name the serverless recipes already import), plus a
  `bin/console.ts` runner exposed as the `console` package script. `make:command`
  prints the import and `kernel.registerMany()` line needed to wire its output in.

  Registration stays explicit rather than globbing `app/Console/Commands`, so a
  bundled deployment resolves the same commands as a local checkout.

  The new [console commands guide](https://guren.dev/docs/guides/console) covers
  signatures, output and prompt helpers, testing a kernel with `BufferedOutput`,
  and running commands on a server or on Lambda.

- 473ac6c: fix: `guren doctor` stops printing repair instructions for checks that passed

  Five rules build a single check with a ternary status and hand the same options
  bag to both branches, so a passing check still carried the `fix` and `manualFix`
  text describing how to repair it. The report printed that text regardless of
  status, and because `fix` and `manualFix` restate each other, each passing check
  produced two extra lines — identical ones for the generated-manifest and
  path-alias rules:

  ```
  ✔ [ok] .guren/routes.gen.ts: Generated manifest present at .guren/routes.gen.ts.
  ℹ        Fix: Run guren codegen --force to regenerate .guren/routes.gen.ts.
  ℹ        Manual: Run guren codegen --force to regenerate .guren/routes.gen.ts.
  ```

  On a healthy app that turned a clean report into a wall of instructions for
  problems it does not have.

  The renderer now skips remediation for passing checks, and prints `Manual:` only
  when it says something `Fix:` does not — the duplicate goes, the addition stays.
  A few rules genuinely differ there: the tsconfig parse error needs the file
  repaired _and_ `.guren/**/*` added, and a missing Bun cannot be fixed by
  `bun upgrade`, only by the install URL `manualFix` carries. The `Autofix` line
  now says which command applies it, phrased as information rather than an
  instruction: `guren upgrade` also realigns every `@guren/*` dependency, which is
  more than someone chasing a single check asked for, and `guren doctor` has no
  `--fix` of its own.

  The fix is in `createCheck` rather than the report: a passing check now carries
  no remediation at all, whatever the caller passed. `guren doctor --json` had the
  same defect — on a healthy app it reported `fix: "Run guren codegen --force…"`
  for nine manifests that were present — and enforcing the invariant once covers
  the report, the JSON, and anything added later. The field stays present and
  nullable and `version: 1` is unchanged, so the JSON shape is the same; only
  wrong data disappears from it. `guren upgrade`'s autofix path and manual-step
  collection already filtered by status, so they are unaffected.

  Left as follow-up: `fix` and `manualFix` are not really two concepts. Three
  consumers treat them three ways — the report prints both, `--json` emits both
  raw, and `guren upgrade` reads `manualFix ?? fix`. The genuine case is narrow
  ("the suggested command cannot run"), and naming it that way would be clearer
  than a second general field, but it touches the JSON surface.
  `renderDoctorReport` had no test coverage; it now has cases for each branch.

  Writing those tests surfaced why it had none: two test files replace the
  `consola` module with a hand-listed stub, and `mock.module()` is not undone
  between files in Bun's shared process, so every file loaded after them saw a
  `consola` without `box` — which is the first call `renderDoctorReport` makes.
  Both stubs now inherit from the real instance and shadow only the methods that
  print, so the surface cannot drift out from under an unrelated test again.

- f365707: The Lambda console handler now dispatches the app's own console kernel.

  The scaffolded `src/lambda.ts` built a second `ConsoleKernel` inline and
  registered a single `db:migrate` command on it. An app therefore had two
  kernels with different command sets: register five commands in `src/console.ts`,
  uncomment the Lambda console export, and the deployed function still knew only
  `db:migrate` — with nothing to warn you.

  The scaffold now imports `kernel` from `src/console.ts`, so every command
  reachable through `bun run console` is reachable on Lambda under the same name.
  The `db:migrate` recipe moved to the serverless guide, since needing it at all
  is specific to deploying where no CLI exists.

- 7d18f07: Name the real cause when a database command fails, and give container-backed apps `db:up`/`db:down`

  `db:migrate` against a database that is not reachable used to report `Failed to
run database migrations: Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"` —
  the migrator's own bookkeeping statement, not anything the user wrote. The
  driver's `ECONNREFUSED` lived on the error's `cause`, which was discarded. It now
  reports `cannot connect to the database at localhost:54322 (ECONNREFUSED). Is it
running and accepting connections?`, with the host and port only so the
  connection string's credentials stay out of the log. Genuine SQL failures now
  carry the driver's message alongside the query instead of the query alone.

  Three sibling commands had the same blind spot. `db:status` caught an unreachable
  server in the branch written for "the tracker table does not exist yet", so it
  reported every migration as pending and exited 0 — indistinguishable from a
  healthy database with nothing applied; it now fails with the connection error.
  `db:reset` rethrew the driver error untouched, and a message-less
  `AggregateError` printed as a bare `ERROR` line with nothing after it. `db:seed`
  reported the failing statement without the driver's explanation of why it failed.

  Scaffolding with PostgreSQL or MySQL also writes `db:up` and `db:down` scripts
  next to the generated `docker-compose.yml`, so starting the database is
  discoverable from `package.json`. The selected driver is no longer listed in both
  `dependencies` and `devDependencies`, which made `bun install` warn about a
  duplicate dependency on the first command a new project runs.

  The AI agent harness that `agent:init` installs is updated to match: its database
  skill pointed agents at a `db:logs` script that nothing scaffolds, and handed
  container commands to SQLite projects, which have no container.

- 3d67c4b: fix: a decorated class no longer makes a file invisible to `guren check`, `doctor`, `audit`, and codegen

  The CLI's Babel parsers did not enable any decorator plugin. A single
  `@Injectable`-style class therefore made the _whole file_ unparseable — and
  every caller treats an unparseable file as contributing nothing, silently.
  Concretely, in an app that uses decorators:

  - `check --arch` skipped the file, so a real module- or layer-boundary
    violation in it was never reported. The summary still said `no violations`.
  - `check --docs` fell back to the filename for the model's identity, so a doc
    whose `entities:` names the actual class was reported as pointing at a model
    that does not exist — a failure on a correct doc. (Its `@docs`-tag scan was
    never affected: that path already re-read the file directly.)
  - `doctor --next` emitted no "Implement `X.y()`" steps for the file.
  - `audit`, `context <Entity>`, `model:list`, `spec:generate`, and the `data`,
    `channels`, and page-props codegen all dropped the file the same way.

  Plugin selection now lives in one place, `parseSourceFile()`, shared by every
  call site that parses app-authored source.

  **Plugin choice is a retry, not a guess.** No single Babel plugin set parses
  everything TypeScript accepts, so picking one and baking it in is what made
  this class of bug possible in the first place:

  | source                             | `decorators` | `decorators-legacy` |
  | ---------------------------------- | ------------ | ------------------- |
  | `@Dec export class X {}`           | yes          | yes                 |
  | `export @Dec class X {}`           | yes          | no                  |
  | `constructor(@inject() private x)` | no           | yes                 |

  The same is true of JSX in the other direction: `<Type>value` cast syntax
  parses only _without_ the `jsx` plugin, a JSX element only _with_ it. So the
  file extension now _orders_ the attempts instead of deciding them, and a file
  counts as unparseable only once every dialect has rejected it. Parameter
  decorators (tsyringe, InversifyJS, `experimentalDecorators: true`) and `.js`
  React components both parse now; previously each was silently dropped by
  whichever rule guessed wrong.

  **Skipped files are now reported — for the suites that share the cache.**
  Making more files parse does not fix the underlying hazard, which is that a
  checker skipping a file it could not read is indistinguishable from one that
  found nothing wrong. `guren check` now ends with a `scan-coverage` warning
  naming files that some checker needed and couldn't get: the core suite
  (empty-method scan, Inertia page refs), `--arch`, and `--docs`' `@docs`-tag
  scan. `guren doctor`'s deploy checks already did this; this brings `check` in
  line for those suites.

  Not yet covered: `--spec`'s controller scan and `--docs`' model-identity
  lookup (which falls back to filename, `parseModelFile`) parse independently of
  this cache, so a file failing there produces no `scan-coverage` entry — a
  known gap, not silently claimed as fixed.

  Two related fixes fell out of centralizing it:

  - `channels` codegen parsed **every** extension with the `jsx` plugin,
    including `.ts`, so a channel provider using `<Type>value` contributed no
    channels at all.
  - `ParseCache` could not tell callers _why_ a file produced no AST. It now
    returns `parsed` / `unparsed` / `unreadable` and keeps the source of a file
    the parser rejected, so the regex-only scans in `check` and `docs-check` stop
    re-reading files behind the cache.

  `errorRecovery` remains opt-in per call (audit's model-serialization scan wants
  a partial AST; every other caller uses "did not parse" as the signal to skip a
  file) and is never used by the cache, which is keyed by path alone.

  Legacy decorators are tried before standard ones: the two Babel plugins can't
  both be enabled at once, and parameter decorators — the DI-flavoured shape this
  fix exists to cover — parse only under the legacy dialect, so trying it first
  makes that common case cost one parse attempt instead of two. One combination
  remains genuinely unparseable under either order — a single file mixing
  `export @Dec class X` with a legacy parameter decorator — because no Babel
  plugin set accepts both halves at once; that's now a documented, tested
  limitation rather than a silent gap.

  `scan-coverage` no longer misreports a file as skipped when a caller only
  needed its source text and got it (the `@docs`-tag scan, Inertia page refs):
  only a caller that genuinely needed an AST and didn't get one — or a file that
  couldn't be read at all — counts. Also reused `extractClassDeclaration` in
  `check.ts`'s and `doctor.ts`'s empty-method scans (previously duplicated
  two-branch inline logic that, unlike the shared helper, didn't match a bare,
  non-exported class) and extracted the "first 3, then `and N more`" truncation
  `check.ts` and `deploy-runtime.ts` both needed into a shared helper.

- aa091f7: Add the `GurenLambdaApp` CDK construct under `@guren/plugin-lambda/cdk`.

  One construct provisions the full serverless topology for a Guren app: an
  HTTP API in front of the `http` handler, an SQS queue + worker with a
  dead-letter queue and partial batch failures, an EventBridge rule for the
  scheduler, a console function for CLI commands, CloudFront + S3 serving
  the staged assets (including per-file behaviors for root-level public files),
  and a `dataApi` option that wires the DATABASE\_\* environment and IAM grants
  for Aurora's RDS Data API onto every function. `aws-cdk-lib` and
  `constructs` are optional peer dependencies. The `guren deploy` error message
  now points AWS Lambda users at the plugin.

- 704d407: fix: `guren upgrade` aligns `drizzle-orm` and `drizzle-kit` with what `@guren/orm` depends on

  `@guren/orm` names an exact `drizzle-orm` version under `dependencies`, not a
  range. Upgrading only the `@guren/*` entries therefore left apps pinning a
  different one with two copies installed:

  ```
  node_modules/drizzle-orm                         -> 1.0.0-rc.1   (the app's pin)
  node_modules/@guren/orm/node_modules/drizzle-orm -> 1.0.0-rc.4   (what the ORM brings)
  ```

  The app builds its table descriptors against one copy while the adapter runs on
  the other — the same split-state hazard the duplicate-`@guren/orm` warning
  exists for, and `guren upgrade` was the step that introduced it. `CLAUDE.md`
  already tells contributors to keep these versions aligned; nothing enforced it
  for apps.

  The command now reads the `drizzle-orm` version the target `@guren/orm` depends
  on straight from its registry metadata and writes that, exactly, to both
  `drizzle-orm` and `drizzle-kit`. It only rewrites entries that already exist,
  never adds one, and stands down rather than guessing when:

  - the entry names a location instead of a release (`workspace:`, `file:`,
    `catalog:`, a git URL) — usually a local drizzle build being developed
    against, which a registry release would silently replace;
  - the field is `peerDependencies` or `optionalDependencies` — a peer range is a
    compatibility window a library publishes, not an installed copy to dedupe, and
    narrowing it to one exact version shrinks what that library claims to support;
  - `@guren/orm` depends on a range rather than one exact version — deduping only
    works when there is a single version to converge on;
  - the version was never published for `drizzle-kit`.

  That last one matters because `drizzle-kit` is matched by convention, not from
  metadata: it is not a dependency of `@guren/orm`, so the registry says nothing
  about it, and the two packages have not always shared a release line. Writing a
  `drizzle-kit` version that does not exist would break the next install, so its
  existence is checked first and the entry is left alone with a warning otherwise.

  The lookups read one published version's manifest
  (`registry.npmjs.org/<name>/<version-or-tag>`) rather than the package's full
  document: `@guren/orm/latest` is 2 KB and carries the version _and_ its
  dependencies in a single request, where the abbreviated packument is 28 KB — and
  `drizzle-kit`'s is 1.2 MB, which is what checking one version used to cost. That
  adds one request when the pins already agree and two when they have drifted; a
  package appearing in both `dependencies` and `devDependencies` is still asked
  about once. `--tag canary` returns before any of it, so that mode stays
  offline.

- 5c3ba53: fix: `guren upgrade` defaults to the `latest` dist-tag and refuses to downgrade silently

  The default was `rc`, a tag still pointing at the pre-1.0 release candidates it
  was cut for. Running `guren upgrade` with no arguments on a released app
  rewrote every `@guren/*` pin backwards across the 1.0 boundary — and reported
  it as `✔ Version compatible (1.0.0 -> rc)`, because the compatibility line
  printed the tag name instead of the version it resolves to. The runtime warning
  for duplicate `@guren/orm` copies names this command as its remedy, so the path
  most likely to be taken by someone fixing a version mismatch was the one that
  introduced a bigger one.

  Three changes:

  - The default tag is now `latest`, exported as `DEFAULT_UPGRADE_TAG` so the CLI
    flag description, the programmatic default, and `upgradeCanary()` cannot drift
    apart. `--tag rc` and `--canary` still work.
  - `versionCompatibility.targetVersion` now carries the version the tag resolved
    to, and a new `downgrade` field is set when that version is older than what
    the app already pins. The CLI prints it as a warning under a `Downgrade`
    heading rather than a success line. An explicit `--tag` is still honoured —
    the point is that it is no longer silent. For any tag other than `canary`,
    codemods now receive that resolved version instead of the tag string, which no
    codemod range could ever match; `--canary` keeps pinning the floating tag, so
    it still passes the literal `canary` through.
  - A registry lookup that throws now degrades to "could not resolve" instead of
    taking the command down. The lookup is memoized, and one caller wraps it in
    `.catch` while the other does not, so a cached rejection was handled once and
    rethrown the second time — an unreachable registry aborted the whole upgrade.
    An unresolved tag is also no longer reported as compatible, and codemods are
    skipped for it, since a tag name matches no codemod range.
  - `compareVersions` handles prereleases. `'1.0.0-rc.4'.split('.')` yielded
    `[1, 0, NaN, 4]`, and a NaN difference is neither greater nor less than zero,
    so every comparison against a `1.0.0-rc.N` version answered "unordered" —
    which reads as "equal" to callers testing for `< 0`. Guren shipped its whole
    1.0 line in that shape, so this covered exactly the versions the upgrade path
    compares. It now delegates to `Bun.semver.order`, the comparator this package
    already uses for plugin compatibility ranges, behind a guard that returns NaN
    for anything that is not one exact version — including a partial pin like
    `1.3`, which `Bun.semver` ranks _above_ `1.3.0`. `guren doctor` had a private
    copy of the old implementation for its Bun version floor, so a Bun prerelease
    such as `1.1.1-canary.3` was reported as below the minimum; it now shares the
    fixed one.

  `guren upgrade --check-only` needs the network now, since resolving the tag is
  what the check reports. Version lookups read the registry's `dist-tags`
  endpoint instead of the full packument (61 B rather than ~33 KB per package,
  which grew with every release), and every package resolves concurrently, so an
  unreachable registry costs one connect timeout rather than one per package.

  The downgrade check anchors on the first comparable `@guren/*` pin. Tags can
  resolve per-package, so this is a safety net over the common case of one release
  line across every entry rather than a guarantee for each individual rewrite.

- Updated dependencies [a7aec95]
- Updated dependencies [7d18f07]
- Updated dependencies [f448a0a]
- Updated dependencies [4b8ed69]
  - @guren/orm@1.3.0
  - @guren/core@1.4.0

## 1.5.0

### Minor Changes

- 5196935: Added application modules — a `modules/<name>/` directory convention for composing self-contained slices of an app instead of piling everything into one flat `app/`, `routes/`, and `db/schema.ts`. `defineModule()` (new in `@guren/server`, re-exported from `@guren/core`) declares a module's routes and providers; `Application` folds them into its provider list and route mounting at boot via the new `mountModuleRoutes()`.

  On the CLI side: `guren make:module <name>` scaffolds and auto-wires a module (`index.ts`, `routes.ts`, `db/schema.ts`, plus `src/app.ts`/`db/schema.ts` patching). Most `make:*` generators accept `--module <name>` to scaffold inside a module instead of the project root. `guren check`, `guren audit`, `guren context`, `model:list`, and `doctor` are all module-aware automatically, and once any `modules/` directory exists, `guren check` derives zero-config boundary rules that flag cross-module imports reaching past a module's public surface (`index.ts` or `db/schema.ts`) — no `guren.arch.ts` authoring required. `guren codegen`, `guren audit`, `openapi:generate`, and `guren route:list` all see routes registered inside a module's own `routes.ts`, not just the top-level `routes/web.ts`.

- 5196935: `guren check` now enforces architecture boundaries. Drop a `guren.arch.ts` file at the project root to define layers and disallowed cross-layer imports (or disallowed packages), and violations are reported alongside the existing route/controller/page checks. Two new flags support this for AI coding agents and large apps: `guren check --arch` runs only the architecture checks (a fast path for an edit hook), and `guren check --changed` restricts any check to files changed versus the merge base with `main`.
- c395b27: feat: doc–code linking (RFC 0004 Part 2)

  - `docs/` frontmatter convention: markdown under `docs/` (and
    `modules/*/docs/`) can declare `kind`, `status`, `entities`,
    `related` (paths or globs), and `last_reviewed`.
  - `guren context <Entity>` gains a **Linked docs** section, resolved
    from frontmatter `entities:` and code-side `@docs <path>` JSDoc tags
    on models and controllers.
  - `guren check --docs` validates the links deterministically: dangling
    `related` paths/globs and unknown `entities` fail; entities whose
    only docs are superseded warn; `--docs-ttl <days>` warns on stale
    `last_reviewed`. Content-activated — apps without the convention see
    zero results — and participates in `check --changed`. Doc-link
    results also appear in plain `guren check`, so agent-harness edit
    hooks surface dangling links when the files they govern change —
    intentional: that is exactly when the link should be fixed.
    `--arch --docs` together runs the union of both suites.
  - `make:adr "Title"` scaffolds numbered ADRs under `docs/adr/` with
    prefilled, linkable frontmatter (`--module` targets a module's docs).
    `--entity <Model>` prefills `entities:` with the canonical class name
    and `related:` with the entity's controller/resource/policy files; an
    entity that doesn't exist yet is prefilled as given, so ADR-first
    flows get a failing `check --docs` as the "implementation missing"
    signal.

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

- 3d6b5d5: feat: teach scaffolds and the agent harness the docs/spec conventions

  - New apps ship with `docs/adr/0001-record-architecture-decisions.md`,
    a seed ADR explaining the frontmatter convention, `make:adr`, and the
    link checking `guren check` performs.
  - The agent harness gains `.claude/rules/docs-and-spec.md` (glob-scoped
    to docs, schema, models, controllers, routes, and pages): start
    entity work with `guren context <Entity>`, keep doc frontmatter
    current when moving files, regenerate `docs/spec/` views after
    structural changes. Existing apps receive the rule via
    `bunx guren agent:sync`. The harness `CLAUDE.md` (start-here block
    and MCP tool table, now covering `guren context <Entity>`,
    `spec:generate`, `make:adr`, and `guren_entity_context`) applies to
    new `agent:init` installs — `CLAUDE.md` is user-owned and never
    overwritten by sync.

- c9095a1: `guren make:auth --verify` now scaffolds an email verification flow (`VerifyEmailController`, a `VerifyEmail` page, an `emailVerifiedAt` users column, and an in-memory `EmailVerificationStore`). Registration sends a verification email and redirects to `/verify-email` instead of `/dashboard`, and the generated `/dashboard` route is guarded with `requireVerifiedEmail`. Also fixes `updateSchema()` corrupting a `users` table defined with Drizzle's three-argument form (e.g. `pgTable('users', {...}, (table) => [...])`) by inserting the new column next to the `rememberToken` field instead of attempting a whole-block replace.
- 8d1f495: `guren make:auth --oauth-only` scaffolds OAuth as an app's only sign-in method, completing RFC 0003 §4's passwordless requirement. `/login` becomes a provider-buttons page with no credential form and no `POST /login` route, and `LoginController` keeps only `show()` and `destroy()` (logout). Registration, password reset, `LoginValidator`, the login and profile password fields, and the demo `UsersSeeder` are all skipped — a seeded password could never be used to sign in, and hashing one is the per-request CPU cost the flag exists to avoid on metered runtimes like the Cloudflare Workers free tier.

  `--oauth-only` requires `--oauth` with at least one supported provider (honouring it without providers would scaffold an app with no way in, and ignoring it would scaffold the password login the flag opts out of), subsumes `--minimal`, and skips `--verify` with a warning since provider-supplied emails arrive already vouched for. Scaffolding the password variants is unchanged, byte for byte.

  Two consequences of removing the password surface are handled explicitly. The profile email is scaffolded read-only and dropped from `ProfileUpdateSchema`: with no verification flow in this mode, an editable email would let an account claim an address it never proved, and `OAuthController`'s collision check would then reject that address's real owner on their first sign-in. And because `make:auth` only ever writes the files it scaffolds, converting an existing password app with `--oauth-only --force` now reports the password files left on disk — notably `db/seeders/UsersSeeder.ts`, which `db:seed` finds without going through the route table.

- ac6e4ce: `guren make:auth --oauth <providers>` now scaffolds OAuth login buttons for a comma-separated list of providers (`github`, `google`, `discord`). It adds a `<provider>Id` column per provider to the `users` table, an `OAuthProvider` that registers each provider against the shared `OAuthManager` (only once its client ID, secret, and redirect URI are all set), and an `OAuthController` with `redirectToProvider`/`callback` actions — sharing file paths and DI wiring conventions with `guren add oauth`, but with a complete callback that links or creates the account and logs the user in instead of a stub. Unlike `--verify`, `--oauth` works with `--minimal`. Also generalizes `updateSchema()`'s column-injection logic so `--verify` and `--oauth` can add their columns together without duplicating the `users` table.
- 8beb966: `guren make:auth` now scaffolds a password reset flow (`ForgotPasswordController`, `ResetPasswordController`, a `config/mail.ts` defaulting to the `log` driver, and an in-memory `PasswordResetStore`) by default, alongside a fix for `addImport` corrupting multi-line leading import statements when wiring providers into `src/app.ts`. Pass `--minimal` to skip registration and password reset scaffolding.
- 6cfdb5c: `guren make:auth` now scaffolds a registration flow (`RegisterController`, `RegisterSchema` with password confirmation, and a `Register` page) by default, wired into `routes/auth.ts` and linked from the login page. Pass `--minimal` to reproduce the previous login-only scaffold.
- 0131222: `make:auth --oauth` now scaffolds truly passwordless OAuth accounts (RFC 0003 Part 3): OAuth-created users are stored without a password instead of hashing a synthetic random one — the model's hashing pipeline already skips absent passwords, and password login safely rejects accounts without a hash (timing-equalized). On CPU-metered runtimes (Cloudflare Workers free tier), this also removes the one scrypt hash per OAuth signup that would have blown the request budget.

  The scaffolded `users` table now leaves `passwordHash` nullable when `--oauth` is enabled, and adding `--oauth` to an existing password-auth app relaxes the existing `notNull` in `db/schema.ts` (run `db:make` to generate the migration; the relaxation is scoped to the `users` table and handles every dialect, including mysql's comma-carrying `varchar` options). Note the trade-off: because `--oauth` still scaffolds password login alongside, the relaxation is table-wide — password-registered rows lose the database-level NOT NULL guard (the scaffold prints this). Pass `--oauth-only` to drop password login entirely instead. The email-collision message is provider-agnostic now ("Sign in with the method you originally used").

- 52dbaaf: BREAKING (`@guren/plugin-vercel`): the provider export changed from the `GurenPluginVercelProvider` class to a `vercelPlugin(config?)` factory built on `definePlugin()`, aligning with `@guren/plugin-cloudflare` and the plugin contract's recommended shape. The config object is empty today and reserved so future fields never force another registration-shape change. Update registrations from `providers: [GurenPluginVercelProvider]` to `providers: [vercelPlugin()]`; `createVercelHandler` and `buildVercelOutput` are unchanged. The `gurenPlugin.provider` manifest field is dropped accordingly.

  `@guren/cli`: `guren plugin` now knows the official factory-shaped plugins (`@guren/plugin-vercel`, `@guren/plugin-cloudflare`) and auto-registers them as `providers: [vercelPlugin()]`-style call expressions in `src/app.ts` — previously factory plugins could only print a "register manually" hint.

- 6905725: feat: derived spec views with a drift gate (RFC 0004 Part 3)

  - `guren spec:generate` renders four deterministic markdown views into
    `docs/spec/`: `er.md` (Mermaid ER diagram from the Drizzle schema,
    edges from model relationships and explicit `.references()` FKs),
    `domain.md` (Mermaid class diagram of models grouped by module),
    `screens.md` (route → controller action → page → Props inventory),
    and `modules.md` (module context map with cross-module dependency
    edges). Output is byte-stable — stable sorts, no timestamps — so PR
    diffs show exactly what a code change did to the spec.
  - `guren check --spec` is the tbls-style drift gate: it regenerates the
    views in memory and fails (non-zero exit) when the committed files
    differ or are missing. Content-activated on `docs/spec/`; under
    `check --changed` it only regenerates when a spec-relevant file
    (schema, models, controllers, routes, pages, resources) changed.
  - The Drizzle schema parser is promoted to a shared `schema-parser.ts`
    (column types, nullability, primary keys, `.references()` targets);
    the audit's sensitive-column check and the entity context consume it.

### Patch Changes

- f7186c7: Fix a stray `@guren/server/redis` reference in `make:auth`'s password-reset/email-verification store comments — it should point at `@guren/core/redis`, the public subpath. Also fully adopt `make:auth`'s auth stack (registration, password reset, email verification, GitHub/Google OAuth) into `examples/blog`, replacing the login-only reference implementation.
- 6ec0cfe: fix: skip rewriting generated artifacts whose content is unchanged

  `guren codegen` wrote `.guren/pages.gen.ts`, `.guren/routes.gen.ts`,
  `.guren/data.gen.ts`, `.guren/channels.gen.ts`, `.guren/api-client.gen.ts`,
  and `types/generated/routes.d.ts` unconditionally, so every run bumped
  their mtimes even when the output was byte-identical. Since the Vite plugin
  regenerates on each save under `resources/js/pages/`,
  `app/Http/Resources/`, and `routes/web.ts`, a frontend-only edit churned
  files that backend code imports. The generators now compare the existing
  file first and skip the write when nothing changed; content that differs
  still goes through the usual `--force` guard.

  As a consequence, `guren routes:types` without `--force` no longer errors
  with "already exists. Use --force to overwrite." when the existing file is
  already byte-identical to what it would generate — identical content is not
  a clobber. Output that differs is still refused without `--force`.

- 7a128ed: Reload backend changes without restarting the dev server

  `dev:server` now runs `bun --hot bin/serve.ts` in both templates, so edits to
  controllers, routes, and models take effect on the next request instead of
  requiring a manual restart. In the default frontend template, adding a route
  re-runs codegen and reloads once more, then settles.

  Keep `@guren/cli` current before adding the flag to an existing project. The
  reload only settles because codegen leaves `.guren/*.gen.ts` untouched when the
  output is unchanged; older versions rewrote them on every run, and since your
  controllers import those files, each rewrite triggers the next reload.

  State held in the process does not survive a reload: the memory-backed session
  and cache stores are rebuilt empty, and module-level variables are
  reinitialized. External stores — Redis, the database — are unaffected.

  `guren doctor` now counts `dev:server` among the scripts an app is expected to
  have, so its autofix no longer adds a `dev` script that calls a missing one.

- 0b8ec64: Fixed `make:auth --oauth <providers>` scaffolding a profile form that let an account replace the email its identity provider had vouched for. Without `--verify` nothing in the generated app can re-prove a new address, so the account could end up asserting an email it had never owned — and the generated `OAuthController` would then turn that assertion into a rejection for the address's real owner on their first sign-in.

  `--oauth` without `--verify` now scaffolds the profile email read-only: the field is dropped from `ProfileUpdateSchema` and `ProfileController.update()` no longer reads one, so a hand-crafted request cannot carry an address either. `--oauth --verify`, and every scaffold without `--oauth`, keep the editable email field unchanged.

  This does not make an email address exclusive to whoever owns the mailbox. Registration still accepts any well-formed email and `users.email` is unique, so an account holding an address still blocks that address's first OAuth sign-in — the fix only stops a provider-vouched account from silently moving off the address it proved.

- f7186c7: Harden `make:auth` templates with fixes discovered while adopting the full auth stack in a real app:

  - Validators lowercase the email field, so mixed-case input round-trips correctly through login, password-reset, and email-verification lookups (the token helpers normalize to lowercase internally).
  - `/verify-email/confirm` is scaffolded as a public route — it validates the signed token itself, and gating it behind auth stranded users who opened the emailed link from another device or after their session expired.
  - `ProfileController.update()` clears `emailVerifiedAt` and re-sends the verification email when the address changes (with `--verify`), instead of letting an unproven replacement address inherit verified status.
  - `ForgotPasswordController` no longer awaits the reset-email send inline; the transport round-trip only happened for known accounts, so response timing could reveal which emails are registered.
  - `OAuthController` lowercases the provider email before matching and creating accounts.

- f7186c7: Fix `make:auth --verify --oauth <providers>`: newly created OAuth accounts are now marked email-verified at creation. Previously they were left unverified, and since `OAuthController` never sends a verification email, `requireVerifiedEmail` would strand every OAuth signup at `/verify-email` with no way to get past it. The OAuth provider already vouches for the address, so there's nothing to re-verify.
- 10a9bd1: Add `emailVerified` to `OAuthUserProfile`. Providers report whether they actually verified an address separately from the address itself — Google sends OIDC's `email_verified`, Discord sends `verified` — and until now that signal was only reachable through the untyped `profile.raw` bag. The field is tri-state on purpose: `true` (the provider asserts verified), `false` (it asserts not verified), `undefined` (no signal, so the app decides its own policy).

  Provider configs declare where to read it via `emailVerifiedKey`, so the shared mapper knows only OIDC's standard `email_verified` claim; the Google and Discord presets each declare their own key, and only boolean values are read. GitHub's `/user` carries no such field, so `emailVerified` stays `undefined` there — except when the private-email fallback runs, which reports `true` because `/user/emails` only yields verified primary addresses. `mapProfile` still owns the whole mapping when set.

  `fetchFallbackEmail` may now also return `{ email, emailVerified }` instead of a bare string, since the signal read from the userinfo response cannot vouch for an address that response did not contain. This is additive: implementations written against the original signature keep compiling, and a bare string deliberately claims nothing, leaving `emailVerified` undefined rather than asserting `true` on their behalf.

  `make:auth --oauth`'s scaffolded `OAuthController` now checks `profile.emailVerified === false` instead of matching provider-specific keys on `profile.raw`. Same behavior, no provider names in generated application code.

- 8d1f495: Fix `make:auth --oauth`: the scaffolded `OAuthController` no longer creates an account from an email address the provider has not verified. Google reports `email_verified` and Discord reports `verified` alongside the address, and returning an email is not a claim that it was checked — so an unverified one could previously create an authenticated account holding an address it did not own, and the callback's email-collision check would then permanently turn the real owner away on their first sign-in. The check runs only on the account-creation path, so an already-linked account is not locked out if its provider status changes later.

  This changes the generated `OAuthController.ts` for every `--oauth` variant; the rest of the scaffold is untouched. GitHub was already safe here — its fallback email lookup requires a verified primary address.

- Updated dependencies [88b45c4]
- Updated dependencies [360d1f4]
- Updated dependencies [a2c7b8c]
- Updated dependencies [d5d0c5b]
- Updated dependencies [1a6b738]
  - @guren/core@1.3.0
  - @guren/orm@1.2.0

## 1.4.0

### Minor Changes

- 60e2859: Add a `guren doctor` check that detects missing test infrastructure. When a project's `package.json` has no `@guren/testing` in `dependencies`/`devDependencies` and no `*.test.ts`-style files exist under `tests/`, doctor now emits a warning recommending `bun add -d @guren/testing`, and the same signal appears as an actionable step in `guren doctor --next`. This closes a gap where apps scaffolded with older `create-guren-app` versions (or hand-rolled projects) had zero test infrastructure and no doctor signal about it.

### Patch Changes

- 20e7aa4: Make `guren codegen` overwrite existing `.guren/*.gen.ts` artifacts by default. Previously, plain `bunx guren codegen` failed with "already exists. Use --force to overwrite." on any run after the first, even though create-app template scripts always pass `--force` and the generated CLAUDE.md documents plain `bunx guren codegen` as the way to regenerate manifests. `--force` is still accepted for backward compatibility but is now a no-op for this command.
- 0c01602: Accept dot-notation nested relation paths (`with('comments.author')`) in the type signatures of `with()`, `findWith()`, `findWithOrFail()`, and `withPaginate()` — the runtime already supported them. Add `BelongsToRequiredRecord<T>` for belongsTo relations backed by a NOT NULL foreign key, so `relationTypes` can declare the parent as non-nullable (use the `declare` modifier to skip the runtime placeholder).
- df571cf: Document a local-testing gotcha in the `plugin-authoring` agent skill (`agent:init`/`agent:sync`) and the plugin authoring guide: linking a plugin into a test app via `bun add file:`/`link:`/`workspace:` symlinks back to the plugin's source directory, so a plugin that still has its own `@guren/core` devDependency installed can end up loaded as two separate module copies alongside the app's — surfacing as duplicate-module runtime warnings or a `Property 'bindings' is protected...` TypeScript error. The fix (delete `node_modules` in the plugin package directory before linking) is now documented; published plugins never ship `node_modules`, so this only affects local testing before publishing.
- a10aa54: Document SQLite test-database isolation and DB cleanup helpers in the AI agent harness template (`.claude/rules/testing.md`, shipped by `agent:init`/`agent:sync`): the scaffolded `NODE_ENV=test` branch in `config/database.ts` (default `./data/guren.test.db`, `TEST_DATABASE_URL` override, and the retrofit fix for older scaffolds that still write to the dev DB), plus guidance on `resetDatabase()`/`migrateDatabase()` vs. `useTruncateTables()`/`useDatabaseTransactions()` for cleaning up data between tests — including the explicit `DatabaseConnection` requirement and connection-identity caveat for the latter two, since Guren's SQLite adapter doesn't ship a ready-made adapter for them.
- Updated dependencies [0c01602]
  - @guren/orm@1.1.0
  - @guren/core@1.2.0

## 1.3.0

### Minor Changes

- 8054533: Fix `make:resource --model` generating code that doesn't type-check: it referenced the model's class name (`Resource<Comment>`) instead of its inferred record type, and unconditionally called `.toISOString()` on `createdAt`/`updatedAt` even when the Drizzle schema stores them as `text()` (ISO strings), which throws at runtime. The generated resource now imports and extends `Resource<XRecord>` and leaves timestamp mapping to the developer instead of guessing the column type.

  Fix `make:test` defaulting to a `vitest` import even in projects with no vitest installed (scaffolded apps ship `bun test`, not vitest) — the runner is now auto-detected from `vitest.config.*` / a `vitest` dependency in `package.json`, falling back to `bun:test`; `--runner` still overrides detection when passed explicitly.

  Add the `--controller` flag to `make:test`, which `guren check`'s remediation message already referenced but which didn't exist — it now suffixes the class name with `Controller` and writes to `tests/controllers/${ClassName}.test.ts`, matching `guren check`'s first lookup candidate.

### Patch Changes

- 2f60c3b: Fix and expand the AI agent harness template (`.claude/rules/*.md`, `.claude/skills/guren-api/SKILL.md`, `CLAUDE.md`) shipped by `agent:init`/`agent:sync`:

  - Document the `HttpException`/`ValidationException`/`AuthenticationException`/`AuthorizationException`/`NotFoundHttpException` factory methods in a new "Exceptions" section — previously only findable by grepping `node_modules/@guren/server/dist/*.d.ts`.
  - Note that `this.auth.userOrFail()`'s `<T>` defaults to `Authenticatable`, which has no `.id`, and fix the `userOrFail()` examples across the templates to use `userOrFail<UserRecord>()` so copy-pasted code type-checks.
  - Note that array-typed relations (`hasMany`, etc.) need a `[]` placeholder in `relationTypes`, not `null`.
  - Note that Guren has no global shared Inertia props by default (`shareInertiaProps()` exists but a fresh scaffold never calls it), so `usePage()` for undeclared props silently resolves to `undefined`.
  - Document `TestApp.create()`'s `auth` option and CSRF testing pattern, and add a "Testing (@guren/testing)" section to the `guren-api` skill (previously absent from the subsystem list entirely).
  - Change the `guren-api` skill's frontmatter `description` from a purely reactive framing ("use when user asks...") to also prompt proactive use during implementation, before falling back to grepping dist files.

## 1.2.1

### Patch Changes

- 368df85: Fix `guren plugin` publishes and plugin CLI command discovery for locally installed plugins. Bun materializes `file:`, `link:`, and `workspace:` dependencies as per-file symlinks into the source directory, so the path-escape guard — which canonicalized paths against the node_modules entry only — misclassified every file in such packages as escaping the package directory: `publishes` aborted the install with an error and declared commands were silently dropped from `guren --help`. The guard now also accepts the package's content root (the realpath parent of its `package.json`), which is the node_modules entry itself for regular installs and the source directory for per-file-symlink installs. Malicious symlinks pointing outside both roots are still rejected.

## 1.2.0

### Minor Changes

- d7be76a: `guren audit` now warns when a model's schema table has sensitive-looking columns (password, secret, token, salt, hash) that are not excluded from serialization via `static hidden` or a `static visible` allowlist. Records passed to `serialize()`/`toJSON()` or Inertia props would otherwise expose those values. Models whose sensitive columns are all covered get a pass finding; models without sensitive columns produce no output.
- 6e0efe2: Guard OAuth `redirectTo` against open redirects. State creation and verification both sanitize the value: app-relative paths always pass, absolute URLs only when their host is in the new `stateConfig.allowedRedirectHosts` allowlist (wildcards supported); protocol-relative URLs, backslash variants, and non-http schemes are dropped. New `OAuthManager.handleCallback()` returns the profile together with the sanitized `redirectTo`, and `sanitizeOAuthRedirect()` is exported for custom flows. The `guren add oauth` scaffold now demonstrates the safe round-trip (`?redirectTo=` → `handleCallback`).
- 2f7aae5: Add a `plugin-authoring` skill to the AI agent harness (`bunx guren agent:init` / `agent:sync`). Covers both installing an existing Guren plugin (`bunx guren plugin <pkg>`, including the manifest-driven provider/env/publishes flow and the no-`provider` manual-registration case) and authoring a new plugin package (`definePlugin()`, the `gurenPlugin` manifest fields, contributing CLI commands, and testing with `@guren/testing`).
- 2f7aae5: Plugins can now contribute CLI commands via the `gurenPlugin.commands` manifest field (RFC 0001, Part C): `{ "entry": "./dist/commands.js", "names": ["myplugin:sync"] }`. Discovery reads only package.json files — the entry module (a default-exported record of citty command definitions) is imported lazily when one of the declared commands is invoked, never for `--help` listing. Command names must be `:`-namespaced, built-in command names always win, and a name declared by two plugins is dropped for both with a warning naming the packages.
- 494ac11: Turn `guren plugin <pkg>` into a full plugin installer driven by the declarative `gurenPlugin` package.json manifest (RFC 0001, Part B). The command now installs the dependency with `bun add` when missing (`--no-install` to skip), verifies the plugin's declared Guren `compatibility` range against the installed `@guren/core` (`--ignore-compatibility` to override), registers the manifest-declared `provider` export (falling back to the name heuristic), copies declared `publishes` files into `config/`, `db/migrations/`, or `resources/` (path-traversal guarded, never overwriting without `--force`), and appends declared `env` keys to `.env.example`/`.env`. The manifest is pure data — no plugin code is executed during installation. The command is now also registered at the top level (`bunx guren plugin ...` previously only worked as `guren add plugin ...` despite being documented). `bunx guren doctor` gains a Plugin Compatibility check that flags installed plugins whose `compatibility` range excludes the installed core version. `@guren/plugin-vercel` now declares its `gurenPlugin` manifest.

### Patch Changes

- Updated dependencies [2bbc832]
  - @guren/core@1.1.0

## 1.1.0

### Minor Changes

- a3d1191: Add `agent:init` / `agent:sync` commands and install the AI agent harness by default when scaffolding a new app.

  `agent:init` installs the harness (CLAUDE.md, `.claude/` rules, skills, agents, hooks, `.mcp.json`) into any Guren app; `create-guren-app` now runs it automatically after dependency install for every blueprint. The harness wires a verification loop via `.claude/settings.json`: the `guren context` project map is injected at session start, and `guren check` re-runs after edits to routes, controllers, models, schema, or pages, feeding failures back to the agent. `agent:sync` refreshes framework-managed files without touching user-owned `CLAUDE.md`, `.mcp.json`, or `.claude/settings.json`.

- bc79a6a: Resolve the `@/` alias from the project root instead of `app/`. The Vite plugin alias, scaffolded imports (`make:*`, `add resource`), and docs now use root-relative paths like `@/.guren/pages.gen` and `@/app/Http/Resources/PostResource`, removing deep `../../..` relative imports. `guren doctor` gains a `tsconfig-alias` check with autofix. Apps created before this release should update `tsconfig.json` paths to `"@/*": ["./*"]` so newly scaffolded code resolves.

### Patch Changes

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

- 83ca2c2: Fix critical scaffold-to-runtime breakages found by dogfooding the published packages:

  - **@guren/server**: stop bundling `@guren/orm` (now a real dependency). The bundled copy created a second `Model`/`DrizzleAdapter` instance, so `configureOrm()` never reached `AuthenticatableModel` and every auth query failed with "database has not been configured" in published apps.
  - **@guren/cli `add auth`**: schema updates and the users migration now respect the app's database dialect (sqlite/postgres/mysql) instead of always emitting Postgres SQL; the migration is generated via drizzle-kit instead of a loose `.sql` file that `db:migrate` never executed; `createApp()` is patched with `auth: {}` so sessions and CSRF actually mount.
  - **@guren/cli `add resource`**: honors `--fields` (previously silently ignored) and adds `--public`; delegates file generation to the `make:feature` templates; registers the route group with typed body contracts — the previous insertion regex never matched the starter template, so routes were silently never registered.
  - **@guren/cli `codegen`**: generates route/data/channel/API-client artifacts by default (previously skipped silently unless `--routes` was passed, leaving `routes.gen.ts` empty).
  - **@guren/orm**: warn when the migrations folder contains loose `.sql` files that the drizzle migrator will not execute; export `jsonb` from `@guren/orm/drizzle`.
  - **@guren/inertia-client**: add missing `./typed-forms` and `./components` export map entries (imports failed to resolve in published apps).
  - **create-guren-app**: `--auth` now runs after dependency installation using the app-local CLI and reports failures honestly (previously it always failed silently when run via bunx, yet printed a success message).
  - Docs: quick start now pins `create-guren-app@rc` (npm `latest` still points at the old 0.2.0 alpha) and reflects the SQLite default.

- 57f6f35: Fixes and features from building a real app (Kadai) on the published packages:

  - **@guren/server: entry bundles now share chunks** (tsup `splitting: true`). Each entry point previously bundled its own copy of module-level state, so `registerJob()` via the root entry and `Worker` via `./queue` used different job registries — jobs failed with "Job class not found". The same duplication affected the mail manager and queue driver globals.
  - **@guren/server: new `SyncDriver` (queue) and `LogTransport` (mail)** — the template `.env` defaults (`QUEUE_CONNECTION=sync`, `MAIL_MAILER=log`) previously named drivers that did not exist. Sync dispatch executes jobs inline with no worker process; the log transport writes full messages to server output. The `add queue` / `add mail` blueprints now honor these env vars and default to sync/log.
  - **@guren/orm: multi-relation type fix** — `findWith(id, ['a', 'b'])` and `with(['a', 'b'])` typed their results as a union of single-relation picks instead of an intersection, making relation properties inaccessible.
  - **@guren/orm: `QueryBuilder.paginate()` accepts an options object** (`{ page, perPage }`) in addition to positional arguments, matching `Model.paginate()`.

- a1fc6ec: Two security defaults locked in ahead of 1.0:

  - **Strict mass assignment.** When a model defines `fillable`, `create()`/`update()` now throw a `MassAssignmentException` naming any field outside the allowlist instead of silently discarding it (silent drops surfaced as NOT NULL violations far from the cause, and masked injection attempts). Use the new `forceCreate()` / `forceUpdate()` for trusted server-side data, or set `static strictFillable = false` per model to restore the old behavior. The `guarded` path is unchanged.
  - **`auth.user()` never exposes credentials.** The session guard sanitizes user records before caching or returning them: the password column, remember-token column, and the model's `static hidden` fields are stripped. Credential checks still run on the raw record internally, so login and remember-me behave exactly as before — but sharing `auth.user` into Inertia props no longer leaks `passwordHash` to the browser. Custom user providers can opt in via the new optional `UserProvider.sanitize()`. `guren add auth` now generates the User model with `static hidden = ['passwordHash', 'rememberToken']`.

- 8ee89bb: Quality hardening: database-matrix runtime gates, upgrade-path protection, and add-on runtime smokes:

  - **PostgreSQL golden-path gate**: the scaffold→auth→CRUD runtime smoke now also runs against PostgreSQL in CI and the release workflow (dedicated `guren_smoke` database locally so developer data is never touched), verifying dialect-aware scaffolds, `resetDatabase()`, and `migrationStatus()` on pg for every release.
  - **`guren upgrade` works for the rc channel**: previously only `--canary` was supported, leaving rc users with no tool-assisted upgrade. `guren upgrade` now aligns every `@guren/*` package to a resolved dist-tag version (default `rc`, override with `--tag`), and warns when nested duplicate `@guren` copies survive in node_modules with the exact dedupe command.
  - **Duplicate-copy runtime guard**: loading two copies of `@guren/orm` (mixed versions) now prints a loud diagnostic explaining why database access fails and how to fix it, instead of failing silently with "database has not been configured".
  - **`Mail#build()` runs automatically**: scaffolded mailables previously threw "Email must have a subject" because `send()`/`queue()` never invoked `build()` — every user following the `add mail` scaffold hit this. Found by the new add-on runtime smoke, which now dispatches the scaffolded queue job and sends the scaffolded mailable on every release.

- bba40d6: Runtime release gate, unified drizzle-kit migrations, and richer relations:

  - **Golden-path runtime smoke**: the release workflow now boots a scaffolded app and drives login, CRUD, CSRF, and auth rejection over HTTP before publishing — the class of published-artifact-only breakage fixed in rc.20 can no longer ship.
  - **Migrations unified on drizzle-kit**: `createSqliteDatabase`/`createPostgresDatabase`/`createMySqlDatabase` now expose `resetDatabase()` and `migrationStatus()`, making `guren db:reset`, `db:fresh`, and `db:status` work out of the box (all three previously failed on scaffolded apps). `db:rollback` now explains that drizzle-kit migrations are forward-only and points to `db:reset` or a compensating forward migration; the dead flat-SQL rollback tracker was removed.
  - **Relations**: nested eager loading with dot notation (`User.with('posts.comments')` — previously documented but not implemented) and `withCount()` (`users[0].postsCount`) for hasMany/hasOne/belongsTo/morphMany. Relation declarations no longer need `typeof` guards or `as any` casts; the testing mocks now include relation registrars so model modules load cleanly under Vitest.
  - Templates export `resetDatabase`/`migrationStatus` from config/database.ts and ship `db:reset`/`db:status` scripts; relationship docs updated (EN/JA) with the clean declaration pattern and `withCount`.

- e0136bd: Real-app dogfooding round 3:

  - **`guren schedule:run` actually runs tasks now.** The command previously printed "Would run: ..." and executed nothing (a leftover stub), so cron-driven `guren schedule:run` silently did no work. Due tasks (or all tasks with `--force`) now execute through `ScheduledTask.run()` with per-task success/failure reporting and a non-zero exit code on failure. Task names and cron expressions are also read correctly (previously every task displayed as "unnamed (\* \* \* \* \*)").
  - **`guren audit` recognizes generic call signatures** — `this.auth.userOrFail<{ id: number }>()` and `validateBody<T>(...)` no longer produce false "no authentication check" warnings.

- a835522: Secure-by-default hardening and AI-agent tooling:

  - `guren audit` command: validates auth/validation coverage on mutating routes, detects raw SQL, secrets, and mass assignment risks
  - `make:feature` now scaffolds auth checks by default (`--public` to opt out) and supports `--policy`
  - Authorization gate wiring, hardened auth/storage/mail/error rendering
  - Inertia asset version mismatch handling
  - drizzle-orm / drizzle-kit upgraded to 1.0.0-rc.1
  - Migration tracker SQL escaping fix and dependency vulnerability patches

- ac73182: Added SSR support, ORM relationships, pagination, and authentication enhancements.

### Patch Changes

- c2f318d: Align all packages to rc.10.
- e74eab5: fix(ci): upgrade to Node 24 for npm OIDC trusted publishing
- 9333048: feat(create-app): add database selection, auto-install, and template version fixes
- dcee3ee: fix(server): use figlet importable-fonts for bundled builds
- b3c9414: feat(cli): add @guren/plugin-vercel and remove legacy deploy vercel target
  fix(create-app,orm,cli): fix blog blueprint SQLite support and DX issues
  fix(create-app): comment out VITE_DEV_SERVER_URL in template .env
- 73d311c: Align all packages to rc.9.
- 5fbd7e7: Pinned dependencies to specific versions for consistency across packages
- 38bd637: Ensure dev asset server resolves and serves Inertia client chunks so the scaffold works in dev.
- d3a0d2c: DX fixes from the i18n dogfooding lap:

  - **Middleware `c.header()` now reaches controller responses.** Handlers and controllers return raw `Response` objects, which bypassed Hono's response construction — headers staged via `c.header()` in upstream middleware (e.g. a locale cookie) were silently dropped. Route responses are now rebuilt through `c.newResponse()`, merging prepared headers (`Set-Cookie` appended, the handler's own headers winning otherwise).
  - **`TestApp.withHeaders()` / `withHeader()`**: send custom request headers on every request (Accept-Language, bearer tokens, …). Like `actingAs()` and `json()`, they return a new `TestApp` and compose freely.
  - **`shareInertiaProps()`** merges shared props over previously registered resolvers, so multiple providers can each contribute (auth, i18n, flash, …) without clobbering one another. `getInertiaSharedPropsResolver()` is now exported for manual composition.
  - **Docs**: global middleware must be attached in a provider's `register()` — routes mount before `boot()`, so `app.use()` from `boot()` never applies. Documented in the architecture guide (en/ja).

- 379d57e: First-class file uploads:

  - **`this.file(name)` / `this.files(name)` controller helpers** — read uploaded files from multipart requests (null/empty-safe, composes with other body reads via Hono's cached parseBody). Previously controllers had to call `this.request.parseBody()` and duck-type the result.
  - **`TestApp` accepts `FormData` bodies** — `csrf.post('/tasks/1/attachments', formData)` sends real multipart requests, so upload endpoints are finally testable.

- f9e7441: fix(cli,create-app): fix `add resource` generating pgTable in SQLite projects
- da8707f: The release build runs build:create-app so the CLI binary is bundled.
- afe4bfd: Two fixes surfaced by dogfooding i18n in a real app:

  - **CSRF cookie refresh no longer wipes other cookies.** `setXsrfCookie` replaced the `Set-Cookie` header on the finalized response, silently dropping any cookie appended by inner middleware or handlers (e.g. a `locale` cookie). It now appends.
  - **`I18nConfig` accepts a `loader` option** as the i18n guide documents. Previously only `path` existed, so `MemoryLoader` (or any custom `TranslationLoader`) could not be injected into `createI18n` / `new I18nManager()`. `loader` takes precedence over `path`.

- 7fbf1de: Accept Hono middleware as a terminal route handler:

  - **`RouteHandler` now includes `(c, next)` signatures**, so any Hono `MiddlewareHandler` — including `broadcast.sseMiddleware()` and `broadcast.authMiddleware()` — can be passed directly to `router.get()` / `router.post()` as the docs show, without wrapper closures or `as Promise<Response>` casts.
  - **Responses set via `c.res` are honored**: a middleware mounted as a handler that finalizes the response through `next()` or `c.res =` no longer gets clobbered by a synthesized `204 No Content`. Plain handlers returning `undefined` still produce `204`.

- 08ac277: Updated the scaffolded app template so new projects pull in the freshly published prerelease.
- c10691c: Three bug fixes ahead of 1.0:

  - **Nested eager loading now works at any depth** (#15). `User.with('posts.comments.author')` previously loaded two levels and silently left deeper relations unloaded when going through the query builder. `QueryBuilder` now delegates the full dotted path to `Model.loadRelationInto`, which recurses correctly.
  - **Auth context is available to middleware registered before `boot()`** (#13). The fallback auth context (apps without `options.auth`) is attached in the `Application` constructor, and the context resolves its session lazily — so `app.use(requireAuthenticated())` before `boot()` responds 401 instead of throwing, regardless of session middleware ordering.
  - **Route contracts accept array-style query strings** (#12). `?tag=a&tag=b` now reaches query schemas as `{ tag: ['a', 'b'] }` (single occurrences stay plain strings), matching the controller-side `validateQuery` behavior. Schemas that expect a plain string for a key clients may repeat should switch to `z.array(...)` or accept both.
  - **`guren add oauth` now generates code that compiles.** The scaffolded controller named its action `redirect`, shadowing the base `Controller.redirect()` helper (infinite recursion) and failing to typecheck; the route-param validator also rejected `string | undefined`. The action is now `redirectToProvider` and the validator handles missing params.

- f7de890: Final API freeze pass before 1.0, driven by an adversarial pre-release review:

  - **`QueryBuilder.update()` now enforces the fillable allowlist** exactly like `Model.update()` (it previously bypassed mass-assignment protection entirely); `QueryBuilder.forceUpdate()` is the trusted-data escape hatch.
  - **Redis stores are now importable**: `@guren/core/redis` (and `@guren/server/redis`) ship `RedisSessionStore`, `RedisRateLimitStore`, `RedisSlidingWindowRateLimitStore`, `RedisApiTokenStore`, `RedisPasswordResetStore`, `RedisEmailVerificationStore`, and the new `RedisOAuthStateStore`. The default `MemoryOAuthStateStore` is now bounded (10k entries with expiry sweep) to prevent memory-exhaustion DoS.
  - **`PaginationMeta` name collision resolved**: the ORM's pagination meta is now `ModelPaginationMeta`; `PaginationMeta` from `@guren/core` unambiguously refers to the resource/paginator shape.
  - **React is a peer dependency**: `@guren/inertia-client` moves `react`/`react-dom` to peerDependencies, and `@guren/server` makes `@guren/inertia-client` an optional peer — API-only apps no longer pull React transitively.
  - **`@guren/testing/vitest` subpath**: vitest/React helpers move out of the root barrel so `bun:test` users don't need the React test stack; the related peer deps are marked optional.
  - **`Hash` is runtime-safe**: it now points at `DefaultHasher`, which delegates to Bun's scrypt on Bun and the Node implementation elsewhere (Lambda on Node no longer crashes).
  - Smaller freeze items: `ApplicationOptions`/`AuthPluginOptions` exported, unimplemented `Command.callSilent()` removed, `FormRequest` marked `@deprecated`, `MemoryQueueDriver`/`SyncQueueDriver`/`RedisQueueDriver` aliases added, internal ORM plumbing removed from the `@guren/core` allowlist, `nodemailer` bumped to v9 (HIGH advisory), stray `./dist/*` export wildcard removed.
  - **Docs**: broadcasting client flow rewritten around the `connected` handshake and `clientId` subscription (the previous example authorized but never subscribed), array-style query params documented, rc → 1.0.0 migration notes added, MySQL support matrix corrected, rate-limiting/serverless guides point at the shipped Redis stores.

- 4011200: Second round of real-app (Kadai) fixes:

  - **@guren/cli codegen: inherited page props are no longer dropped.** `interface Props extends PaginatedPageProps<T> { ... }` now extracts as an intersection of the heritage clauses and the body. Previously only the body was captured — an empty-bodied extends silently degraded the page contract to `{}` (no type checking at all), and adding any own member made the inherited members vanish from the contract, rejecting valid controller props.
  - **@guren/testing: `TestApp.withCsrf()`** primes CSRF like a real browser — GETs a page, captures the session and XSRF-TOKEN cookies, and sends them (plus `X-XSRF-TOKEN`) on subsequent requests, so mutating endpoints are finally testable against apps with CSRF enabled.
  - **@guren/orm: `GUREN_QUIET_DUPLICATE_ORM=1`** silences the duplicate-copy warning for environments where two copies coexist by design (e.g. monorepo dev with src + dist).

- d8c572a: Fix the project created with the `create-guren-app` command so it can start successfully.
- 3add058: Fixed registerDevAssets to resolve the bundled Inertia client via @guren/inertia-client/app, rebuilt @guren/server, and confirmed the scaffolded app now loads without blank-screen 404s.
- 7f52ba4: Add open-source metadata, licensing, and community docs to prepare the packages for an initial public release.
- 42c6053: Make SSE broadcasting actually reachable from clients:

  - **The SSE stream announces the connection** with a `connected` event carrying the `clientId` and any already-subscribed channels. Previously clients had no way to learn their id, and no HTTP path ever subscribed a client to a channel — SSE connections received pings but never a single broadcast event.
  - **`?channels=a,b` query subscriptions** on the SSE endpoint: requested channels are authorized against the connecting user (`sseMiddleware({ getUser })`) and subscribed before the stream starts, so a bare `EventSource` works for public channels.
  - **`POST /broadcasting/auth` subscribes as well as authorizes** when the payload includes the `clientId`, returning `{ authorized, subscribed }` per channel.
  - **Unregistered `private-`/`presence-` channels now default to deny** instead of public access — a missing channel registration no longer silently exposes a private channel.

- 11e876c: first release
- Updated dependencies [c2f318d]
- Updated dependencies [e74eab5]
- Updated dependencies [dcee3ee]
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
  - @guren/core@1.0.0
  - @guren/orm@1.0.0

## 1.0.0-rc.29

### Patch Changes

- f7de890: Final API freeze pass before 1.0, driven by an adversarial pre-release review:

  - **`QueryBuilder.update()` now enforces the fillable allowlist** exactly like `Model.update()` (it previously bypassed mass-assignment protection entirely); `QueryBuilder.forceUpdate()` is the trusted-data escape hatch.
  - **Redis stores are now importable**: `@guren/core/redis` (and `@guren/server/redis`) ship `RedisSessionStore`, `RedisRateLimitStore`, `RedisSlidingWindowRateLimitStore`, `RedisApiTokenStore`, `RedisPasswordResetStore`, `RedisEmailVerificationStore`, and the new `RedisOAuthStateStore`. The default `MemoryOAuthStateStore` is now bounded (10k entries with expiry sweep) to prevent memory-exhaustion DoS.
  - **`PaginationMeta` name collision resolved**: the ORM's pagination meta is now `ModelPaginationMeta`; `PaginationMeta` from `@guren/core` unambiguously refers to the resource/paginator shape.
  - **React is a peer dependency**: `@guren/inertia-client` moves `react`/`react-dom` to peerDependencies, and `@guren/server` makes `@guren/inertia-client` an optional peer — API-only apps no longer pull React transitively.
  - **`@guren/testing/vitest` subpath**: vitest/React helpers move out of the root barrel so `bun:test` users don't need the React test stack; the related peer deps are marked optional.
  - **`Hash` is runtime-safe**: it now points at `DefaultHasher`, which delegates to Bun's scrypt on Bun and the Node implementation elsewhere (Lambda on Node no longer crashes).
  - Smaller freeze items: `ApplicationOptions`/`AuthPluginOptions` exported, unimplemented `Command.callSilent()` removed, `FormRequest` marked `@deprecated`, `MemoryQueueDriver`/`SyncQueueDriver`/`RedisQueueDriver` aliases added, internal ORM plumbing removed from the `@guren/core` allowlist, `nodemailer` bumped to v9 (HIGH advisory), stray `./dist/*` export wildcard removed.
  - **Docs**: broadcasting client flow rewritten around the `connected` handshake and `clientId` subscription (the previous example authorized but never subscribed), array-style query params documented, rc → 1.0.0 migration notes added, MySQL support matrix corrected, rate-limiting/serverless guides point at the shipped Redis stores.

- Updated dependencies [f7de890]
  - @guren/orm@1.0.0-rc.27
  - @guren/core@1.0.0-rc.26

## 1.0.0-rc.28

### Minor Changes

- a1fc6ec: Two security defaults locked in ahead of 1.0:

  - **Strict mass assignment.** When a model defines `fillable`, `create()`/`update()` now throw a `MassAssignmentException` naming any field outside the allowlist instead of silently discarding it (silent drops surfaced as NOT NULL violations far from the cause, and masked injection attempts). Use the new `forceCreate()` / `forceUpdate()` for trusted server-side data, or set `static strictFillable = false` per model to restore the old behavior. The `guarded` path is unchanged.
  - **`auth.user()` never exposes credentials.** The session guard sanitizes user records before caching or returning them: the password column, remember-token column, and the model's `static hidden` fields are stripped. Credential checks still run on the raw record internally, so login and remember-me behave exactly as before — but sharing `auth.user` into Inertia props no longer leaks `passwordHash` to the browser. Custom user providers can opt in via the new optional `UserProvider.sanitize()`. `guren add auth` now generates the User model with `static hidden = ['passwordHash', 'rememberToken']`.

### Patch Changes

- Updated dependencies [a1fc6ec]
  - @guren/orm@1.0.0-rc.26
  - @guren/core@1.0.0-rc.25

## 1.0.0-rc.27

### Patch Changes

- c10691c: Three bug fixes ahead of 1.0:

  - **Nested eager loading now works at any depth** (#15). `User.with('posts.comments.author')` previously loaded two levels and silently left deeper relations unloaded when going through the query builder. `QueryBuilder` now delegates the full dotted path to `Model.loadRelationInto`, which recurses correctly.
  - **Auth context is available to middleware registered before `boot()`** (#13). The fallback auth context (apps without `options.auth`) is attached in the `Application` constructor, and the context resolves its session lazily — so `app.use(requireAuthenticated())` before `boot()` responds 401 instead of throwing, regardless of session middleware ordering.
  - **Route contracts accept array-style query strings** (#12). `?tag=a&tag=b` now reaches query schemas as `{ tag: ['a', 'b'] }` (single occurrences stay plain strings), matching the controller-side `validateQuery` behavior. Schemas that expect a plain string for a key clients may repeat should switch to `z.array(...)` or accept both.
  - **`guren add oauth` now generates code that compiles.** The scaffolded controller named its action `redirect`, shadowing the base `Controller.redirect()` helper (infinite recursion) and failing to typecheck; the route-param validator also rejected `string | undefined`. The action is now `redirectToProvider` and the validator handles missing params.

- Updated dependencies [c10691c]
  - @guren/orm@1.0.0-rc.25
  - @guren/core@1.0.0-rc.24

## 1.0.0-rc.26

### Patch Changes

- d3a0d2c: DX fixes from the i18n dogfooding lap:

  - **Middleware `c.header()` now reaches controller responses.** Handlers and controllers return raw `Response` objects, which bypassed Hono's response construction — headers staged via `c.header()` in upstream middleware (e.g. a locale cookie) were silently dropped. Route responses are now rebuilt through `c.newResponse()`, merging prepared headers (`Set-Cookie` appended, the handler's own headers winning otherwise).
  - **`TestApp.withHeaders()` / `withHeader()`**: send custom request headers on every request (Accept-Language, bearer tokens, …). Like `actingAs()` and `json()`, they return a new `TestApp` and compose freely.
  - **`shareInertiaProps()`** merges shared props over previously registered resolvers, so multiple providers can each contribute (auth, i18n, flash, …) without clobbering one another. `getInertiaSharedPropsResolver()` is now exported for manual composition.
  - **Docs**: global middleware must be attached in a provider's `register()` — routes mount before `boot()`, so `app.use()` from `boot()` never applies. Documented in the architecture guide (en/ja).

- Updated dependencies [d3a0d2c]
  - @guren/core@1.0.0-rc.23
  - @guren/orm@1.0.0-rc.24

## 1.0.0-rc.25

### Patch Changes

- afe4bfd: Two fixes surfaced by dogfooding i18n in a real app:

  - **CSRF cookie refresh no longer wipes other cookies.** `setXsrfCookie` replaced the `Set-Cookie` header on the finalized response, silently dropping any cookie appended by inner middleware or handlers (e.g. a `locale` cookie). It now appends.
  - **`I18nConfig` accepts a `loader` option** as the i18n guide documents. Previously only `path` existed, so `MemoryLoader` (or any custom `TranslationLoader`) could not be injected into `createI18n` / `new I18nManager()`. `loader` takes precedence over `path`.

- 7fbf1de: Accept Hono middleware as a terminal route handler:

  - **`RouteHandler` now includes `(c, next)` signatures**, so any Hono `MiddlewareHandler` — including `broadcast.sseMiddleware()` and `broadcast.authMiddleware()` — can be passed directly to `router.get()` / `router.post()` as the docs show, without wrapper closures or `as Promise<Response>` casts.
  - **Responses set via `c.res` are honored**: a middleware mounted as a handler that finalizes the response through `next()` or `c.res =` no longer gets clobbered by a synthesized `204 No Content`. Plain handlers returning `undefined` still produce `204`.

- Updated dependencies [afe4bfd]
- Updated dependencies [7fbf1de]
  - @guren/core@1.0.0-rc.22
  - @guren/orm@1.0.0-rc.23

## 1.0.0-rc.24

### Patch Changes

- 42c6053: Make SSE broadcasting actually reachable from clients:

  - **The SSE stream announces the connection** with a `connected` event carrying the `clientId` and any already-subscribed channels. Previously clients had no way to learn their id, and no HTTP path ever subscribed a client to a channel — SSE connections received pings but never a single broadcast event.
  - **`?channels=a,b` query subscriptions** on the SSE endpoint: requested channels are authorized against the connecting user (`sseMiddleware({ getUser })`) and subscribed before the stream starts, so a bare `EventSource` works for public channels.
  - **`POST /broadcasting/auth` subscribes as well as authorizes** when the payload includes the `clientId`, returning `{ authorized, subscribed }` per channel.
  - **Unregistered `private-`/`presence-` channels now default to deny** instead of public access — a missing channel registration no longer silently exposes a private channel.

- Updated dependencies [42c6053]
  - @guren/core@1.0.0-rc.21
  - @guren/orm@1.0.0-rc.22

## 1.0.0-rc.23

### Patch Changes

- 379d57e: First-class file uploads:

  - **`this.file(name)` / `this.files(name)` controller helpers** — read uploaded files from multipart requests (null/empty-safe, composes with other body reads via Hono's cached parseBody). Previously controllers had to call `this.request.parseBody()` and duck-type the result.
  - **`TestApp` accepts `FormData` bodies** — `csrf.post('/tasks/1/attachments', formData)` sends real multipart requests, so upload endpoints are finally testable.

- Updated dependencies [379d57e]
  - @guren/core@1.0.0-rc.20
  - @guren/orm@1.0.0-rc.21

## 1.0.0-rc.22

### Minor Changes

- e0136bd: Real-app dogfooding round 3:

  - **`guren schedule:run` actually runs tasks now.** The command previously printed "Would run: ..." and executed nothing (a leftover stub), so cron-driven `guren schedule:run` silently did no work. Due tasks (or all tasks with `--force`) now execute through `ScheduledTask.run()` with per-task success/failure reporting and a non-zero exit code on failure. Task names and cron expressions are also read correctly (previously every task displayed as "unnamed (\* \* \* \* \*)").
  - **`guren audit` recognizes generic call signatures** — `this.auth.userOrFail<{ id: number }>()` and `validateBody<T>(...)` no longer produce false "no authentication check" warnings.

## 1.0.0-rc.21

### Patch Changes

- 4011200: Second round of real-app (Kadai) fixes:

  - **@guren/cli codegen: inherited page props are no longer dropped.** `interface Props extends PaginatedPageProps<T> { ... }` now extracts as an intersection of the heritage clauses and the body. Previously only the body was captured — an empty-bodied extends silently degraded the page contract to `{}` (no type checking at all), and adding any own member made the inherited members vanish from the contract, rejecting valid controller props.
  - **@guren/testing: `TestApp.withCsrf()`** primes CSRF like a real browser — GETs a page, captures the session and XSRF-TOKEN cookies, and sends them (plus `X-XSRF-TOKEN`) on subsequent requests, so mutating endpoints are finally testable against apps with CSRF enabled.
  - **@guren/orm: `GUREN_QUIET_DUPLICATE_ORM=1`** silences the duplicate-copy warning for environments where two copies coexist by design (e.g. monorepo dev with src + dist).

- Updated dependencies [4011200]
  - @guren/orm@1.0.0-rc.20
  - @guren/core@1.0.0-rc.19

## 1.0.0-rc.20

### Minor Changes

- 57f6f35: Fixes and features from building a real app (Kadai) on the published packages:

  - **@guren/server: entry bundles now share chunks** (tsup `splitting: true`). Each entry point previously bundled its own copy of module-level state, so `registerJob()` via the root entry and `Worker` via `./queue` used different job registries — jobs failed with "Job class not found". The same duplication affected the mail manager and queue driver globals.
  - **@guren/server: new `SyncDriver` (queue) and `LogTransport` (mail)** — the template `.env` defaults (`QUEUE_CONNECTION=sync`, `MAIL_MAILER=log`) previously named drivers that did not exist. Sync dispatch executes jobs inline with no worker process; the log transport writes full messages to server output. The `add queue` / `add mail` blueprints now honor these env vars and default to sync/log.
  - **@guren/orm: multi-relation type fix** — `findWith(id, ['a', 'b'])` and `with(['a', 'b'])` typed their results as a union of single-relation picks instead of an intersection, making relation properties inaccessible.
  - **@guren/orm: `QueryBuilder.paginate()` accepts an options object** (`{ page, perPage }`) in addition to positional arguments, matching `Model.paginate()`.

### Patch Changes

- Updated dependencies [57f6f35]
  - @guren/orm@1.0.0-rc.19
  - @guren/core@1.0.0-rc.18

## 1.0.0-rc.19

### Minor Changes

- 8ee89bb: Quality hardening: database-matrix runtime gates, upgrade-path protection, and add-on runtime smokes:

  - **PostgreSQL golden-path gate**: the scaffold→auth→CRUD runtime smoke now also runs against PostgreSQL in CI and the release workflow (dedicated `guren_smoke` database locally so developer data is never touched), verifying dialect-aware scaffolds, `resetDatabase()`, and `migrationStatus()` on pg for every release.
  - **`guren upgrade` works for the rc channel**: previously only `--canary` was supported, leaving rc users with no tool-assisted upgrade. `guren upgrade` now aligns every `@guren/*` package to a resolved dist-tag version (default `rc`, override with `--tag`), and warns when nested duplicate `@guren` copies survive in node_modules with the exact dedupe command.
  - **Duplicate-copy runtime guard**: loading two copies of `@guren/orm` (mixed versions) now prints a loud diagnostic explaining why database access fails and how to fix it, instead of failing silently with "database has not been configured".
  - **`Mail#build()` runs automatically**: scaffolded mailables previously threw "Email must have a subject" because `send()`/`queue()` never invoked `build()` — every user following the `add mail` scaffold hit this. Found by the new add-on runtime smoke, which now dispatches the scaffolded queue job and sends the scaffolded mailable on every release.

### Patch Changes

- Updated dependencies [8ee89bb]
  - @guren/orm@1.0.0-rc.17
  - @guren/core@1.0.0-rc.17

## 1.0.0-rc.18

### Minor Changes

- bba40d6: Runtime release gate, unified drizzle-kit migrations, and richer relations:

  - **Golden-path runtime smoke**: the release workflow now boots a scaffolded app and drives login, CRUD, CSRF, and auth rejection over HTTP before publishing — the class of published-artifact-only breakage fixed in rc.20 can no longer ship.
  - **Migrations unified on drizzle-kit**: `createSqliteDatabase`/`createPostgresDatabase`/`createMySqlDatabase` now expose `resetDatabase()` and `migrationStatus()`, making `guren db:reset`, `db:fresh`, and `db:status` work out of the box (all three previously failed on scaffolded apps). `db:rollback` now explains that drizzle-kit migrations are forward-only and points to `db:reset` or a compensating forward migration; the dead flat-SQL rollback tracker was removed.
  - **Relations**: nested eager loading with dot notation (`User.with('posts.comments')` — previously documented but not implemented) and `withCount()` (`users[0].postsCount`) for hasMany/hasOne/belongsTo/morphMany. Relation declarations no longer need `typeof` guards or `as any` casts; the testing mocks now include relation registrars so model modules load cleanly under Vitest.
  - Templates export `resetDatabase`/`migrationStatus` from config/database.ts and ship `db:reset`/`db:status` scripts; relationship docs updated (EN/JA) with the clean declaration pattern and `withCount`.

### Patch Changes

- Updated dependencies [bba40d6]
  - @guren/orm@1.0.0-rc.15
  - @guren/core@1.0.0-rc.16

## 1.0.0-rc.17

### Minor Changes

- 83ca2c2: Fix critical scaffold-to-runtime breakages found by dogfooding the published packages:

  - **@guren/server**: stop bundling `@guren/orm` (now a real dependency). The bundled copy created a second `Model`/`DrizzleAdapter` instance, so `configureOrm()` never reached `AuthenticatableModel` and every auth query failed with "database has not been configured" in published apps.
  - **@guren/cli `add auth`**: schema updates and the users migration now respect the app's database dialect (sqlite/postgres/mysql) instead of always emitting Postgres SQL; the migration is generated via drizzle-kit instead of a loose `.sql` file that `db:migrate` never executed; `createApp()` is patched with `auth: {}` so sessions and CSRF actually mount.
  - **@guren/cli `add resource`**: honors `--fields` (previously silently ignored) and adds `--public`; delegates file generation to the `make:feature` templates; registers the route group with typed body contracts — the previous insertion regex never matched the starter template, so routes were silently never registered.
  - **@guren/cli `codegen`**: generates route/data/channel/API-client artifacts by default (previously skipped silently unless `--routes` was passed, leaving `routes.gen.ts` empty).
  - **@guren/orm**: warn when the migrations folder contains loose `.sql` files that the drizzle migrator will not execute; export `jsonb` from `@guren/orm/drizzle`.
  - **@guren/inertia-client**: add missing `./typed-forms` and `./components` export map entries (imports failed to resolve in published apps).
  - **create-guren-app**: `--auth` now runs after dependency installation using the app-local CLI and reports failures honestly (previously it always failed silently when run via bunx, yet printed a success message).
  - Docs: quick start now pins `create-guren-app@rc` (npm `latest` still points at the old 0.2.0 alpha) and reflects the SQLite default.

### Patch Changes

- Updated dependencies [83ca2c2]
  - @guren/orm@1.0.0-rc.14
  - @guren/core@1.0.0-rc.15

## 1.0.0-rc.16

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
  - @guren/core@1.0.0-rc.14
  - @guren/orm@1.0.0-rc.13

## 1.0.0-rc.15

### Patch Changes

- fix(cli,create-app): fix `add resource` generating pgTable in SQLite projects

## 1.0.0-rc.14

### Patch Changes

- feat(cli): add @guren/plugin-vercel and remove legacy deploy vercel target
  fix(create-app,orm,cli): fix blog blueprint SQLite support and DX issues
  fix(create-app): comment out VITE_DEV_SERVER_URL in template .env
- Updated dependencies
  - @guren/orm@1.0.0-rc.12
  - @guren/core@1.0.0-rc.13

## 1.0.0-rc.13

### Patch Changes

- fix(server): use figlet importable-fonts for bundled builds
- Updated dependencies
  - @guren/core@1.0.0-rc.12

## 1.0.0-rc.12

### Patch Changes

- feat(create-app): add database selection, auto-install, and template version fixes

## 1.0.0-rc.11

### Patch Changes

- fix(ci): upgrade to Node 24 for npm OIDC trusted publishing
- Updated dependencies
  - @guren/orm@1.0.0-rc.11
  - @guren/core@1.0.0-rc.11

## 1.0.0-rc.10

### Patch Changes

- Align all packages to rc.10.
- Updated dependencies
  - @guren/core@1.0.0-rc.10

## 1.0.0-rc.9

### Patch Changes

- Align all packages to rc.9.
- Updated dependencies
  - @guren/orm@1.0.0-rc.9
  - @guren/core@1.0.0-rc.9

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
  - @guren/orm@1.0.0-rc.8
  - @guren/core@1.0.0-rc.8

## 0.2.0-alpha.7

### Patch Changes

- Fix the project created with the `create-guren-app` command so it can start successfully.
- Updated dependencies
  - @guren/orm@0.2.0-alpha.7
  - @guren/server@0.2.0-alpha.7

## 0.2.0-alpha.6

### Minor Changes

- Added SSR support, ORM relationships, pagination, and authentication enhancements.

### Patch Changes

- Updated dependencies
  - @guren/orm@0.2.0-alpha.6
  - @guren/server@0.2.0-alpha.6

## 0.1.1-alpha.5

### Patch Changes

- Ensure dev asset server resolves and serves Inertia client chunks so the scaffold works in dev.
- Updated dependencies
  - @guren/orm@0.1.1-alpha.5
  - @guren/server@0.1.1-alpha.5

## 0.1.1-alpha.4

### Patch Changes

- Fixed registerDevAssets to resolve the bundled Inertia client via @guren/inertia-client/app, rebuilt @guren/server, and confirmed the scaffolded app now loads without blank-screen 404s.
- Updated dependencies
  - @guren/orm@0.1.1-alpha.4
  - @guren/server@0.1.1-alpha.4

## 0.1.1-alpha.3

### Patch Changes

- The release build runs build:create-app so the CLI binary is bundled.
- Updated dependencies
  - @guren/orm@0.1.1-alpha.3
  - @guren/server@0.1.1-alpha.3

## 0.1.1-alpha.2

### Patch Changes

- Updated the scaffolded app template so new projects pull in the freshly published prerelease.
- Updated dependencies
  - @guren/orm@0.1.1-alpha.2
  - @guren/server@0.1.1-alpha.2

## 0.1.1-alpha.1

### Patch Changes

- Pinned dependencies to specific versions for consistency across packages
- Updated dependencies
  - @guren/orm@0.1.1-alpha.1
  - @guren/server@0.1.1-alpha.1

## 0.1.1-alpha.0

### Patch Changes

- 7f52ba4: Add open-source metadata, licensing, and community docs to prepare the packages for an initial public release.
- first release
- Updated dependencies [7f52ba4]
- Updated dependencies
  - @guren/server@0.1.1-alpha.0
  - @guren/orm@0.1.1-alpha.0
