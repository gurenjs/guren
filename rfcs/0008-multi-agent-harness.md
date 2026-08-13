# RFC: Multi-Agent Harness (Codex, Cursor, GitHub Copilot, OpenCode)

**Author:** Urata Daiki
**Date:** 2026-08-12
**Status:** Draft

## Problem

`guren agent:init` installs an agent harness that only Claude Code can use:
`CLAUDE.md`, `.claude/rules/`, `.claude/skills/`, `.claude/agents/`,
`.claude/hooks/`, `.claude/settings.json`, and `.mcp.json`. Yet almost none of
the harness *content* is Claude-specific:

- The rule files are verified API references with `description` + `globs`
  frontmatter — a shape Cursor and Copilot can consume natively after a
  mechanical frontmatter transform.
- The skills are already written in the SKILL.md format that became the open
  Agent Skills standard (agentskills.io, December 2025) and is now read
  natively by Codex, Cursor, Copilot/VS Code, and OpenCode. Only the
  *directory* they sit in is Claude-flavored.
- The MCP endpoint (`/_guren/mcp`) is protocol-standard; every major agent can
  connect to a streamable-HTTP server. Only the config file location differs.
- The introspection workflow (`guren context` → edit → `guren check`) is plain
  CLI usage any agent can follow.

The result: a team using Codex, Cursor, Copilot, or OpenCode on a Guren app
gets none of the guidance the framework worked to verify, even though our own
evals show the harness is the difference between agents completing tasks and
failing them. Worse, the current template *claims* more than it delivers — it
tells users that Cursor auto-connects to `.mcp.json`, but Cursor reads
`.cursor/mcp.json`, not `.mcp.json`.

## Verified landscape (2026-08)

Formats verified against vendor docs in August 2026 (sources at the end).

| Capability | Claude Code | Codex CLI | Cursor | GitHub Copilot | OpenCode |
|---|---|---|---|---|---|
| Entry instructions | `CLAUDE.md` (does **not** read `AGENTS.md`; official workaround is an `@AGENTS.md` import) | `AGENTS.md` (walks up from cwd) | `AGENTS.md` + `.cursor/rules/` | `AGENTS.md`, `.github/copilot-instructions.md` | `AGENTS.md` (wins over `CLAUDE.md` when both exist) |
| Path-scoped rules | `.claude/rules/*.md` (`description` + `globs` list) | none (nested `AGENTS.md` only) | `.cursor/rules/*.mdc` (`description`, `globs` comma string, `alwaysApply`) | `.github/instructions/*.instructions.md` (`applyTo` comma string) | none (`opencode.json` `instructions` is unscoped) |
| Skills (SKILL.md standard) | `.claude/skills/` only | `.agents/skills/` | `.agents/skills/`, `.cursor/skills/` (+ compat: `.claude/skills/`, `.codex/skills/`) | `.agents/skills/` (VS Code default), `.github/skills/`, `.claude/skills/` | `.opencode/skills/`, `.agents/skills/`, `.claude/skills/` |
| Project MCP config | `.mcp.json` | `.codex/config.toml` `[mcp_servers.*]` with `url` (trusted projects) | `.cursor/mcp.json` | `.vscode/mcp.json` (`servers` key) | `opencode.json` `mcp` key |
| Lifecycle hooks | `settings.json` hooks (SessionStart, PostToolUse) | none | hooks (beta) | none | JS plugins |

Two structural facts fall out of this table:

1. **Skills need no conversion, only placement.** `.agents/skills/` is read
   natively by every target except Claude Code, which reads `.claude/skills/`.
2. **`AGENTS.md` is the shared entry point for every target except Claude
   Code** (tracked upstream as anthropics/claude-code#34235; the `@AGENTS.md`
   import from `CLAUDE.md` is the documented bridge).

