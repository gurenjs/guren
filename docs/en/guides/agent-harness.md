# Agent Harness

Apps scaffolded with `create-guren-app` include an AI agent harness: files that teach coding agents how to work in a Guren app, and hooks that run Guren's checks while they work. This page covers what is installed for each agent, what the hooks do, and how `agent:init` and `agent:sync` maintain the files.

## Choosing agents

The scaffolder asks which coding agents you use (Claude Code, Codex, Cursor, GitHub Copilot, OpenCode) and installs the files each one reads natively. Answer non-interactively with `--agents codex,cursor`, or skip the harness with `--agents none`.

What each selection writes:

| Agent | Project guide | Rules and skills | MCP config | Gate when a turn ends |
|-------|---------------|------------------|------------|-----------------------|
| Claude Code | `CLAUDE.md` | rules, skills and subagents under `.claude/` | `.mcp.json` | `Stop` hook blocks the stop once with the failing findings |
| Codex | `AGENTS.md` | `.agents/rules/`, `.agents/skills/`, and a command-approval allowlist in `.codex/rules/guren.rules` | `.codex/config.toml` | `.codex/hooks.json` blocks the stop once (Codex runs a project hook only after you trust it once with `/hooks`) |
| Cursor | `AGENTS.md` | `.agents/` plus `.cursor/rules/guren-*.mdc` | `.cursor/mcp.json` | `.cursor/hooks.json` sends the findings as a follow-up message, bounded by `loop_limit` |
| GitHub Copilot | `AGENTS.md` | `.agents/` plus `.github/instructions/guren-*.instructions.md` | `.vscode/mcp.json` | None: `AGENTS.md` tells it to run `guren gate` |
| OpenCode | `AGENTS.md` | `.agents/` | the `mcp` entry in `opencode.json` | None: `AGENTS.md` tells it to run `guren gate` |

Skills follow the cross-agent SKILL.md standard. The MCP configs point at the dev server's MCP endpoint, which the scaffolded `dev` script enables with `GUREN_MCP=1`.

