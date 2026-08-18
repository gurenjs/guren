# RFC: Agent Catalog Distribution

**Author:** Urata Daiki
**Date:** 2026-08-17
**Status:** Accepted (2026-08-18 — maintainer decision; the standard two-week discussion
window was waived by the project maintainer. Reviewed through two Codex passes with
every finding verified against source before acceptance; the ten decisions listed at
the end are settled as recommended. Implementation ships as three PRs: the
`agent:sync --prune` ownership fix, the generator + audit gate + templates, and the
publish script + docs.)

## Problem

RFC 0008 made the agent harness work for five agents. It did nothing for
discovery. `guren agent:init` ships inside `@guren/cli`, which is a
dependency of a Guren app and is not installable on its own (the `guren`
package does not exist on npm). The command itself guards nothing — point it
at any directory and it writes — but nobody has it until they have already
chosen Guren and scaffolded. So the harness reaches exactly the developers who
needed no convincing. It is a retention feature that we have been treating as
a growth feature.

Three channels now sit in front of developers who have *not* chosen a stack:

- The Claude Code plugin marketplace — `claude plugin marketplace add <owner>/<repo>`,
  plus the browsable community catalog `anthropics/claude-plugins-community`
  that ships registered in every Claude Code install.
- The Agent Skills CLI (`npx skills add <owner>/<repo>`, `vercel-labs/skills`),
  which installs into Cursor, Codex, Copilot, OpenCode, Gemini CLI and ~70
  other agents from one GitHub repository.
