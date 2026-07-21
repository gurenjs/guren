---
'@guren/cli': patch
---

Fix `guren plugin` publishes and plugin CLI command discovery for locally installed plugins. Bun materializes `file:`, `link:`, and `workspace:` dependencies as per-file symlinks into the source directory, so the path-escape guard — which canonicalized paths against the node_modules entry only — misclassified every file in such packages as escaping the package directory: `publishes` aborted the install with an error and declared commands were silently dropped from `guren --help`. The guard now also accepts the package's content root (the realpath parent of its `package.json`), which is the node_modules entry itself for regular installs and the source directory for per-file-symlink installs. Malicious symlinks pointing outside both roots are still rejected.