The genuinely Claude-specific pieces are the *push* mechanisms: the
`SessionStart` hook that injects `guren context` and the `PostToolUse` hook
that re-runs `guren check` after edits. No other target has an equivalent
today (Cursor hooks are beta; OpenCode plugins would need JS). For those
targets the harness degrades from push to pull: the entry document instructs
the agent to run the same commands itself.

## Proposed Solution

### Canonical content + per-target emitters

Restructure `packages/cli/templates/agent/` into agent-neutral canonical
content plus per-target static files:

```
packages/cli/templates/agent/
├── core/
│   ├── AGENTS.md            # canonical entry document (agent-neutral body)
│   ├── rules/*.md           # canonical rules: description + globs frontmatter
│   └── skills/*/SKILL.md    # Agent Skills standard, unchanged
└── targets/
    ├── claude/              # CLAUDE.md, settings.json, hooks/, agents/
    ├── codex/               # config.toml MCP snippet
    ├── cursor/              # mcp.json
    ├── copilot/             # .vscode/mcp.json
    └── opencode/            # opencode.json snippet
```

A new module `packages/cli/src/agent-targets.ts` becomes the one rule for
which files each target owns and how canonical content renders into them
(same doctrine as `inflect.ts` / `route-registrar.ts`: one rule, one module):

```typescript
export type AgentTarget = 'claude' | 'codex' | 'cursor' | 'copilot' | 'opencode'

export interface PlannedFile {
  path: string          // app-relative, e.g. '.cursor/rules/guren-testing.mdc'
  content: string
  managed: boolean      // true → agent:sync overwrites; false → write-once
}

export function planTargets(targets: AgentTarget[], canonical: CanonicalHarness): PlannedFile[]
```

`installAgentHarness()` keeps its init/sync/force semantics but iterates over
planned files instead of raw template entries. Overlapping targets (e.g.
`codex` and `opencode` both plan `.agents/rules/`) dedupe by path; identical
content is guaranteed because both render from the same canonical source.

### Per-target rendering

**Rules.**

| Target | Output | Transform |
|---|---|---|
| claude | `.claude/rules/<name>.md` | verbatim (status quo) |
| cursor | `.cursor/rules/guren-<name>.mdc` | `globs` list → comma-joined string; add `alwaysApply: false`; keep `description` |
| copilot | `.github/instructions/guren-<name>.instructions.md` | `globs` list → `applyTo` comma-joined string; keep `description` |
| codex, opencode | `.agents/rules/<name>.md` | verbatim |

Codex and OpenCode have no scoped-rule loader, so their `AGENTS.md` carries a
stable paragraph instead of a per-file index: *"Before editing, consult
`.agents/rules/` — each file's `globs` frontmatter states which paths it
covers."* A generated index table was rejected: `AGENTS.md` is user-owned
(see below), so `agent:sync` could not refresh the table when a framework
update adds a rule file, and a managed-marker block inside a user-owned file
is new machinery this feature does not need. The stable paragraph never
drifts.

Generated files in *shared* directories (`.cursor/rules/`,
`.github/instructions/`) take a `guren-` filename prefix so framework
ownership is unambiguous next to user-authored rules. `.claude/` and
`.agents/` outputs keep their current names.

**Skills.** Copied verbatim (the format is already the standard):

- `.claude/skills/` — when the `claude` target is selected (status quo).
- `.agents/skills/` — when any non-Claude target is selected.

When both are present the two trees are byte-identical and both managed, so
they cannot drift. Tools that scan both locations (Cursor, OpenCode, Copilot)
are expected to dedupe by skill name; Part 1 of the implementation verifies
this per tool (see Open Questions).

**Entry documents.**

*Amended during review (2026-08-13):* both entry documents are assembled from
three template pieces — a shared intro (title, overview, introspection
commands), a per-target workflow section (Claude's hook description vs. the
manual session loop), and a shared body (structure, commands, MCP,
architecture, testing) with the rules directory as a token. Review found the
two hand-maintained copies already disagreeing on day one (the old CLAUDE.md
carried a Japanese MCP section and claims the body had dropped), which also
retires the "no churn for claude" line below: the claude output changes once,
to the assembled — and now correct — document. The per-target bullets
otherwise stand:

