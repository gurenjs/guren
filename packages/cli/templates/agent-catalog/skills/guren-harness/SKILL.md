---
name: guren-harness
description: Install or refresh the Guren agent harness (rules, skills, hooks, MCP config) inside an existing Guren app for Claude Code, Codex, Cursor, Copilot, and OpenCode, and explain the guren context / check / audit loop. Use when the user has a Guren app and says "set up the harness", "agent:init", "sync the harness", "install Guren rules for Cursor", or asks how to work in a Guren app with an AI agent. For a directory with no Guren app, use guren-new-app instead.
---

# Guren Harness

Guren ships its agent harness inside the app's own `@guren/cli`, installed by
`guren agent:init` and refreshed by `guren agent:sync`. This skill gets that
installed and tells you how to use it. The installed harness — the rules
directory, the entry document, the hooks — is authoritative once present;
this skill is the on-ramp to it, not a replacement.

## Detect a Guren app

Positive evidence only: a `package.json` here (or in a parent) whose
`dependencies` or `devDependencies` include `@guren/core`. If there is none,
stop and use the `guren-new-app` skill. If the dependencies are declared but
`node_modules/@guren/cli` is missing, run `bun install` first — nothing
below works without it.

## Probe the CLI version before installing

Run:

```bash
bunx guren --version
```

Multi-agent targets need `@guren/cli` __MIN_CLI__ or newer. Older CLIs
**silently ignore** an unrecognized `--target` flag: `agent:init --target
codex,cursor` on such a CLI installs a Claude-only harness, prints "AI agent
harness is ready", and exits 0. A fallback keyed on a non-zero exit would
report multi-agent success that never happened, so decide from the version
first:

- Version parses and is ≥ __MIN_CLI__ → proceed with `--target`.
- Version is older, **or `--version` itself fails or prints no version** (a
  CLI older still) → treat as older than __MIN_CLI__: run plain
  `bunx guren agent:init` (Claude-only), and tell the user that multi-agent
  targets need `@guren/cli` ≥ __MIN_CLI__ (`bunx guren upgrade`).

## Install

```bash
bunx guren agent:init --target <list>
```

`<list>` is comma-separated from: __AGENT_TARGETS__, or `all`. Ask which
agents the team uses; the default is `claude` only. The command writes the
entry document (`CLAUDE.md` for Claude Code, `AGENTS.md` for the others),
glob-scoped rule files, skills, subagents and hooks for Claude, and an MCP
client config per target. It never overwrites an existing entry document or
MCP config without `--force`; if an MCP config already exists without the
Guren endpoint, it prints the snippet to merge by hand.

## Refresh

```bash
bunx guren agent:sync
```

Overwrites framework-managed files (rules, skills, subagents, hooks) with the
installed CLI's version and leaves user-owned files alone. It reports files
under the managed locations that the current harness no longer writes;
`--prune` deletes those. Rules files of your own in `.claude/rules/` /
`.agents/rules/`, and skills you or another installer (including this plugin)
added to `.claude/skills/` or `.agents/skills/`, are never touched unless they
sit under a name the harness itself ships — the claim is by name, so avoid the
canonical skill names (`dev-workflow`, `db-manage`, `scaffold`, `feature`,
`guren-api`, `plugin-authoring`, `agent-interface`) and the shipped rule
filenames for your own.

## The loop the harness expects

Until `agent:init` has run, this is the only harness you have, so follow it
yourself:

1. **Session start**: `bunx guren context`. Its output ends with an API
   signature digest for the ORM, controller, and testing APIs — read it
   before writing code. `bunx guren context <Entity>` bundles everything
   about one model. With the MCP server connected, `guren_get_context` is the
   same map.
2. **After editing** routes, controllers, models, `db/schema.ts`, or pages:
   `bunx guren check`, and `bunx guren check --changed` to scope it to your
   diff. Fix what it reports before moving on.
3. **Before shipping**: `bunx guren audit` for validation and auth gaps on
   mutating routes, raw SQL, and secrets.

Once installed, the entry document describes the same loop for the app; the
Claude harness automates steps 1 and 2 with hooks, the others say so in
`AGENTS.md`. Read the installed rules in `.claude/rules/` or `.agents/rules/`
— each file's `globs` frontmatter says which paths it covers — before
editing those paths.