Each agent documents the files the harness writes for it. For Claude Code: [`CLAUDE.md` and `.claude/rules/`](https://code.claude.com/docs/en/memory), [skills](https://code.claude.com/docs/en/skills), [subagents](https://code.claude.com/docs/en/sub-agents), [hooks](https://code.claude.com/docs/en/hooks), [MCP](https://code.claude.com/docs/en/mcp) and [`settings.json`](https://code.claude.com/docs/en/settings). For the others: the [`AGENTS.md`](https://agents.md/) format, the [Agent Skills](https://agentskills.io/) standard, Cursor's [rules](https://cursor.com/docs/rules) and [hooks](https://cursor.com/docs/hooks), GitHub Copilot's [repository instructions](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions), and OpenCode's [rules](https://opencode.ai/docs/rules/).

## Hooks

What runs, by agent:

- Claude Code, Codex and Cursor: when a turn ends with uncommitted changes, the gate hook runs [`guren gate`](./cli.md#inspection-audit-commands), so a failing stage is fixed in the same turn rather than in CI. While a plan step that `guren plan:next` marked is not verified (see [Implementation Plans](./implementation-plans.md)), the hook also sends that step's findings back, up to three times.
- Claude Code only: it loads the `guren context` project map at session start, re-runs `guren check` after edits to routes, `app/Http/`, models, schema or pages, and runs oxlint on an edited source file when the app has an `.oxlintrc.json`.
- GitHub Copilot and OpenCode have no hooks. `AGENTS.md` tells them to run `guren context` at session start, `guren check` after edits, and `guren gate` before declaring a change done.

A few details about where the hooks apply:

- A hook gates the app it is installed in, so a monorepo app is gated on its own tree. Claude Code's hooks gate the checkout the session is in, so a worktree it entered is gated on its own tree.
- Cursor reads `.cursor/hooks.json` from the workspace root, so open the app as its own workspace.
- Cursor can also load `.claude/settings.json` hooks when its third-party setting is on. The Claude hook steps aside there, so the gate runs once.

## Before you have an app: install the Guren skills from a catalog

The harness above lives inside an app's `@guren/cli`, so it only exists once an app does. For the step before that (an agent that has never seen Guren, in a directory with nothing in it), Guren publishes two on-ramp skills to the agent catalogs from [`gurenjs/agent-skills`](https://github.com/gurenjs/agent-skills):

```bash
# Claude Code
claude plugin marketplace add gurenjs/agent-skills
claude plugin install guren@gurenjs --scope user

# Cursor, Codex, Copilot, OpenCode, Gemini CLI and others (Agent Skills CLI)
npx skills add gurenjs/agent-skills
```

Install it at user scope: these skills are for the step *before* a project exists, and they are the same two skills whatever you are building. Project scope would write them into whichever repository you happened to be standing in, and share an on-ramp with collaborators of an app that already has the harness. The plugin also conforms to [Agent Plugins v1](https://agent-plugins.org), so any client that reads a root `plugin.json` can install it from that repository directly. It ships `guren-new-app` (explains Guren, scaffolds an app with `bunx create-guren-app`, hands off) and `guren-harness` (runs `bunx guren agent:init --target <agents>` and explains the `guren context` → edit → `guren check` → `guren audit` loop). It deliberately does **not** copy the harness's rules or skills: those are installed by the app's own CLI and stay version-matched to it. The catalog repository is generated from the Guren repository on each release, so send changes to Guren rather than to `gurenjs/agent-skills`.

## Installing and syncing the harness

| Command | Description | Example |
|---------|-------------|---------|
| `agent:init` | Install the agent harness for the selected agents into an existing app (skips files that already exist; `--force` overwrites) | `bunx guren agent:init --target codex,cursor` |
| `agent:sync` | Refresh framework-managed files (rules, skills, subagents, hooks) for every agent detected on disk | `bunx guren agent:sync` |

`agent:init --target` accepts `claude` (the default), `codex`, `cursor`, `copilot`, `opencode`, and `all`. `agent:sync` never overwrites user-owned files (`CLAUDE.md`, `AGENTS.md`, `.claude/settings.json`, and the MCP client configs), so your customizations survive framework updates (a user-owned file you deleted is recreated). When an MCP config or a hook config already exists, `agent:init` leaves it alone and prints the snippet to merge by hand.

Framework-managed files (rules, skills, subagents, hooks) *are* overwritten by `agent:sync`, which is its job, so keep project-specific rules in files of your own instead of appending to the shipped ones. The sync makes every overwrite visible: files that already match the latest version are skipped, and any file that held different contents is called out as replaced. Run `agent:sync --dry-run` first to see what a sync would write, replace, or prune without changing anything. `agent:init` accepts `--dry-run` too, as the preview for `--force`.

When a framework rule or skill is renamed or removed in a release, the old copies stay behind, and Cursor and Copilot keep auto-loading stale `.cursor/rules/guren-*.mdc` / `.github/instructions/guren-*.instructions.md` files. `agent:sync` lists any files in the framework-managed locations that are no longer part of the harness; `agent:sync --prune` deletes them.

The harness claims files **by name**, so your own files in the same directories (or in subdirectories of the rules roots) are never listed or deleted unless they use a claimed name:

| Location | Claimed names |
|----------|---------------|
| `.claude/rules/`, `.agents/rules/` | The rule filenames the harness ships or used to ship, listed in your entry document (compared ignoring case) |
| `.claude/skills/`, `.agents/skills/` | `dev-workflow`, `db-manage`, `scaffold`, `feature`, `guren-api`, `plugin-authoring`, `agent-interface`, `ai-agent`, `github-projects`, `plan-write`, `plan-implement` |
| `.cursor/rules/`, `.github/instructions/` | **Any** `guren-*.mdc` / `guren-*.instructions.md` file at the top level |

Skills that `npx skills add` and Agent Plugins clients install into the same directories are yours by this rule too. Keep your own Cursor and Copilot rules under a different prefix, and review the report before `--prune`: a file of your own under a claimed name is the one case it removes.