- `claude` only (default): `CLAUDE.md` ~~exactly as today. No churn~~.
- Any non-Claude target: `AGENTS.md` with the canonical body. Its "session
  workflow" section replaces the hook description with pull instructions: run
  `bunx guren context` at session start (or call the `guren_get_context` MCP
  tool), run `bunx guren check --changed` after editing routes, controllers,
  models, schema, or pages.
- `claude` combined with others: `AGENTS.md` as above, plus ~~a thin
  `CLAUDE.md` containing the Claude-specific harness description (hooks,
  settings, `.claude/rules` auto-attach) followed by an `@AGENTS.md` import —
  the officially documented bridge — with a note that the manual
  session-workflow section is automated by hooks and can be ignored~~
  **Amended during Part 1 (2026-08-12, maintainer decision):** the same full
  `CLAUDE.md` as a claude-only install. Claude Code never reads `AGENTS.md`,
  so its entry document should stand on its own rather than route through an
  import; the two files describe the same project and each tool reads only
  its own.

**MCP configs.** All user-owned, written only when absent:

| Target | File | Shape |
|---|---|---|
| claude | `.mcp.json` | status quo |
| cursor | `.cursor/mcp.json` | same JSON shape as `.mcp.json` |
| copilot | `.vscode/mcp.json` | `{ "servers": { "guren": { "type": "http", "url": "http://localhost:3333/_guren/mcp" } } }` |
| codex | `.codex/config.toml` | `[mcp_servers.guren]` + `url = "http://localhost:3333/_guren/mcp"` |
| opencode | `opencode.json` | `{ "$schema": "https://opencode.ai/config.json", "mcp": { "guren": { "type": "remote", "url": "…" } } }` |

MCP client configs frequently pre-exist with unrelated user configuration.
The installer does **not** merge into existing files — it skips them and
prints the snippet to add by hand. Structured merging of several formats
(TOML, VS Code JSON, OpenCode JSON) is risk without payoff at this scale;
revisit only if skip-and-print proves noisy in practice. *Amended during
review (2026-08-13):* the skip-and-print treatment is derived from the file's
role — it applies to **every** MCP client config, including `.mcp.json`
(originally omitted, which left a repo with a pre-existing `.mcp.json` and
`GUREN_MCP=1` already in its `dev` script with zero signal that the Guren
server was never wired). The hint prints on `init` only; `sync` stays quiet
about configs the user has decided to keep without the endpoint.

The endpoint's security posture is unchanged: `GUREN_MCP=1` opt-in,
loopback-only guard. Cloud agents (Copilot coding agent on github.com) cannot
reach `localhost` — the `.vscode/mcp.json` serves local VS Code/Copilot CLI
sessions, and that limitation is documented rather than worked around.

**Command approval policy (Codex).** *Added during Part 1 (2026-08-12):*
Codex's project-layer `.codex/rules/*.rules` (Starlark `prefix_rule`, loaded
in trusted projects only) is the analogue of `.claude/settings.json`'s
`permissions.allow` — an approval policy for shell commands, not instruction
rules. The codex target ships `.codex/rules/guren.rules` allowing the
harness's own commands (`bunx guren …`, `bun run codegen`,
`bun run typecheck`, `bun test`) to run without prompts. User-owned:
`agent:sync` never widens an approval policy behind the user's back.

**Hooks, settings, subagents.** Claude-only in this RFC: `settings.json`,
`.claude/hooks/`, `.claude/agents/` ship exactly as today, only for the
`claude` target. Cursor hooks (beta) and OpenCode JS plugins could port
`check-after-edit` later — listed as future work, not scoped here, because
both mechanisms are young and the pull instructions in `AGENTS.md` cover the
gap at push-minus-one fidelity.

### CLI surface

