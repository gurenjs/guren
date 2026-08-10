---
'@guren/cli': patch
---

Refuse `add resource`, `make:feature`, `add auth`, and `make:auth` on an API-only app

`add admin` already refused to scaffold an Inertia dashboard into an app created
from the `api` blueprint. It was the only command that did. Four others reach the
same page-emitting code and wrote it anyway, exiting 0 with no error to notice:

- `make:feature <Name>` writes four React page components under
  `resources/js/pages/<collection>/` plus a controller importing
  `@/.guren/pages.gen` and returning Inertia responses.
- `add resource <Name>` is that same scaffold with the schema and routes patched
  in for you, so it never had a guard of its own either.
- `make:auth` — and `add auth`, which delegates to it — writes eight `.tsx` pages
  and six controllers rendering them, `@inertiajs/react` throughout.

None of it typechecks against a `@guren/inertia-client` the API starter never
installs, and the routes they tell you to register target a `routes/web.ts` that
starter does not have.

The guard now lives in `makeFeature` and `makeAuth` themselves rather than beside
each command, so the four paths above are covered by two checks; `add admin`
keeps its own, being the one that writes its files inline. Each refusal names the
command you actually typed, what it would have written, and the two signals it
read, and happens before the first write — a half-scaffolded Inertia slice is
harder to clean up than none.

Detection is unchanged and still requires positive evidence of the API-only
shape: a readable `package.json` that does not declare `@guren/inertia-client`,
**and** no `routes/web.ts` or `routes/web.js`. Every "cannot tell" permits the
scaffold, because for a refusal the expensive mistake is blocking a command that
would have worked. `make:feature --module <name>` runs through the same check —
its pages land under the top-level `resources/js/pages/` regardless of the
module, so the app-level answer is the right one.

The single-file generators are deliberately left out: `make:controller` emits an
Inertia controller and `make:view` a page component, but one stray file is a
deletion, not the multi-file mess the guard exists to prevent.

`make:feature` reads the project it is scaffolding into rather than the process
directory, which matters for the MCP server: it names the workspace it writes to
instead of steering the process into it.
