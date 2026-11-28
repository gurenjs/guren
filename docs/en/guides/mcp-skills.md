# MCP Skills

A skill is a set of instructions your app publishes for the agents of its users: when to call which tool, in what order, and what to do when a call is refused. It is a directory with a `SKILL.md`, in the [Agent Skills](https://agentskills.io/specification) format, and the MCP endpoint serves it to any host that supports the MCP Skills extension.

A tool's description says what one call does. A skill covers what no single description can: the steps of a refund, which of two similar tools comes first, the policy a reply has to follow.

This builds on the [Agent Interface](./agent-interface.md): the app must already serve its tools with `mcpPlugin()`.

These skills are for the people who connect an agent to your app. They are unrelated to `.claude/skills/`, which the [agent harness](./agent-harness.md) installs for your own coding agent.

## Writing a skill

```bash
bunx guren make:mcp-skill refunds --description "Process a refund per shop policy"
```

The command writes `resources/skills/refunds/SKILL.md`:

```md
---
name: refunds
description: "Process a refund per shop policy"
---

# Refunds

Write the steps an agent follows. Name the tools it calls in order, and say what to do when one refuses.
```

`name` is the directory's name: 1 to 64 lowercase letters, digits and single hyphens. `description` is the one line an agent reads to decide whether to load the skill, so say what the skill does and when it applies. Without `--description` the command writes a placeholder for you to replace.

Put supporting files beside `SKILL.md` and refer to them from it by relative path. An agent reads them only when the skill sends it there:

```tree
resources/skills/
└── refunds/
    ├── SKILL.md
    └── references/
        └── policy.md
```

A module keeps its skills in its own directory. Pass `--module`:

```bash
bunx guren make:mcp-skill dunning --module billing
```

This writes `modules/billing/resources/skills/dunning/SKILL.md`.

## What gets published

`bunx guren codegen` collects the skills into `.guren/mcp-skills.gen.ts`. The Vite dev server runs it again whenever a file under a skills directory changes, and the scaffolded `build` script runs it before building. In an API-only app, run the command yourself after editing a skill.

Each skill gets an address under `skill://`. A module's skill takes the module's name as a prefix:

| File | Address |
|---|---|
| `resources/skills/refunds/SKILL.md` | `skill://refunds/SKILL.md` |
| `resources/skills/refunds/references/policy.md` | `skill://refunds/references/policy.md` |
| `modules/billing/resources/skills/dunning/SKILL.md` | `skill://billing/dunning/SKILL.md` |

Codegen publishes every regular file below a skill's directory, whatever its type. It leaves out:

- a directory with no `SKILL.md` directly inside it, and any file placed beside the skill directories
- dotfiles and dot directories, such as `.DS_Store`
- symlinks

Two layouts stop the app at boot, with an error naming both files, because one skill's files would sit inside another's:

- a `SKILL.md` below another skill's directory
- a root skill named after a module that has skills, such as `resources/skills/billing/` beside the `billing` module's skills

## Serving the skills

Point `mcpPlugin()` at the generated module:

```ts
import { mcpPlugin } from '@guren/plugin-mcp'

mcpPlugin({
  skills: {
    files: () => import('@/.guren/mcp-skills.gen'),
  },
})
```

The module is imported, so every deploy bundler inlines the skills and the app reads no directory at runtime. `make:mcp-skill` prints this line when your `mcpPlugin()` call has no `skills` option yet.

The plugin builds the catalog once, at boot. A skill whose frontmatter does not parse, lacks `name` or `description`, or names something other than its directory is left out, and the server says why at startup:

```text
[@guren/plugin-mcp] Skill file "refunds/SKILL.md": SKILL.md frontmatter: line 3: unexpected text after the value (skill skipped)
```

A host on MCP 2026-07-28 that supports the Skills extension lists the skills with `skills/list` and loads one with `skills/get`. To any other client the same files are ordinary resources: each `SKILL.md` appears in `resources/list`, and every file answers `resources/read`.

Listing and reading skills is rate limited per caller, like the endpoint's other reads.

## Who can read a skill

Every caller the endpoint authenticates can read every skill. That includes a token with no `tools:` scope at all, which can call nothing and still read each file.

Two things follow:

- Whatever is in a skills directory is published to everyone who holds a token for your app. Read the directory before you deploy it, and keep credentials, internal URLs and customer data out of it.
- A skill grants nothing and enforces nothing. It can describe a call that the reader's token will be refused, and an agent can ignore it. Keep every rule the app depends on in the route's [policy](./authorization.md) or in its [scopes and approval gates](./agent-tool-governance.md), and use the skill to explain the rule.

## Related

- [Agent Interface](./agent-interface.md): declaring tools and serving them over MCP
- [Control and Audit Agent Tool Access](./agent-tool-governance.md): scopes, approval and audit for the calls a skill describes
- [MCP Apps](./mcp-apps.md): rendering a tool's result as a page inside the host
- [API Tokens](./api-tokens.md): issuing and revoking the tokens a host uses
- [CLI](./cli.md): `make:mcp-skill` and `codegen`
