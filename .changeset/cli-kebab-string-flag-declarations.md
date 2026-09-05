---
'@guren/cli': patch
---

Declare the three remaining camelCase CLI flags with the kebab-case spelling the
docs already use, so `--help` and the docs agree.

`routes:types` and `codegen` declared `pagesOut`, and `audit` declared
`auditConfig`. citty registers only the *declared* arg name, so `renderUsage`
advertised `--pagesOut` and `--auditConfig` while the comments and docs refer to
`--pages-out` and `--audit-config`. They are now declared `'pages-out'` and
`'audit-config'`, matching how `token:issue` declares `'read-only'` and
`'allow-unmatched'`.

Unlike the boolean rename this fixes no parsing bug: these are string args, and
citty's args proxy resolves either spelling to the other in both directions, so
`--pagesOut` and `--pages-out` reach the command identically before and after.
Only the usage line changes.

Aliases are deliberately not used for this — `renderUsage` renders an alias
single-dashed, so `alias: 'pages-out'` would print `-pages-out, --pagesOut`.
