---
'@guren/cli': minor
---

Link docs to the GitHub issues they belong to (RFC 0018 Part 1)

A concept document under `docs/` may now declare `issues:` alongside
`entities:` and `related:`: `issues: [412, "acme/shop#398", https://github.com/acme/shop/pull/9]`.
The task list, progress and assignee stay on the issue; the document carries
the decision and this one link, so nothing describing a change is committed to
the corpus that describes the system.

- `guren check --docs` warns on an entry in no accepted form. It checks shape
  only and never asks GitHub whether an issue exists, so the gate stays
  deterministic and offline.
- `guren context <Entity>` ends with a **Linked issues** section (and an
  `issues` array in `--json`): every issue the entity's linked docs declare,
  de-duplicated, each naming the docs that declared it. Read from the
  frontmatter alone; a bare number resolves to the `origin` remote's
  repository when there is one.
- `make:adr --issue <ref>` (comma-separated for several) prefills
  `issues:`; a malformed reference fails before anything is written. A URL
  reference may not contain whitespace, quotes, commas or backslashes: the
  characters that would break the flag's list, the quoted YAML scalar the
  scaffold writes, or the scanner's inline-list split.
- The docs viewer's detail panel shows the issues as outlinks. They are not
  graph nodes and carry no live state.
