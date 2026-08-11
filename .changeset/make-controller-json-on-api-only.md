---
'@guren/cli': patch
---

Adapt `make:controller` and refuse `make:view` on an API-only app instead of writing Inertia files that cannot typecheck

On an app scaffolded from the `api` blueprint, the controller `guren
make:controller` generated was the one file the app's own tsconfig would flag:
it imports `@/.guren/pages.gen`, which codegen never writes there, and returns
`this.inertia(...)` against a `@guren/inertia-client` that is not installed.
Unlike the multi-file scaffolds (`add auth`, `add admin`, `add resource`), which
refuse such an app, a lone controller has an obvious API dialect — so the
template now adapts: on an app the two signals those refusals already read
(no `@guren/inertia-client` dependency, no `routes/web.ts` or `routes/web.js`)
confirm as API-only, the generated controller returns `this.json(...)` and can
be wired into `routes/api.ts` as written. The refusals those scaffolds print
now point at this command rather than telling you to write the controller by
hand.

`make:view` refuses on the same signals, because a page has no JSON dialect to
adapt to — and the stray component would not stay harmless. The api starter's
tsconfig skips `resources/`, but its own `dev` script runs `guren codegen`,
which folds every page under `resources/js/pages` into `.guren/pages.gen.ts` —
a file that tsconfig does include, importing the `@guren/inertia-client` the
app never installs. One `make:view` flipped `typecheck` and `build` red two
commands later, far from the command that caused it.

The judgment stays positive-evidence only: whenever the signals cannot confirm
an API-only app — no manifest to read, a hoisted workspace dependency, a web
routes entry present — both commands behave exactly as before, and
installing `@guren/inertia-client` switches an app back to the Inertia
templates. Both commands judge the root the file is written into (resolved
once and reused for the write), not the process directory, so `cwd`-passing
callers such as the MCP server get the same answer the write acts on.