- **Agent Plugins v1** (<https://agent-plugins.org>), a vendor-neutral
  packaging standard for exactly this artifact — Agent Skills plus MCP
  servers — with a Technical Steering Committee from Amazon, Cursor,
  Microsoft, OpenAI and Vercel, and implementations in OpenAI's tooling,
  Cursor, GitHub Copilot, VS Code, Kiro and others. VS Code discovers plugins
  from git-repository marketplaces (`chat.plugins.marketplaces`, defaulting to
  `copilot-plugins` and `awesome-copilot`) and from the Copilot CLI's
  `~/.copilot/installed-plugins/`.

One GitHub repository can serve all three, which is how other frameworks
already appear there:

```bash
claude plugin marketplace add <owner>/<repo>
claude plugin install <plugin>@<marketplace> --scope project
npx skills add <owner>/<repo>
```

Guren has no presence in any of them. That is the gap this RFC closes.

### The finding that shapes the whole design

No channel can carry the harness.

**Claude Code plugins have no rules component.** A plugin's component
directories are `skills/`, `commands/`, `agents/`, `hooks/`, `.mcp.json`,
`.lsp.json`, `monitors/`, `bin/`, `settings.json`. There is no `rules/`, and a
`CLAUDE.md` at the plugin root is explicitly not loaded as project context —
"plugins contribute context through skills, agents, and hooks."

**The skills CLI carries less still.** `skills add` discovers `SKILL.md`
directories (in `skills/`, agent skill directories, or declared through
`.claude-plugin/marketplace.json` / `plugin.json`) and writes them into the
target agent's skills directory. It writes no `AGENTS.md`, no rules, no MCP
config, no hooks.

So the glob-scoped rules, the `SessionStart` context injection, the
`PostToolUse` `guren check` hook, the entry documents and the MCP client
configs — the entire push half of the harness, and the part RFC 0008 argued
is what makes agents succeed — cannot travel through a catalog. Only skills
can.

**And skills alone cannot carry Guren's differentiator either**, because that
differentiator is CLI: `guren context`, `guren check`, `guren check --arch`,
`guren check --spec`, `guren audit`. Those binaries live in the app's
`@guren/cli` dependency. Confirmed: the `guren` package does not exist on npm
(`npm view guren` → 404); `bunx guren` resolves only through an app's local
`@guren/cli`. Outside an app there is nothing to run.

The conclusion is not that this is not worth doing. It is that the artifact
is **an on-ramp, not a harness copy**: its job is to be found in a catalog,
explain Guren to an agent that has never seen it, scaffold an app, and then
hand off to `guren agent:init`, which remains the single source of truth for
everything the harness actually does. Every design decision below follows
from that.

## Proposed Solution

### 1. Packaging shape: a separate public repo, generated from this one

Publish `gurenjs/agent-skills`, laid out the way all three channels expect —
a marketplace manifest at the root and each plugin in its own directory under
`plugins/`:

```
agent-skills/                    # published repo (generated; no hand edits)
├── .claude-plugin/
│   └── marketplace.json
├── plugins/
│   └── guren/
│       ├── plugin.json                  # Agent Plugins v1 (portable)
│       ├── .claude-plugin/plugin.json   # Claude Code's manifest location
│       ├── skills/
│       │   ├── guren-new-app/SKILL.md
│       │   └── guren-harness/SKILL.md
│       ├── README.md
│       └── LICENSE
├── README.md
└── LICENSE
```

Install lines:

```bash
claude plugin marketplace add gurenjs/agent-skills
claude plugin install guren@gurenjs --scope project

npx skills add gurenjs/agent-skills
```

**Why a separate repo rather than a directory published from this monorepo.**
Adding `.claude-plugin/marketplace.json` to this repository's root would
technically work for the Claude channel. It breaks the other one. The skills
CLI scans `skills/` and agent skill directories up to three levels deep, and
this monorepo's own `.claude/skills/` holds framework-*development* skills
named `db-manage`, `dev-workflow`, `feature`, `guren-api`, `scaffold` — the
maintainer's tooling, aimed at people editing `packages/`, not at people
building an app. `npx skills add gurenjs/guren` would serve those to
application developers. Separately: `plugin marketplace add` clones the
source, and this monorepo is large and getting larger.

The published repo's contents are **generated, never hand-edited**: sources
live here (§2), `scripts/build-agent-catalog.ts` renders them, and the
release workflow commits the result to the public repo. Nothing is authored
in `gurenjs/agent-skills` itself — the same doctrine already applied to
template dependency versions and spec views: *derived where possible,
declared where not, checked always*.

The rendered payload is **not checked into this monorepo**. It would be a
near-mechanical duplicate of the sources in §2, and it does not ship inside
any npm package, so there is nothing it has to be present for. Note the
disanalogy with `scripts/sync-template-deps.ts`, which does write into
tracked files: the scaffold templates it maintains *are* shipped inside the
`create-guren-app` tarball, so they must be committed regardless and the
`--check` mode simply guards what is already there. This payload has no such
obligation. CI generates it into a temporary directory, asserts against it,
and discards it; the release workflow generates it again and commits it to
the public repo.

### 2. Anti-drift: generate the payload, gate the facts

The payload's sources live with the harness they belong to:

```
packages/cli/templates/agent-catalog/
├── marketplace.json.tpl
├── plugin.json.tpl
├── README.md.tpl                  # repo root README (install instructions)
├── CONTRIBUTING.md.tpl            # "generated — send PRs to gurenjs/guren"
├── plugin-README.md.tpl           # plugins/guren/README.md
└── skills/
    ├── guren-new-app/SKILL.md
    └── guren-harness/SKILL.md
```

Every file in the published tree has a source here, with one exception: the
two `LICENSE` copies are the repository root's own `LICENSE`, copied by the
generator rather than templated, so the published license can never diverge
from the framework's. `plugin.json.tpl` renders **twice** — once to the
plugin root as the Agent Plugins v1 manifest and once to
`.claude-plugin/plugin.json` — from one source, so the two cannot disagree
(§4).

`scripts/build-agent-catalog.ts --out <dir>` renders them. A new
`audit:agent-catalog` script renders into a temporary directory and runs
every assertion below against the result, so a payload that cannot be built,
or that makes a claim the code contradicts, fails the PR that causes it
rather than a user's first install.

There is no byte-comparison step, because there is no committed copy to
compare against. What that costs is real but narrow: the exact published text
never appears in a PR diff, so wording is reviewed at the source rather than
at the output. What it must not cost is provenance — CI renders, asserts, and
discards, and the publish step renders again, so nothing yet proves the
pushed tree is the audited one. The publish script therefore renders
**once**, runs the same assertions `audit:agent-catalog` runs against that
directory, and pushes that same directory; it never pushes a tree it did not
just audit.

| Fact in the payload | Derived from |
|---|---|
| The agent target list the harness skill offers | `AGENT_TARGETS` in `packages/cli/src/agent-targets.ts` |
| Plugin `version` | `packages/cli/package.json` version (see §5) |
| Minimum `@guren/cli` claim | a single constant in the generator, asserted `<=` the workspace version |
| ~~Scaffolder name and invocation~~ | ~~the `create-guren-app` workspace package name~~ **Amended in implementation:** dropped. `create-guren-app` is named literally in the skill and the audit does not derive it; the generator never read the create-app manifest, so listing it as an input was a false promise. Renaming the scaffolder is a template edit under the changeset gate like any other. |
| Every `guren <subcommand>` and flag the skills name | the CLI's registered command list plus each command's declared `args` |

That last row is the one that earns its keep, and it needs a small refactor
first. `builtinSubCommands` in `packages/cli/src/bin.ts` is a private `const`
assembled with a `...makeCommands` spread, the module runs `runCli()` at top
level, and the effective registry additionally includes plugin commands
discovered from `process.cwd()`. So it can be neither imported nor reliably
scraped as it stands, and shelling out to `--help` would vary with whatever
plugins the checkout happens to have. The implementation exports the builtin
registry (or just its name set) from a module `bin.ts` imports, and the audit
reads that.

Two corrections to what such a check is worth. First, it must match bare
`guren <cmd>` as well as `bunx guren <cmd>` — the skills name `guren context`,
`guren check` and `guren audit` in prose, and a `bunx`-anchored pattern would
skip exactly those. Second, command names are the stable part; the fragile
contracts are flags (`--target`, `--changed`, `--agents`, `--blueprint`,
`--db`), any of which could be removed with the audit still green. Since
citty commands declare their `args` declaratively, the audit should check
flags against those declarations too.

But note which flags those are. `--target` and `--changed` belong to the
`guren` CLI; `--agents`, `--blueprint` and `--db` belong to
`create-guren-app`, whose command definition lives in
`packages/create-app/src/cli.ts` — also private, and also running `runMain()`
at top level. Validating those needs a second extraction from a second
package. The cheaper alternative, and the recommended one for v1, is that
`guren-new-app` names no create-app flags at all and tells the agent to read
`bunx create-guren-app --help`; that is one fewer contract to defend and one
fewer package to refactor (Open Question 5). The audit must also bind each
flag to its command — a flat "this flag exists somewhere" set would accept a
real flag on the wrong subcommand.

Note also that `scripts/smoke/docs-audit.ts` is a weaker precedent than it
first appears: it asserts that documentation *contains chosen literal
strings*, and its "mirror" of `planComponents`' MCP config map is a
hand-written array of five paths, not an import. It is precedent for
assertion-based documentation tests, not for derived registry validation.
This RFC proposes going further than it does, which is the reason the
refactor above is needed rather than optional.

The audit must be able to fail. The implementation PR is required to
demonstrate this by mutation: make a skill name a target `AGENT_TARGETS` does
not contain and confirm `audit:agent-catalog` exits non-zero; make it name a
command the CLI does not register, likewise.

**Manifest validation.** `claude plugin validate <rendered>/plugins/guren --strict`
checks manifest syntax and skill frontmatter, and is what the community
marketplace review pipeline runs. Whether it runs unauthenticated in CI is
unconfirmed (Open Question 1). One rule covers both outcomes so the two
sections cannot drift: **`audit:agent-catalog` always attempts it, and treats
"could not run" as its own non-zero outcome, distinct from both pass and
fail.** An unavailable check is not a green one. Whether CI is configured to
block on that distinct code, or only the release workflow is, is the
maintainer's call once the answer is known — but the audit reports the same
thing in both places. Note that this makes validation a *step inside*
`audit:agent-catalog`, not a sibling command: §6 lists it separately only to
name what the audit covers.

**Contribution flow.** The public repo's README and a `CONTRIBUTING.md` state
that it is generated and route changes to `gurenjs/guren` — the next mirror
commit regenerates the payload and would otherwise silently revert a PR
merged there.

### 3. Pre-app usability

Every part of the current harness assumes an installed app. Enumerated:

| Artifact | Assumption |
|---|---|
| `core/rules/orm-models.md`, `controllers-http.md`, `routes-codegen.md`, `testing.md`, `docs-and-spec.md` | `globs` frontmatter scoped to `app/`, `routes/`, `db/`, `tests/`; inert with no such paths — and not carryable by either channel anyway |
| `core/skills/dev-workflow` | `bun run dev`, `bun run build`, `bun run test` — app package scripts |
| `core/skills/db-manage` | `bunx guren db:*` — app CLI plus a configured database |
| `core/skills/scaffold`, `core/skills/feature` | `bunx guren make:*` — app CLI; `feature` also renders `__RULES_DIR__` |
| `core/skills/guren-api` | renders `__RULES_DIR__`, and cites `packages/server/src/...` paths that exist in *this repo*, not in an app |
| `core/skills/plugin-authoring` | cites `docs/en/guides/plugins.md` and `contributing/plugin-contract.md` from this repo |
| `core/entry-intro.md`, `entry-body.md`, `rules-catalog.md` | project directory tree, `bunx guren context`, `.guren/` artifacts |
| `targets/claude/hooks/check-after-edit.ts`, `settings.json` | runs `guren check` on edit |
| all MCP configs | `http://localhost:3333/_guren/mcp`, gated by `GUREN_MCP=1` in the app's `dev` script |

Two consequences.

**`__RULES_DIR__` cannot be rendered for a catalog artifact.** A plugin is
installed to `~/.claude/plugins/cache/…` and a skills-CLI install lands in an
arbitrary project; no generation-time value for that token is correct. The
plugin therefore ships **no copy of `core/skills/`**. Where a plugin skill
needs to point at rules, it says so conditionally: *if this project has run
`agent:init`, the verified API rules are in `.claude/rules/` or
`.agents/rules/`; otherwise run `bunx guren context` for the API digest.*

**The pre-app path must never invoke `bunx guren`.** With `guren` absent from
npm, every `bunx guren …` line reached before an app exists fails for exactly
the user this artifact is for. The scaffolding skill goes through
`bunx create-guren-app` and only reaches `guren …` after the app is on disk
and its dependencies are installed.

The plugin ships two skills, both named so they cannot collide (see §4):

**`guren-new-app`** — for a directory with no Guren app.

1. States what Guren is in a paragraph an agent can act on: Bun, Hono,
   Drizzle, Inertia; Laravel-shaped; conventions the agent should expect.
2. Runs `bunx create-guren-app <name>`, covering the blueprint choice
   (default / api / blog / worker), the database choice, and `--agents` so
   the harness is installed as part of scaffolding rather than as a
   forgotten follow-up step.
3. **Checks the postcondition instead of assuming it.** `create-guren-app`
   exits successfully even when dependency installation fails: it warns,
   skips the harness step, and prints "run `bunx guren agent:init` inside the
   app after installing dependencies". A skill that treats a zero exit as
   "app ready, CLI available" would then invoke a `guren` binary that is not
   installed. So the skill verifies that `node_modules/@guren/cli` exists and
   that an entry document was written; if not, it runs `bun install` and then
   `agent:init` before doing anything else.
4. Hands off: after scaffolding, `CLAUDE.md`/`AGENTS.md` and the rules
   directory in the new app are authoritative — read those, not this skill.
5. Names the three commands that make Guren different, so an agent that
   never opens the docs still knows they exist: `guren context`,
   `guren check`, `guren audit`.

**`guren-harness`** — for a directory that already has a Guren app, or one
just created.

1. Detects a Guren app from positive evidence (a `@guren/core` dependency in
   `package.json`), and defers to `guren-new-app` when absent.
2. Runs `bunx guren agent:init --target <list>`, offering the values derived
   from `AGENT_TARGETS`, and `bunx guren agent:sync` for an existing install.
3. Handles the older-CLI case (§5).
4. Explains the introspection loop — `guren context` at session start,
   `guren check --changed` after editing routes/controllers/models/schema/
   pages — because a catalog-installed skill may be the only harness a user
   has until `agent:init` runs.

Both skills close by directing the agent to the installed harness rather
than to themselves. The plugin's own value ends where `agent:init` begins.

### 4. Target coverage

| Guren target (RFC 0008) | Claude marketplace | `npx skills add` | Agent Plugins v1 |
|---|---|---|---|
| claude | native; skills namespaced `/guren:guren-new-app` | yes (`-a claude-code`) | not an implementer today |
| codex | — | yes → `.agents/skills/` | yes (OpenAI is on the TSC) |
| cursor | — | yes → `.agents/skills/` | yes |
| copilot | — | yes → `.agents/skills/` | yes (VS Code + Copilot CLI) |
| opencode | — | yes → `.agents/skills/` | — |

One repo covers all five, plus every other agent the skills CLI knows
(Gemini CLI, Cline, and ~70 more) and every Agent Plugins client. No target
is dropped, because the per-target work — rules transforms, MCP configs,
Codex approval rules — is not carryable by any of these channels and stays
where it already works, in `agent:init`.

**Conforming to Agent Plugins v1 is nearly free, and the RFC's first draft
did not.** The spec requires `plugin.json` at the **plugin root** carrying
`$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"` and a
`name` matching `[a-z0-9]` plus hyphens and periods, 1–64 characters,
alphanumeric at both ends. Claude Code instead reads
`.claude-plugin/plugin.json`. The first draft shipped only the latter, so the
payload was Claude-shaped rather than portable.

The gap is two things: manifest *location* and a missing `$schema`. The
skills half — `skills/<name>/SKILL.md` — already matches the spec exactly,
and `guren` is already a conforming plugin name. The spec's own migration
guidance is additive ("add root `plugin.json` without removing existing
platform files"), dual manifests are explicitly supported, and VS Code
auto-detects the format by manifest location, reading Agent Plugins,
Copilot-style root `plugin.json`, `.claude-plugin/plugin.json` and legacy
`.plugin/plugin.json` alike. So the payload ships **both**, rendered from one
template. Because everything is generated, the usual objection to duplicated
manifests — that they drift — does not apply here.

Two spec details worth carrying into the implementation. The manifest schema
is **closed**: only `$schema`, `name`, `version`, `description`, `author`,
`homepage`, `repository`, `license`, `keywords` and `extensions` are
permitted at the top level, and anything else is a fatal validation error.
Guren's plugin is metadata-only, so this costs nothing today — but it is the
reason no Claude-specific field can be added to the portable manifest later;
such fields belong under `extensions["<reverse.domain>"]` or stay in
`.claude-plugin/plugin.json`. And the spec's optional root `mcp.json`
(`streamable-http`, `${PLUGIN_ROOT}`/`${PLUGIN_DATA}`) is deliberately not
used, for the same reason §7 gives for Claude's `.mcp.json`: Guren's endpoint
is app-local and `agent:init` writes the client config.

**The collision constraint.** Claude Code namespaces plugin skills by plugin
name, so nothing collides there. `npx skills add` does not: it copies into a
flat `.agents/skills/<name>/`, which is precisely where `agent:init` writes
`dev-workflow`, `db-manage`, `feature`, `guren-api`, `scaffold` and
`plugin-authoring`. A plugin skill named `scaffold` would overwrite the
harness's own. Hence the `guren-` prefix on every plugin skill name, and
hence shipping no copies of `core/skills/`.

**The prune conflict, and the harness change it forces.** Naming alone is not
enough, and this is the one place where shipping into a catalog requires
changing `@guren/cli` rather than only adding to it. `managedNamespaces()`
claims `.agents/skills` and `.claude/skills` as `{ kind: 'tree' }` — the
*whole* directory, recursively. `findStaleManagedFiles()` then reports every
file under those roots that the current plan does not write, and `--prune`
deletes it. A test already pins this behavior deliberately
(`sync --prune deletes a colliding user file — why deletion is opt-in`, in
`packages/cli/tests/agent-harness.test.ts`).

So a catalog install into an app that also has the harness produces:

- `bunx guren agent:sync` reporting `.agents/skills/guren-new-app/SKILL.md`
  and `.agents/skills/guren-harness/SKILL.md` as stale, on every run.
- `bunx guren agent:sync --prune` deleting them.

The framework would be advertising a plugin in a catalog and then flagging
that plugin's files as junk. The `guren-` prefix does not help: the tree
claim ignores names entirely.

The fix belongs in the harness, not in the plugin, and it generalizes beyond
this RFC — today *any* third-party skill a user adds to `.agents/skills/` is
prune-eligible. Add a namespace kind that claims named subdirectories rather
than a whole root:

```typescript
export type ManagedNamespace =
  | { kind: 'tree'; dir: string }
  | { kind: 'pattern'; dir: string; prefix: string; suffix: string }
  | { kind: 'children'; dir: string; names: readonly string[] }   // new
```

`canonicalDirs(root).skills` becomes a `children` claim; `rules` stays a
`tree` (rule files are flat and framework-owned, and the entry documents
present that directory as the framework's rule catalog).

**`names` cannot be the current plan alone, and this is the subtle part.**
*Amended in implementation (2026-08-18):* every claimed name — planned or
retired — is also validated as exactly one plain path segment before it
reaches the walker; the claim is interpolated into a directory `--prune`
removes under, so `..` or `a/b` would otherwise claim outside the app. And
the guarantee is by *name*, not by author: a third-party skill installed
under a canonical name such as `dev-workflow` collides and is refreshed as
the framework's own. The docs and changeset say so. A
claim over only current names can never recognize a skill the framework used
to ship and has since dropped — and cleaning those up is existing, deliberate
behavior, pinned by the test
`sync --prune removes a skill that left the canonical set, directory included`
(`packages/cli/tests/agent-harness.test.ts`). Naming only what is planned
would make that test fail and leave every retired skill on disk forever. So
`names` is **the planned skill names plus a tombstone constant** of names the
framework has shipped in the past:

```typescript
/** Canonical skills the harness used to ship. Prune still owns these names. */
const RETIRED_CANONICAL_SKILLS = [] as const
```

That keeps three properties at once: retired framework skills are still
pruned, externally installed skills are never touched, and no state file or
on-disk marker is introduced — which matters because RFC 0008 explicitly
rejected a state file for sync detection ("No state file, no marker"). The
tombstone is the same device `packages/cli/src/data-types.ts` already uses for
a dropped definition whose name must stay claimed. Its cost is a maintenance
step: removing a canonical skill means adding its name here, which a test can
enforce by asserting the union covers every name any prior release wrote.

Two mechanical notes for the implementer. `findStaleManagedFiles` currently
passes `recursive: namespace.kind === 'tree'` to `readdir` and skips
non-files, so a `children` namespace needs explicit recursion *beneath each
named child* or it will find nothing at all. And `managedNamespaces()`
receives components, not the plan, so the canonical skill names have to reach
it — either by widening its signature or by deriving the names in
`agent-targets.ts` next to `canonicalDirs()`. The exact-expectation test in
`packages/cli/tests/agent-targets.test.ts` needs updating too.

This is a behavior change to `agent:sync --prune`, and it needs its own tests
and a changeset.

RFC 0008's Open Question 2 asked whether tools double-list skills found in
both `.claude/skills/` and `.agents/skills/`. That is a different question
from this one, which is about *ownership* of a flat tree shared with an
external installer. Both should be recorded there.

### 5. Release and versioning

**Plugin version = the `@guren/cli` version the payload was generated from.**
Derived, not declared: it moves exactly when the CLI it describes moves, the
version string answers "which Guren does this plugin know about", and
`plugin.json`'s `version` is what gates `/plugin update`, so users receive
updates on the framework's own cadence. The cost is that a payload-only
wording fix has to ride the next `@guren/cli` release; given this repo's
release frequency that is acceptable, and the alternative — an independent
version plus a gate asserting it was bumped whenever the payload changed —
is a hand-maintained number, which is the class of thing this repo keeps
removing.

**The gate that rule needs.** A plugin's `version` is its cache key: matching
versions skip updates. The payload can change without `@guren/cli` changing —
an edit under `packages/cli/templates/agent-catalog/**` is a template change,
and this repo has had release cycles where a given package does not bump at
all. Mirroring then publishes new content under an unchanged version, and
every installed plugin skips it silently and permanently until the next CLI
bump.

The gate must therefore be expressed in terms a feature PR can satisfy.
Versions in this repo are not bumped by feature PRs: a contributor adds a
`.changeset/*.md`, and `changeset version` (run by the `version-packages`
script) writes the new numbers in a separate release PR. A gate comparing
`packages/cli/package.json` versions against the merge base would fail on
every feature PR — the contributor cannot satisfy it — and would prove
nothing on the release PR, where the sources changed on an earlier commit.
This is the same trap `sync-template-deps.ts` already sidesteps by warning
rather than demanding a bump outside `changeset version`.

So `audit:agent-catalog` asserts **inputs changed ⇒ a `@guren/cli` changeset
is present**. That is satisfiable in the PR that causes the drift, and the
release machinery turns it into a version bump automatically.

"Inputs" must be every input the payload derives from, not just the obvious
two. `packages/cli/templates/agent-catalog/**` and
`scripts/build-agent-catalog.ts` are the authored ones, but the rendered text
also derives from `AGENT_TARGETS` in `packages/cli/src/agent-targets.ts` and
from `create-guren-app`'s package metadata and flag surface (Open Question 2).
A gate watching only the first two would let a new agent target change the
published skill with no version movement. The generator already knows its
inputs; the gate should read that list from the generator rather than
re-declaring it, or it becomes the next thing to drift.

Two implementation notes. `.github/workflows/ci.yml` uses `actions/checkout@v6`
with no `fetch-depth`, so the clone is shallow and neither `main` nor a merge
base is available locally; the gate must fetch the base ref or take the PR base
SHA from the event payload. And the publish-side half — comparing the rendered
plugin `version` against what is already published in `gurenjs/agent-skills` —
must **treat "already published" as a no-op, not an error**: most releases will
not move `@guren/cli`, and the publish script has nothing to do on those.

**Publishing: a maintainer-run script, not a CI push.** The first draft had a
CI job push to `gurenjs/agent-skills` with a repository-scoped token. Review
asked why a token is needed at all, and a survey of how other projects do this
answered it. Remotion keeps its skills' source in its monorepo
(`packages/skills/`) and publishes them to a separate `remotion-dev/skills`
repository — the same shape as this RFC — and the publish step is a script
the maintainer runs locally (`packages/it-tests/src/templates/publish.ts`):
clone the public repo shallow, delete its tracked files, copy the rendered
tree in, commit, push over the maintainer's own SSH. No CI credential, no
secret. Its commit log is a run of "Update template" commits by one person,
several a month.

Guren does the same. `bun run publish:agent-catalog` renders the payload,
runs the `audit:agent-catalog` assertions against it, and pushes it to
`gurenjs/agent-skills` as an ordinary fast-forward commit — never a force
push, because Claude Code keeps a local clone of a registered marketplace and
refreshes it, and a rewritten history risks non-fast-forward failures for
already-registered users. It runs as one line in the release procedure, next
to the already-manual "create the GitHub Release" step. Ordering after a
successful `changeset publish` is then trivially the maintainer's: they run it
after the npm publish they can see succeeded, which is exactly the property a
CI job would have had to reconstruct with `needs:`.

The one thing a manual step lacks is a defense against forgetting. This
repository already has the pattern for that: `published-drift.yml` compares
what is on npm against `main` nightly, deliberately outside `ci.yml` so it
cannot block a PR. A second job there renders the payload from `main` and
diffs it against `gurenjs/agent-skills`'s HEAD; a red run means "run
`publish:agent-catalog`", the same way today's red means "cut the release".
It is read-only, so it needs no token either. That is the one place this
design improves on Remotion's, which has no such check.

**Behavior against an older or newer app.** The rule is that the plugin
encodes no version-specific behavior, only version-*stable* delegation:

- Pre-app commands go through `bunx create-guren-app`, which resolves the
  latest from npm.
- In-app commands resolve through the app's own `@guren/cli`, so the app's
  version, not the plugin's, decides what runs.
- No API signatures appear in the plugin. Those come from `guren context` at
  runtime — the harness's push-beats-pull principle, applied to an artifact
  that ships out of band.
- The one flag that is not universally old-safe is `--target`, added in
  `@guren/cli` 2.5.0. **The skill must probe the version, not wait for an
  error.** Verified against the CLI in this repo: citty silently ignores
  unrecognized flags — `guren agent:init --totallyBogusFlag xyz` installs the
  claude-only harness and exits 0. So on `@guren/cli` 2.4.x,
  `agent:init --target codex,cursor` would install claude-only, print
  "AI agent harness is ready", and exit 0, and a skill that keyed its
  fallback on a non-zero exit would report multi-agent success that never
  happened. `guren-harness` therefore establishes the version *before*
  invoking `agent:init`, with `bunx guren --version`, and below 2.5.0
  installs claude-only deliberately while telling the user that multi-agent
  targets need `@guren/cli` ≥ 2.5.0. (`--version` reported
  `ERROR No version specified` when this RFC was first drafted, which would
  have forced the skill to read `node_modules/@guren/cli/package.json`
  instead; #442 fixed it, so the obvious probe is now the correct one. Note
  the floor this creates: on a CLI older than #442 the probe itself fails, so
  the skill must treat an unparseable version as "older than 2.5.0" rather
  than as an error.)
- A *newer* app is mostly safe, but not "by construction". `agent:init` is
  version-matched to the app, so the harness it installs is always right for
  that app. What is not guaranteed is the plugin's own invocations: it names
  commands and flags, and a future CLI could rename or drop one. That is what
  the derived audit in §2 defends — but only for as long as a given plugin
  version is the one installed, and users can sit on an old one. Keeping the
  plugin's command surface small is the actual mitigation.

### 6. Verification

Nothing here is covered by the existing gate — this is a new artifact in a
new distribution channel, and the failure modes are install-time.

Automated, in CI on every PR:

1. `bun run audit:agent-catalog` — the payload renders, and every derived
   fact holds: targets exist in `AGENT_TARGETS`, every `guren` subcommand it
   names is registered, the minimum-CLI claim is `<=` the workspace version.
2. `claude plugin validate <rendered>/plugins/guren --strict`, reported as
   pass / fail / could-not-run per §2.
3. The root `plugin.json` validates against the Agent Plugins v1 JSON
   Schema (`https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`),
   with the schema vendored rather than fetched so CI does not depend on a
   third-party host. The closed-schema rule makes this a real gate: an
   unrecognized top-level field is fatal to conforming clients (§4).
4. Mutation checks in the implementation PR, proving 1 and the version gate
   can fail: name a nonexistent target; name an unregistered command; edit
   `templates/agent-catalog/**` with no `@guren/cli` changeset present; change
   `AGENT_TARGETS` with no `@guren/cli` changeset present.

Manual, once before the first publish and after any payload change:

5. **Empty directory, skills channel.** `mkdir /tmp/x && cd /tmp/x` →
   `npx skills add gurenjs/agent-skills` → confirm exactly
   `guren-new-app` and `guren-harness` land, and confirm by inspection that
   no step in `guren-new-app` invokes `bunx guren` before an app exists.
   This is the specific failure the npm-404 fact predicts.
6. **Empty directory, Claude channel.** Render the payload locally, then
   `claude plugin marketplace add <rendered>` (local paths are a supported
   marketplace source) and install; verify `/guren:guren-new-app` appears and
   runs end-to-end, producing a working app.
7. **Freshly scaffolded app.** Scaffold with `bunx create-guren-app`, install
   the plugin, run `guren-harness` → `agent:init --target` succeeds,
   `guren check` runs clean.
8. **Collision test.** In an app where `agent:init --target codex` has
   already run, `npx skills add` the plugin and diff `.agents/skills/`:
   nothing the harness wrote may be modified or removed.
9. **Prune test — the one the first draft of this RFC missed.** Continue from
   7: run `bunx guren agent:sync` and assert the plugin's skills are *not*
   reported stale, then `bunx guren agent:sync --prune` and assert they still
   exist. Separately assert the tombstone half still works: a retired
   canonical skill name is still reported and deleted (§4).
10. **Old-CLI degradation.** Pin an app to `@guren/cli` 2.4.x and confirm that
   `guren-harness`'s version probe produces a working claude-only install
   rather than a silent no-op (§5).

### 7. Scope cut for the first shippable version

Explicitly **in**: the repo, `marketplace.json`, one `guren` plugin, two
skills, the generator + CI gate, the `publish:agent-catalog` script + the
nightly drift job, two changes to
`@guren/cli` that shipping into a catalog forces (the `children` managed-
namespace kind so `agent:sync --prune` stops deleting externally installed
skills, §4; and exporting the builtin command registry so the audit can derive
from it, §2), install
instructions in `README.md` and `docs/{en,ja}/guides/cli.md`, and a
strikethrough amendment to RFC 0008's Open Question 2 recording both the
overwrite collision and the prune-ownership problem (§4). The amendment
convention is the one RFC 0008 already uses in its own text and that the
`rfc-authoring` skill documents; `contributing/rfc-process.md` itself does not
codify it.

Explicitly **out**:

- **Any copy of `core/skills/`** — collides on the skills channel, cannot
  render `__RULES_DIR__`, and duplicates what `agent:init` installs correctly.
- **Hooks in the plugin.** A `SessionStart` hook that injects `guren context`
  would be Claude-only, would duplicate the harness hook in any app that has
  run `agent:init`, and needs the app CLI regardless.
- **An MCP server in `plugin.json`.** Guren's endpoint is app-local,
  `GUREN_MCP=1`-gated and loopback-guarded; `agent:init` writes the client
  config. The `mcpServers` field suits a plugin shipping a generic `npx`
  server, which this is not.
- **A bundled docs corpus.** The docs are on guren.dev and `guren context`
  is the in-repo answer; a frozen copy in a plugin is a drift surface with no
  gate.
- **A second plugin** (e.g. a deploy-focused one). One plugin, one name, one
  thing to find.
- **Submission to `anthropics/claude-plugins-community`.** Worth doing —
  it is the catalog that ships registered in every Claude Code install, and
  is more discoverable than a self-hosted marketplace URL — but it is a form
  submission plus a review pipeline, and it should follow a version that has
  been verified in the wild rather than gate the first publish.

### 8. Maintainer actions this needs

- Create `gurenjs/agent-skills` (public, MIT).
- Confirm the marketplace `name` — `gurenjs` is proposed, and it must not be
  spelled `agent-skills` even though that is the repository name:
  `agent-skills` is on Claude Code's reserved marketplace-name list
  (alongside `anthropic-agent-skills`, `claude-plugins-official` and
  others). A marketplace registered under a reserved name stops loading and
  reports an untrusted source, and the list is re-checked on every load, not
  only at add time. Repository names are unconstrained; only the `name` field
  in `marketplace.json` is. Each user can also register only one marketplace
  per name.

~~Found while verifying §5 and worth fixing independently of this RFC:
`guren --version` prints `ERROR No version specified`.~~ **Resolved
(2026-08-17):** fixed in #442, which sets `meta.version` on the root command
from the CLI's own manifest. `guren-harness` uses `guren --version` directly
(§5); no maintainer action is left here.

## Alternatives Considered

- **Publish the marketplace from this monorepo's root.** Rejected: the skills
  CLI would surface this repo's `.claude/skills/` framework-development
  skills to application developers, and `plugin marketplace add` clones a
  large and growing repository.
- **Hand-maintain the published repo.** Rejected on this repo's own record:
  hand-copied generated content is how template dependency ranges rotted and
  how the CLI guide once shipped a false claim about Cursor reading
  `.mcp.json`. A generator plus a CI gate is the established answer.
- **Ship the harness's `core/skills/` verbatim in the plugin.** Rejected:
  flat, unnamespaced installs collide with what `agent:init` writes;
  `__RULES_DIR__` has no correct value outside an app; and a catalog copy
  would drift from the app's own CLI version, which `agent:sync` keeps
  matched by construction.
- **Publish `guren` to npm so `bunx guren` works pre-app.** Rejected here as
  out of scope, and it does not solve the problem: a CLI without an app has
  no routes, models, or schema to introspect, so `context`/`check`/`audit`
  would have nothing to say. It is also a name-squatting and
  version-confusion hazard next to `@guren/cli`.
- **Do nothing and rely on docs SEO.** Rejected: the catalogs are a distinct
  audience reached at a distinct moment — an agent looking for framework
  support before the stack is chosen — and the cost here is days, not weeks.

## Migration Path

Additive for apps, with one narrowing change to an existing command. No app
code changes, no public API changes, no codemod, and `agent:init` output is
unchanged; the plugin is an additional, optional entry point that terminates
in the same commands.

The exception is `agent:sync --prune` (§4). It stops deleting files under
`.claude/skills/` and `.agents/skills/` that the framework never wrote —
externally installed skills, including this plugin's own. Retired canonical
skills are still pruned, via the tombstone constant. The change can only
delete less than it does today, so no app can lose anything it would have
kept; a user relying on `--prune` to clear third-party skills would have to do
that themselves. This ships as a `@guren/cli` minor with the behavior noted in
the changeset.

## Open Questions

1. ~~**Does `claude plugin validate` run unauthenticated in CI?** Determines
   whether manifest validation is a PR gate or a release-workflow step. To be
   settled empirically in implementation.~~ **Resolved in implementation
   (2026-08-18):** it runs unauthenticated wherever the `claude` binary is
   present — verified locally with `--strict` on both the plugin and the
   marketplace manifest — but the ubuntu CI runner has no `claude` on PATH.
   So `audit:agent-catalog` in CI reports validation as *could-not-run*
   (distinct from pass, printed in the log) and gates on the derived-fact
   rules; the validator's blocking run is `publish:agent-catalog`, which
   refuses to publish when it is unavailable (`--skip-validate` is the
   explicit override for a maintainer who validated by hand). Publish is the
   last gate before users, and it runs on a machine that has the CLI.
2. **Plugin version derived from `@guren/cli` vs. independent.** Recommended
   derived (§5); the cost is that a wording fix waits for a CLI release.
   Review raised a sharper objection: `guren-new-app` mostly describes
   `create-guren-app`, which versions independently of `@guren/cli`. A
   create-app flag change can invalidate the skill without moving the plugin
   version, and an unrelated CLI patch moves it for nothing. If the version
   stays derived, the changeset gate in §5 should trigger on
   `create-guren-app` changesets too — or the skill should stop naming
   create-app flags and defer to `create-guren-app --help`.
3. **Marketplace name.** `gurenjs` proposed. The trap is that the repository
   is named `agent-skills` while `agent-skills` is itself a reserved
   marketplace name, so the obvious-looking choice is the broken one (§8).
   Re-confirm against the reserved list at implementation time; it has grown
   before and is re-checked on every load.
4. **Instrumentation.** The premise — that catalogs drive discovery — is an
   assumption, not a measurement. Should the skills carry a distinguishable
   link to guren.dev so the existing analytics can size the channel before
   more is invested in it?
5. **How much should the catalog skills name flags at all?** Every flag named
   is a contract the audit has to defend (§2) and a way the plugin can go
   stale against an app it does not control. The alternative is naming
   commands only and telling the agent to read `--help`, which is more robust
   and less useful. Where is the line?
6. **`anthropics/claude-plugins-community` submission timing.** Deferred out
   of v1 (§7); when?
7. **The Agent Plugins marketplaces are a separate listing problem.** VS Code
   defaults to the `copilot-plugins` and `awesome-copilot` repositories and
   takes extra ones via `chat.plugins.marketplaces`; being spec-conformant
   makes Guren *installable* from a URL but does not make it *listed*. Is
   getting listed in-scope, and in which catalogs?

## Risks to the Premise

Recorded because they argue against parts of this RFC and should be weighed
before it is accepted, not discovered after.

1. **The catalogs cannot carry what makes Guren good.** `check`, `audit`,
   `check --arch`, `check --spec` are app CLI. This artifact buys discovery
   and an on-ramp; it does not put the harness in front of catalog users. If
   the expectation is harness parity in the catalogs, this route cannot
   deliver it and no variation of it can.
2. **The channel rewards content Guren does not lead with.** What a skills
   catalog carries natively is documentation and context injection, so a
   framework whose agent story *is* curated docs fits the channel exactly.
   Guren's story is executable checks, which the channel cannot carry, so
   this artifact under-represents the framework's actual advantage. The
   counter is that the on-ramp still lands the user in an app where that
   advantage is installed and enforced.
3. **The discovery premise is unmeasured.** No public install or referral
   data supports "catalogs put a framework's name in front of undecided
   developers." It is plausible and cheap to test, which is why Open Question
   4 proposes instrumenting it rather than assuming it.
4. **The skills channel is structurally lossy.** Flat, unnamespaced installs
   into `.agents/skills/` mean the plugin shares a directory with the
   harness. Naming avoids today's collision; it does not prevent a future
   third-party skill from taking a name the harness later wants.

## Estimated Effort

One PR in this repository plus a bootstrap push to the new one. Revised upward
after review: the first pass counted only the new files and missed the two
`@guren/cli` changes the design turned out to require, the corrected
changeset-based version gate, and the failure-path testing.

| Work | Estimate |
|---|---|
| `templates/agent-catalog/` sources + the two SKILL.md files | 0.5 day |
| `children` managed-namespace kind + prune tests (§4) | 0.5–1 day |
| Export the builtin command registry out of `bin.ts` (§2) | 0.5 day |
| `scripts/build-agent-catalog.ts` + `audit:agent-catalog` + tests | 1 day |
| Changeset-based version gate + release-side version check (§5) | 0.5 day |
| Agent Plugins v1 manifest + vendored-schema validation (§4) | 0.5 day |
| `publish:agent-catalog` script + nightly drift job (§5) | 0.5 day |
| Manual verification (§6 items 5–10), including failure paths | 1–1.5 days |
| Docs (`docs/{en,ja}/guides/cli.md`), README positioning | 0.5 day |

**5.5–6.5 focused days**, and closer to 8 if either open-ended item bites: the
`bin.ts` extraction turning out to need real surgery on a 2,600-line module
that runs `runCli()` at top level, or `claude plugin validate` not running
unauthenticated in CI (Open Question 1). Excludes the community-marketplace
submission (deferred, §7) and the maintainer-only steps in §8.

## Decisions Needed Before Implementation

1. **Ship this at all**, given Risk 1: the artifact is a discovery and
   on-ramp surface, not harness parity in the catalogs. Success metric
   proposed: catalog installs that convert to scaffolded apps.
2. **Separate repo `gurenjs/agent-skills`, generated from this monorepo and
   published by a maintainer-run script, with the rendered payload not
   committed here** — versus a directory published from this monorepo, and
   versus committing the payload here (§1). This is the shape Remotion uses
   for `remotion-dev/skills`.
3. **Plugin version derived from `@guren/cli`** — versus an independent
   semver with a bump gate (§5, Open Question 2).
4. **Two skills only, no copy of `core/skills/`, no hooks, no MCP server in
   the plugin** (§7).
5. **Accept the two `@guren/cli` changes this forces.** The `children`
   managed-namespace kind (§4) and exporting the builtin command registry
   (§2). Without the first, `agent:sync --prune` deletes the very skills the
   catalog installs. This is the item that turns the RFC from purely additive
   into a narrowing behavior change, so it needs an explicit yes.
6. **Conform to Agent Plugins v1 and ship both manifests** (§4) — versus
   Claude-only, which is what the first draft proposed. The spec is
   vendor-neutral with Amazon, Cursor, Microsoft, OpenAI and Vercel behind
   it, conformance costs one extra rendered file, and the spec's own
   migration guidance is additive. Recommended yes.
7. **Repo `gurenjs/agent-skills`, marketplace name `gurenjs`, plugin name
   `guren`** — note that `agent-skills` is fine as a *repository* name but is
   a reserved *marketplace* name, so the two must not be spelled the same
   (§8).
8. **Publish by a maintainer-run script, not a CI push** (§5): no repository
   token or secret; a nightly read-only drift job in `published-drift.yml`
   catches a forgotten publish. — versus a CI job with a write token, which
   the first draft proposed.
9. **Maintainer action**: create the public repo (§8). Nothing else — no
   token.
10. **Defer the `anthropics/claude-plugins-community` submission** to after a
   version has been verified in the wild (§7, Open Question 6).

## Sources (verified 2026-08-17)

- Claude Code plugin components and layout:
  <https://code.claude.com/docs/en/plugins>,
  <https://code.claude.com/docs/en/plugins-reference>
- Marketplace manifest schema, sources, reserved names, community catalog:
  <https://code.claude.com/docs/en/plugin-marketplaces>
- Agent Skills CLI discovery, install paths, agent list:
  <https://github.com/vercel-labs/skills>
- Agent Plugins v1 specification, schema and migration guidance:
  <https://agent-plugins.org>,
  <https://github.com/agentplugins/agent-plugins-spec/blob/main/spec/1.0.0.md>,
  <https://github.com/agentplugins/agent-plugins-example>
- VS Code plugin format auto-detection and marketplace discovery:
  <https://code.visualstudio.com/docs/agent-customization/agent-plugins>
- Remotion's monorepo-source / separate-publish-repo shape and its
  maintainer-run publish script (surveyed 2026-08-18):
  <https://github.com/remotion-dev/skills>,
  <https://github.com/remotion-dev/remotion/blob/main/packages/it-tests/src/templates/publish.ts>
- `guren` absent from npm: `npm view guren` → 404;
  `@guren/cli` 2.6.1 provides the `guren` bin.
