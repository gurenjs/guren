# Deprecation Policy

This document describes how Guren deprecates APIs and the guarantees users can rely on during the transition period.

## Deprecation Lifecycle

1. **Announce** -- The API receives a `@deprecated` JSDoc tag with a message naming the replacement.
2. **Warn at runtime** -- On first use, a `console.warn` is emitted with the deprecation ID, replacement guidance, and removal version. Warnings are emitted once per process to avoid log noise.
3. **Register** -- The deprecation is added to `packages/cli/src/deprecations.ts` so that `bunx guren upgrade --check-only` can detect usage in user projects automatically.
4. **Document** -- The deprecation is listed in the CHANGELOG under a `### Deprecated` section and in the relevant migration guide.
5. **Provide codemod** -- When the migration pattern is automatable, a codemod is added to `packages/cli/src/codemods.ts` and runs as part of `bunx guren upgrade` (preview with `--dry-run`).
6. **Remove** -- After the minimum deprecation period, the API is removed in a new major version (or minor version during pre-1.0).

## Minimum Deprecation Period

- **Stable APIs:** Deprecated for at least **2 minor versions** before removal.
- **Experimental APIs:** Deprecated for at least **1 minor version** before removal.
- **Pre-1.0 exception:** During 0.x development, stable API removals may happen in minor versions, but the 2-minor-version deprecation period still applies.

## Deprecation Registration

Every deprecation must be registered in `packages/cli/src/deprecations.ts` using the `Deprecation` interface:

```typescript
{
  id: 'static-route-class',
  what: 'Static Route class (Route.get(), Route.post())',
  since: '0.2.0',
  removedIn: '1.0.0',
  replacement: 'Use router instance methods: router.get(), router.post()',
  async detect(cwd) {
    // Return file paths containing the deprecated pattern
    return []
  },
}
```

Fields:
- `id` -- Unique kebab-case identifier, used in warning messages and CLI output.
- `what` -- Human-readable description of what is deprecated.
- `since` -- Version where the deprecation was introduced.
- `removedIn` -- Target version for removal.
- `replacement` -- What to use instead.
- `detect(cwd)` -- Function that scans the project at `cwd` and returns affected file paths.

## Runtime Warning Format

```
[guren] Deprecation (static-route-class): Static Route class is deprecated
  since 0.2.0, will be removed in 1.0.0.
  Use router instance methods: router.get(), router.post()
```

## Automated Detection

Users can check their projects for deprecated API usage at any time:

```bash
# Report deprecated API usage (no changes)
bunx guren upgrade --check-only

# Preview the codemods that would run, without writing
bunx guren upgrade --dry-run

# Apply codemods -- this also realigns @guren/* dependency ranges and applies
# doctor autofixes
bunx guren upgrade
```

`--check-only` returns before codemods are considered, so it reports deprecations
only. Use `--dry-run` to see which codemods would apply.

## Codemod Requirements

When adding a codemod to `packages/cli/src/codemods.ts`:

- The codemod must be idempotent (safe to run multiple times).
- It must produce valid TypeScript output.
- `detect()` must be side-effect-free, so `bunx guren upgrade --dry-run` can list the affected files without writing.
- It must be tested against the `examples/blog` reference app.

## CHANGELOG Format

Deprecations appear in the CHANGELOG under the version that introduces them:

```markdown
### Deprecated

- **`Route.get()` / `Route.post()` static methods** -- Use `router.get()` / `router.post()` instance methods instead. Will be removed in 1.0.0. Codemod available: run `bunx guren upgrade`. (#123)
```
