---
"@guren/cli": patch
---

fix: `guren doctor` stops printing repair instructions for checks that passed

Five rules build a single check with a ternary status and hand the same options
bag to both branches, so a passing check still carried the `fix` and `manualFix`
text describing how to repair it. The report printed that text regardless of
status, and because `fix` and `manualFix` restate each other, each passing check
produced two extra lines — identical ones for the generated-manifest and
path-alias rules:

```
✔ [ok] .guren/routes.gen.ts: Generated manifest present at .guren/routes.gen.ts.
ℹ        Fix: Run guren codegen --force to regenerate .guren/routes.gen.ts.
ℹ        Manual: Run guren codegen --force to regenerate .guren/routes.gen.ts.
```

On a healthy app that turned a clean report into a wall of instructions for
problems it does not have.

The renderer now skips remediation for passing checks and prints one line for
the rest, using `manualFix` only when a rule sets it alone. The `Autofix`
line names the command that applies it — `guren doctor` has no `--fix` flag, so
"available" on its own left nowhere to go.

Rule definitions and the `--json` output are unchanged, so `guren upgrade`'s
autofix path and its manual-step collection still see the same fields.
`renderDoctorReport` had no test coverage; it now has cases for each branch.

Writing those tests surfaced why it had none: two test files replace the
`consola` module with a hand-listed stub, and `mock.module()` is not undone
between files in Bun's shared process, so every file loaded after them saw a
`consola` without `box` — which is the first call `renderDoctorReport` makes.
Both stubs now inherit from the real instance and shadow only the methods that
print, so the surface cannot drift out from under an unrelated test again.
