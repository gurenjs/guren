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

The renderer now skips remediation for passing checks, and prints `Manual:` only
when it says something `Fix:` does not — the duplicate goes, the addition stays.
A few rules genuinely differ there: the tsconfig parse error needs the file
repaired *and* `.guren/**/*` added, and a missing Bun cannot be fixed by
`bun upgrade`, only by the install URL `manualFix` carries. The `Autofix` line
now says which command applies it, phrased as information rather than an
instruction: `guren upgrade` also realigns every `@guren/*` dependency, which is
more than someone chasing a single check asked for, and `guren doctor` has no
`--fix` of its own.

The fix is in `createCheck` rather than the report: a passing check now carries
no remediation at all, whatever the caller passed. `guren doctor --json` had the
same defect — on a healthy app it reported `fix: "Run guren codegen --force…"`
for nine manifests that were present — and enforcing the invariant once covers
the report, the JSON, and anything added later. The field stays present and
nullable and `version: 1` is unchanged, so the JSON shape is the same; only
wrong data disappears from it. `guren upgrade`'s autofix path and manual-step
collection already filtered by status, so they are unaffected.

Left as follow-up: `fix` and `manualFix` are not really two concepts. Three
consumers treat them three ways — the report prints both, `--json` emits both
raw, and `guren upgrade` reads `manualFix ?? fix`. The genuine case is narrow
("the suggested command cannot run"), and naming it that way would be clearer
than a second general field, but it touches the JSON surface.
`renderDoctorReport` had no test coverage; it now has cases for each branch.

Writing those tests surfaced why it had none: two test files replace the
`consola` module with a hand-listed stub, and `mock.module()` is not undone
between files in Bun's shared process, so every file loaded after them saw a
`consola` without `box` — which is the first call `renderDoctorReport` makes.
Both stubs now inherit from the real instance and shadow only the methods that
print, so the surface cannot drift out from under an unrelated test again.
