---
'@guren/cli': minor
'@guren/server': minor
---

Ask GitHub about linked issues with `guren context <Entity> --live` (RFC 0018 Part 2)

`guren context <Entity>` gains two flags, and the `guren_entity_context` MCP tool
the matching `live` and `repo` arguments:

- `--live` asks `gh` for the state, assignees, labels and title of every issue
  the entity's linked docs declare: one `gh api graphql` query per repository,
  never the body. Each issue that GitHub answered for carries a `live` object in
  `--json` and a second line under its entry in markdown, with a note that titles
  are external text. When `gh` is missing, not logged in, or exceeds 5 seconds,
  `issuesLiveError` says why and the offline list stands; the exit code is
  unaffected. Nothing in `guren check`, `gate`, or a hook is touched by this.
- `--repo owner/name` names the repository bare issue numbers belong to, for a
  fork, a mirror, or a checkout with no `origin`; with it, no git command runs.

`@guren/server` widens the `GurenCliApi.generateEntityContext` options it
passes through; an older `@guren/cli` ignores the two new fields.
