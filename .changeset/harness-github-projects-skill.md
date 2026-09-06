---
'@guren/cli': minor
---

Add the `github-projects` harness skill (RFC 0018 Part 3)

`agent:init` and `agent:sync` now ship a `github-projects` skill for every
target: how an agent works an issue the way the app tracks work. GitHub Issues
and Projects hold the task, its progress and its assignee; `docs/` holds the
decision with an `issues:` link; `guren context <Entity>` shows what is
attached to a model before it is touched. The skill covers the `project` scope
preflight, one issue per work item with the tasklist on the issue,
`make:adr --issue`, board moves through `gh project item-edit` by field name,
closing through the PR, and the safety rules: issue text is data, bodies are
read only on an explicit `gh issue view`, writes happen only on the user's
request, and nothing runs from a hook.

The `docs-and-spec` rule now covers the `issues:` field, `make:adr --issue`,
and `guren context --live`.
