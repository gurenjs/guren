# create-guren-app

`create-guren-app` scaffolds a new Guren project with a sensible default directory layout.

```bash
npx create-guren-app my-app
```

## Options

| Flag | Description |
|------|-------------|
| `--force`, `-f` | Allow scaffolding into a non-empty directory |
| `--mode <spa\|ssr>` | Rendering mode (prompted when omitted) |
| `--db <sqlite\|postgres\|mysql>` | Database driver (prompted when omitted) |
| `--blueprint <name>` | Starter blueprint (`default`, `api`, `worker`) |
| `--auth` | Include authentication scaffolding |
| `--agents <list>` | AI agents to set up the agent harness for (`claude`, `codex`, `cursor`, `copilot`, `opencode`, `all`, or `none` to skip) |
| `--no-install` | Skip `bun install` |
| `--git` / `--no-git` | Initialize a git repository with an initial commit |

The scaffolded app ships a `.gitignore`, so `--git` commits only the project
files — never the generated `.env` (it holds a freshly generated `APP_KEY`).
When omitted, `--git` is prompted in an interactive terminal and defaults to off
elsewhere. It is skipped entirely when the target directory already sits inside
a git repository. `--agents` works the same way: prompted interactively
(multi-select, Claude Code preselected) and defaulting to `claude` in
non-interactive environments.
