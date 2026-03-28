# Breaking Change Checklist

Use this checklist before merging any PR that introduces a breaking change. Every item must be addressed -- mark items N/A with a brief reason if they do not apply.

## Evaluate

- [ ] **Is this change truly necessary?** Document why a backwards-compatible alternative is not feasible.
- [ ] **Scope assessment.** List every public API affected and the packages involved.

## Deprecate the Old API

- [ ] Add `@deprecated` JSDoc tag to the old API with replacement guidance.
- [ ] Add a runtime `console.warn` on first use (once per process).
- [ ] Register the deprecation in `packages/cli/src/deprecations.ts` with a working `detect()` function.
- [ ] Verify `bunx guren upgrade --check-only` detects usage in `examples/blog`.

## Provide Migration Path

- [ ] Create or update a codemod in `packages/cli/src/codemods.ts` (if the pattern is automatable).
- [ ] Test the codemod against `examples/blog` and at least one additional real-world pattern.
- [ ] Write a migration guide entry using the template in `contributing/migration-guide-template.md` with before/after code examples.

## Update Documentation and Examples

- [ ] Update all docs to use the new API. Remove or annotate old examples.
- [ ] Update `examples/blog` to use the new API.
- [ ] Update `CLAUDE.md` if the change affects architecture patterns or key files.

## Changelog and Commit

- [ ] Add entry to CHANGELOG under `### Changed` or `### Removed` with `BREAKING CHANGE:` note.
- [ ] Commit message includes `BREAKING CHANGE:` footer per Conventional Commits spec.

## Verify

- [ ] `bun run build` passes.
- [ ] `bun run typecheck` passes.
- [ ] `bun run test` passes (full suite, not just changed packages).
- [ ] `bunx guren check` reports no new inconsistencies.
- [ ] `bunx guren upgrade --check-only` correctly detects the deprecated API in test fixtures.

## Release Timing

- [ ] The old API has been deprecated for at least **2 minor versions** (stable) or **1 minor version** (experimental) before this removal PR is merged.
- [ ] If this is a pre-1.0 release, confirm the deprecation period was respected even though minor versions may contain breaking changes.
