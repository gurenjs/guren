---
'@guren/cli': patch
---

Recognize every spelling of a project-root `baseUrl` in `guren doctor`

The tsconfig alias check compared `baseUrl` against the literals `"."` and
`"./"`, so a root `baseUrl` written any other way — an absolute path equal to
the project root, `"./."`, or `""` — fell into the "repoints the alias" branch.
That reported the wrong cause and turned the autofix off, leaving behind a
`baseUrl` TypeScript 7 rejects (TS5102). The comparison now resolves both paths
instead of enumerating spellings.
