# MCP Skills

A skill is a set of instructions your app publishes for the agents of its users: when to call which tool, in what order, and what to do when a call is refused. It is a directory with a `SKILL.md`, in the [Agent Skills](https://agentskills.io/specification) format, and the MCP endpoint serves it to any host that supports the MCP Skills extension.

A tool's description says what one call does. A skill covers what no single description can: the steps of a refund, which of two similar tools comes first, the policy a reply has to follow.

Skills are served by `mcpPlugin()`, which the [Agent Interface](./agent-interface.md) guide sets up. An app can publish skills without exposing a single tool.

These skills are for the people who connect an agent to your app. They are unrelated to `.claude/skills/`, which the [agent harness](./agent-harness.md) installs for your own coding agent.

## Writing a skill

```bash
bunx guren make:mcp-skill refunds --description "Process a refund per shop policy"
```

The command writes `resources/skills/refunds/SKILL.md`:

```md
---
name: "refunds"
description: "Process a refund per shop policy"
---

# Refunds

Write the steps an agent follows. Name the tools it calls in order, and say what to do when one refuses.
```

`name` is the directory's name: 1 to 64 lowercase letters and digits, with single hyphens between them. `description` is the one line an agent reads to decide whether to load the skill, so say what the skill does and when it applies. Without `--description` the command writes a placeholder for you to replace. Both values are quoted, so a name such as `no` or `123` stays a string.

Put supporting files beside `SKILL.md` and refer to them from it by relative path. A host loads `SKILL.md` first and fetches the other files when the agent follows a reference:

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

`bunx guren codegen` packages the skills into `.guren/mcp-skills.gen.ts`. While the Vite dev server runs, a change under a skills directory regenerates it, and the scaffolded `build` script runs codegen first. An API-only app has no Vite: its `dev` script runs codegen once at start, so run `bun run codegen` after you edit a skill, and before `typecheck` or `build` on a fresh checkout.

Each skill gets an address under `skill://`. A module's skill takes the module's name as a prefix:

| File | Address |
|---|---|
| `resources/skills/refunds/SKILL.md` | `skill://refunds/SKILL.md` |
| `resources/skills/refunds/references/policy.md` | `skill://refunds/references/policy.md` |
| `modules/billing/resources/skills/dunning/SKILL.md` | `skill://billing/dunning/SKILL.md` |

Codegen packages every regular file below a skill's directory, whatever its type. It leaves out:

- a directory with no `SKILL.md` directly inside it, and any file placed beside the skill directories. A manifest spelled `skill.md` gets a warning, since the name is case-sensitive
- dotfiles and dot directories, such as `.DS_Store`
- symlinks, a symlinked skill directory or skills directory included

Two layouts are refused, because one skill's files would sit inside another's. Codegen warns about them, and the app stops at boot with an error naming both files:

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

The module is imported, so every deploy bundler inlines the skills and the app reads no directory at runtime. Once your source names the module, codegen writes it even while the app has no skill, so the import resolves on a fresh checkout. `make:mcp-skill` prints the `skills` line when none of your `mcpPlugin()` calls carries it.

The plugin builds the catalog once, at boot. A skill whose frontmatter does not parse, lacks `name` or `description`, or names something other than its directory is left out, and the server says why at startup:

```text
[@guren/plugin-mcp] Skill file "refunds/SKILL.md": SKILL.md frontmatter: line 3: unexpected text after the value (skill skipped)
```

A host on MCP 2026-07-28 that supports the Skills extension finds the skills with `skills/list` and `skills/get`, then reads their files with `resources/read`. To any other client the same files are ordinary resources: each `SKILL.md` appears in `resources/list`, and every file answers `resources/read`.

Listing and reading skills is rate limited per caller, like the endpoint's other reads, unless you set `rateLimit: false`.

## Who can read a skill

Every caller the endpoint authenticates can read every skill. That includes a token with no `tools:` scope at all, which can call nothing and still read each file.

Two things follow:

- Whatever is in a skills directory is published to everyone who holds a token for your app. Read the directory before you deploy it, and keep credentials, internal URLs and customer data out of it.
- A skill grants nothing and enforces nothing. Calling a tool it describes still takes a token with the right scope, and an agent can ignore what it says. Keep every rule the app depends on in the route's [policy](./authorization.md) or in its [scopes and approval gates](./agent-tool-governance.md), and use the skill to explain the rule.

## What the checks enforce

`bunx guren check` reads the skills once an app has a skill, a generated module, or an import of one. Whether a skill is served is decided by the same catalog code the endpoint runs at boot, so the check and the server agree.

| Check | Fails or warns when |
|---|---|
| `mcp-skill-frontmatter:<file>` | The endpoint would leave the skill out: no frontmatter, no `name` or `description`, or a `name` that differs from the directory. |
| `mcp-skill-manifest:<file>` | A directory's manifest is spelled in another case, such as `skill.md`, so the directory is not published. |
| `mcp-skill-namespace:<file>` | A `SKILL.md` sits below another skill's directory, or a root skill carries the name of a module that has skills. |
| `mcp-skill-limit:<file>` | One skill holds more than 512 files or 16 MiB, the size every host is required to accept. |
| `mcp-skills-stale` | `.guren/mcp-skills.gen.ts` is missing or differs from the files, so the endpoint serves older ones. `check --fix` runs codegen. |
| `mcp-skills-unserved` | Skills exist and no `mcpPlugin()` call carries `skills` (warning). A call whose options the check cannot read whole is reported as unverified instead. |
| `mcp-skill-host-limit` | A text file over 100 KB, a skill over 400 KB, or more than 100 skills, the limits Claude Code documents (advisory: `check --ci` and `gate` do not count it). |

`bunx guren audit` scans the text files of every published skill for hardcoded credentials, with the rule it applies to source files. `bunx guren tool:list` prints the skills the endpoint would serve below the tools, and `--json` carries them as `skills`.

## Related

- [Agent Interface](./agent-interface.md): declaring tools and serving them over MCP
- [Control and Audit Agent Tool Access](./agent-tool-governance.md): scopes, approval and audit for the calls a skill describes
- [MCP Apps](./mcp-apps.md): rendering a tool's result as a page inside the host
- [API Tokens](./api-tokens.md): issuing and revoking the tokens a host uses
- [CLI](./cli.md): `make:mcp-skill` and `codegen`
