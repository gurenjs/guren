# Guren Agent Skills

Agent skills for building [Guren](https://guren.dev) applications — a
Laravel-inspired fullstack TypeScript framework on Bun — with Claude Code,
Cursor, Codex, GitHub Copilot, OpenCode and other coding agents.

## Install

**Claude Code**

```bash
claude plugin marketplace add gurenjs/agent-skills
claude plugin install guren@gurenjs --scope project
```

**Cursor, Codex, Copilot, OpenCode, Gemini CLI and others** (Agent Skills CLI)

```bash
npx skills add gurenjs/agent-skills
```

The plugin also conforms to [Agent Plugins v1](https://agent-plugins.org),
so any client that reads a root `plugin.json` can install it from this
repository directly.

## What you get

Two skills that get you *to* a Guren app and *into* its harness:

- **`guren-new-app`** — explains Guren to an agent that has never seen it,
  scaffolds an app with `bunx create-guren-app`, and hands off.
- **`guren-harness`** — installs the app's own agent harness with
  `bunx guren agent:init --target <agents>` and explains the
  `guren context` → edit → `guren check` → `guren audit` loop.

The harness itself — glob-scoped rules, per-agent entry documents, hooks, MCP
client configs — is installed by the app's `@guren/cli`, not by this plugin.
This is deliberate: it stays version-matched to the app you are working in.

## Version

This is version `__CLI_VERSION__`, generated from `@guren/cli` __CLI_VERSION__.
It follows the CLI's releases.

## Generated — please do not open PRs here

Every file in this repository is rendered from
[gurenjs/guren](https://github.com/gurenjs/guren)
(`packages/cli/templates/agent-catalog/`) and published on each release. A
pull request here would be overwritten by the next publish. Send changes to
`gurenjs/guren` instead — see [CONTRIBUTING.md](./CONTRIBUTING.md).
