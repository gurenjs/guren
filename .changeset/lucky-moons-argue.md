---
"@guren/cli": minor
---

Report a routes or health file that could not be read, instead of an empty result

`guren context` rendered `## Routes (0)` / `No routes loaded.` and exited 0
whether the app had no routes or its routes file had thrown on import —
`loadContextRoutes` caught every failure and returned `[]` with no message.
The reason is now carried on `ProjectContext.routesError`, printed under the
Routes heading, and included in `--json`. A routes file that is simply absent
is still not an error: an api-only or mid-scaffold app legitimately has none.
`guren context <Entity>` now makes the same distinction, which it did not
after #482 — it reported a missing routes file as one that could not be read.

Every loader that degrades a missing file to an empty result now shares one
rule for what "missing" means, `isDefinitelyAbsent()`. `fileExists` rethrows
anything that is not `ENOENT`, so a `routes` that is a regular file crashed
`guren context`, `guren context <Entity>` and `spec:generate`/`check --spec`
outright; `existsSync` does the opposite and answers "no", so a dangling
`app/health.ts` or `guren.arch.ts` symlink was silently ignored and the
command reported a clean result from a configuration it never read. Only
`ENOENT` now means absent; everything else reaches the loader, whose error is
what gets reported. Adopted by the three routes callers and by health,
`guren.arch.ts`, and `config/audit.ts` discovery. Absence stays silent only on
the *default* path: a `--routes` or `--health` the caller named is a typo or a
wrong app root when it is not there, and is reported like any other unreadable
file.

`fileExists` keeps the old semantics at its remaining call sites, and two of
them are worth naming rather than leaving to be rediscovered. Inside
`guren check`, `route-path-check.ts` skips its scan on a file it reads as
absent, while `console-check.ts` and `routes-check.ts` already report — but
report the wrong reason, telling you to create a file you can `ls`; all three
also still crash outright on a non-ENOENT probe. And `app-surface.ts` reads a
dangling `routes/web.ts` as the negative evidence that an app cannot render a
page, which is the expensive direction for a rule its own doc says must run on
positive evidence only. They are left for one change together, since the
question of whether a skipped scan belongs in the report is worth settling
first.

`guren health:check` had the same shape with worse output: a health file that
existed and failed to import was logged at debug level (invisible by default)
and reported as "No health manager found", followed by instructions to create
the file the user already has — while `--json` answered `"status": "healthy"`
off the built-in memory and uptime checks. It now names the file and the
reason, carries a failing `health-config` check into the report, and exits 1.
An explicit `--health <path>` that does not exist, or that imports cleanly and
exports no recognizable manager, is reported the same way: the user named that
file, so anything stopping it from yielding a manager is a failure rather than
a search miss. The default candidate list stays a search, and is now deduped
by canonical path so a case-insensitive filesystem cannot report one file
twice — including when that file is a dangling symlink, where `realpath`
cannot answer and the link's own inode identifies it instead. A file exporting
both a placeholder `health` and a real `healthManager` now finds the real one:
the export was picked by truthiness and only then tested for shape, so its
checks never ran. A load failure is reported even when a *later* candidate
does yield a manager, so a broken `app/health.ts` beside a working leftover no
longer answers `"status": "healthy"`. And `--health` with an empty value is
treated as no flag at all: the mode switch and the path list read it
differently, so `--health=` applied named-file strictness to the default
search and failed an app that passes without the flag. `--json` no longer
prints its console prose to stdout either — that prose was landing in front of
the document, so the output only parsed when something else had already
silenced consola. And a report from the app's own manager is normalized before
it is rendered or added to: nothing type-checks what crosses the `import()`
boundary, and one without a `checks` array used to kill the command outright.

Test fixtures are written into temp directories with no `node_modules`, where
Bun's last resort for a bare specifier is to install it — from the global
cache, and from npm on a miss. Auto-install is now disabled in each fixture,
so one that needs `@guren/*` links the workspace copy explicitly rather than
silently binding the published one.
