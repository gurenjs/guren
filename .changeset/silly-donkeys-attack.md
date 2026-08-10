---
'@guren/cli': patch
'create-guren-app': patch
---

Wire scaffolded route files into the registrar the framework actually calls

`guren add admin`, `guren add oauth`, `guren add resource`, and `guren add auth`
located the app's route registrar with a regex that only matched `export
function register*Routes(router: Router)`. An app scaffolded from the blog
blueprint names that parameter `baseRouter`, so the routes file was written but
never imported or called — and because the wiring ran inside a `try {} catch {}`,
nothing was reported.

The registrar is now found by parsing `routes/web.ts` and selecting the export
the route loader itself resolves, so any parameter name, a multi-line signature,
an arrow-function or default-export registrar, and a `Router` imported under an
alias all wire correctly, while an unrelated exported helper that merely takes a
router does not. The generated call passes the registrar's own parameter, which
is the only name guaranteed to be in scope. The call and its import land in one
write, so a routes file that cannot be patched is left untouched instead of
gaining an import for routes nothing registers — and that outcome is now
reported rather than swallowed.
