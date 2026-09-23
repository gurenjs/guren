---
'@guren/cli': patch
---

`guren make:migration` runs the drizzle-kit the application installs, found in its `node_modules` or a parent's, instead of `bun x drizzle-kit`, which fell through to npm's copy when the app had no `.bin` link. With none installed it stops and asks for `bun install`. drizzle-kit now runs under Bun, so a `drizzle.config.json` loads where Node refused to import it. The scaffolders that generate a migration (`guren add session`, `add oauth`, `add ai`, `make:auth`) find a hoisted drizzle-kit the same way, where they used to look only in the current directory's `node_modules`.