```bash
guren agent:init                        # claude only — unchanged default
guren agent:init --target codex,cursor  # comma-separated selection
guren agent:init --target all           # every supported target
guren agent:sync                        # refresh every installed target
guren agent:sync --target cursor        # constrain the refresh
```

`agent:sync` detects installed targets statelessly from positive evidence of
managed artifacts (same doctrine as `app-surface.ts`). ~~`.claude/rules/` →
claude; `.cursor/rules/guren-*.mdc` → cursor; `.github/instructions/guren-*`
→ copilot; `.agents/rules/` → the shared codex/opencode family.~~ *Amended
during review (2026-08-13):* hand-listed sentinels re-encode planner
knowledge in the detector and drift when an output path changes — and bare
directory existence read a hand-authored `.agents/rules/` as an installed
harness. Detection now derives from the plans themselves: a component counts
as installed when any managed file `planComponents` would write for it
exists on disk. Codex and OpenCode need no distinction at sync time — their
managed outputs are identical; only the user-owned extras differ, and sync
never touches user-owned files. No state file, no marker.

`create-app` currently shells out to `agent:init`; agent selection becomes
part of the scaffold interview. In interactive sessions a multi-select prompt
(`consola.prompt` `type: 'multiselect'`, alongside the existing rendering-mode
and database prompts) asks which agents the team uses — Claude Code, Codex,
Cursor, GitHub Copilot, OpenCode — with Claude Code preselected, and the
chosen set is passed through as `--target`. A `--agents <list>` flag answers
the prompt non-interactively (`--agents none` skips the harness entirely); in
non-interactive environments without the flag the default stays claude-only,
matching today's output so CI scaffolds and the starter smokes remain
deterministic.

### Managed vs. user-owned

| Class | Paths |
|---|---|
| Managed (sync overwrites) | `.claude/rules/`, `.claude/skills/`, `.claude/agents/`, `.claude/hooks/`, `.agents/rules/`, `.agents/skills/`, `.cursor/rules/guren-*.mdc`, `.github/instructions/guren-*.instructions.md` |
| User-owned (write-once; only `init --force` replaces) | `CLAUDE.md`, `AGENTS.md`, `.claude/settings.json`, `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.codex/config.toml`, `opencode.json` |

`MANAGED_PREFIXES` generalizes from a prefix list to per-target matchers
(prefix or filename-prefix-within-directory) supplied by `agent-targets.ts`.

### Documentation and template fixes

- Fix the current template's false claim that Cursor connects via `.mcp.json`.
- `docs/{en,ja}/guides/cli.md`: document `--target`, the per-agent file map,
  and the pull workflow for hook-less agents.
- README / docs positioning: the harness section drops "Claude Code" as an
  implied requirement and names the supported targets.

### Implementation plan

Three parts, each its own PR referencing this RFC.
*Amended during implementation (2026-08-12): Parts 1 and 2 shipped together
in the initial PR — the cursor/copilot rule transforms turned out to be a
thin rendering step over the Part 1 emitter split, not worth a PR boundary.
Part 3 remains separate.*

1. **Part 1 — emitter split + `--target` + `agents` family + `AGENTS.md`.**
   Restructure templates into `core/` + `targets/`, add `agent-targets.ts`,
   ship the codex/opencode emitter (`AGENTS.md`, `.agents/rules/`,
   `.agents/skills/`, MCP snippets). This alone gives Codex, OpenCode — and,
   via their native `AGENTS.md`/`.agents/skills/` support, Cursor and Copilot
   — a working baseline. Verify per-tool skill-name dedup here.
2. **Part 2 — cursor + copilot native rules.** `.cursor/rules/guren-*.mdc`
   and `.github/instructions/guren-*.instructions.md` transforms, plus their
   MCP configs and sync detection.
3. **Part 3 — create-app wiring + docs.** The interactive agent multi-select
   prompt + `--agents` flag, en/ja docs, README positioning, template claim
   fix.

Every part runs `audit:starter-template` and `smoke:starter` (the smokes
exercise `agent:init` through `create-app`), `audit:docs`, and
`audit:core-first` in addition to the normal gate.

