---
'@guren/cli': patch
---

Stop codegen writing a pages manifest into an app that cannot compile one

`.guren/pages.gen.ts` imports `@guren/inertia-client`. An app scaffolded from the
`api` blueprint does not install that package, and its `tsconfig.json` includes
`.guren/**` (but not `resources/`), so a manifest generated there fails `tsc` on
its first line. Nothing prevented one: `generatePageTypes` wrote a manifest
whenever `resources/js/pages` contained a component, and that directory can fill
up without anyone asking for it — a hand-copied page, a checkout, a generator
written later — while the api starter's `dev` script runs codegen on every start.

`guren check` already claimed this could not happen ("codegen never emits it in an
API-only app"), and `guren doctor` leaned on the same claim silently. Neither
enforced it. Codegen now owns the rule: `planPageManifest` answers "does this app
get a pages manifest?" from the page components *and* `isConfirmedApiOnlyApp`, and
check and doctor read that answer rather than restating it.

Withholding the file inverts the risk that predicate was written for — where a
wrong answer used to block a command loudly, it would now quietly deny a file
every controller imports — so the suppressed state is reported rather than
silent. `guren codegen` warns instead of printing a generated path, the MCP
codegen tool reports the reason rather than "nothing to generate", and check and
doctor both surface it, most sharply when a manifest generated before the app took
this shape is still on disk: that leftover is what fails the typecheck, and both
tools used to call it healthy on the strength of it merely existing. It outlives
the page components that produced it, so it is reported even once they are
deleted. Codegen does not delete it — if the rule is ever wrong about an app,
removing the manifest turns a type error into a mystery — so the report names the
file and both corrections: delete it, or declare the `@guren/inertia-client`
dependency and `routes/web.ts` that make this a fullstack app.

Severity follows the same rule: the leftover manifest really does fail `tsc`, so
`guren check --ci` gates on it, while page components an API-only app simply never
renders are advisory — failing a build over unused files would be its own bug.

`make:view`'s refusal stands, but its reason changes with this: a page component
in such an app is no longer a delayed `typecheck` failure, it is a screen nothing
can reach, and the refusal is about saying so at the command that caused it. Its
doc comment and the CLI guide now say that instead of restating a chain codegen
no longer lets happen.
