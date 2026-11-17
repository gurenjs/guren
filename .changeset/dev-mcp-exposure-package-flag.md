---
'@guren/cli': patch
---

The Dev MCP `guren_get_dependency_exposure` tool passes its `package` value to the child `guren deps:exposure` as one `--package=<value>` argument. A value starting with `-`, such as `--app=<dir>`, was parsed as a flag of its own and could point the child at another directory, whose code introspection then ran. Such a value is now only the package filter, which matches no package.