## Alternatives Considered

- **Symlink the per-agent locations to one canonical directory.** Rejected:
  symlinks break on Windows checkouts, are flattened or dropped by some tools
  and archives, and this repo has already been burned by symlink handling in
  local plugin installs (#121) and deploy builds (#222).
- **Ship only `AGENTS.md` and skip scoped rules.** Rejected: glob-scoped
  auto-attach is the push half of the harness's push-beats-pull design. Where
  a tool loads rules natively per-path (Cursor, Copilot), flattening
  everything into one entry file both bloats every session's context and
  makes rule delivery depend on the agent choosing to read files.
- **Delegate to a third-party config synchronizer** (chezmoi-style dotfile
  sync, community "one brain" tools). Rejected: the harness must version with
  the framework — `agent:sync` ships rule updates alongside API changes — and
  an external tool cannot know Guren's managed/user-owned boundary.
- **Emit every target unconditionally (no `--target`).** Rejected: seven
  config trees for tools a team does not use is repo noise, confuses tool
  pickers that key off directory presence, and widens PR diffs for nothing.
- **Wait for the ecosystem to converge.** Skills already converged (this RFC
  exploits that), but Claude Code still does not read `AGENTS.md`
  (anthropics/claude-code#34235 open since 2025) and rules/MCP locations show
  no sign of unifying. Waiting has a real cost each month: every non-Claude
  Guren user works unharnessed.

## Migration Path

Purely additive — a `@guren/cli` minor release. Existing apps see no change:
`agent:init` without `--target` and `agent:sync` on a claude-only app behave
exactly as today. New targets are opt-in per app. No codemod, no deprecation.

## Open Questions

1. ~~create-app default: claude-only flag vs. interactive prompt.~~
   **Resolved (2026-08-12, maintainer decision):** create-app asks
   interactively with a multi-select prompt and emits the harness for the
   chosen agents; `--agents` answers it non-interactively, and environments
   without a TTY fall back to claude-only. Folded into Proposed Solution
   above.
2. **Skill duplication across `.claude/skills/` and `.agents/skills/`.**
   Cursor, OpenCode, and Copilot scan both. If any of them double-lists
   same-named skills instead of deduping, fall back to: emit
   `.agents/skills/` only when a non-Claude target is selected *without*
   claude, and document the combination caveat. To be settled empirically in
   Part 1.
3. **`copilot-instructions.md`.** Modern Copilot reads `AGENTS.md`, so this
   RFC does not emit `.github/copilot-instructions.md`. Older Copilot
   versions read only the latter — is supporting them worth a third entry
   document? Current lean: no.
4. **Hook parity.** When Cursor hooks leave beta (and if OpenCode plugin API
   stabilizes), should `check-after-edit` ship for them? Out of scope here;
   tracked as future work.

## Sources (verified 2026-08)

- Agent Skills standard and adoption: <https://agentskills.io>,
  <https://www.agensi.io/learn/agent-skills-open-standard>
- Codex skills / config / MCP: <https://developers.openai.com/codex/skills>,
  <https://developers.openai.com/codex/config-reference>,
  <https://developers.openai.com/codex/mcp>
- Codex command approval rules (Starlark `prefix_rule`):
  <https://learn.chatgpt.com/docs/agent-configuration/rules>
- Cursor skills discovery (`.agents/skills/` + compat paths):
  <https://cursor.com/docs/skills>; rules format:
  <https://cursor.com/docs> (`.cursor/rules/*.mdc`)
- Copilot instructions & skills:
  <https://docs.github.com/copilot/customizing-copilot/adding-custom-instructions-for-github-copilot>,
  <https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills>
- OpenCode rules / skills / config: <https://opencode.ai/docs/rules/>,
  <https://opencode.ai/docs/skills/>
- Claude Code AGENTS.md status: <https://github.com/anthropics/claude-code/issues/34235>
