# Migration Guide: v{FROM} → v{TO}

## Overview

Brief summary of the release and key changes.

## Breaking Changes

### {Change Title}

**What changed:** Description of the breaking change.

**Before (v{FROM}):**
```typescript
// Old pattern
```

**After (v{TO}):**
```typescript
// New pattern
```

**Migration steps:**
1. Step-by-step instructions
2. ...

**Codemod available:** Yes/No (`guren upgrade --canary` handles this automatically)

## Deprecations

| Deprecated API | Replacement | Removed in |
|---------------|-------------|------------|
| `Example.old()` | `Example.new()` | v{NEXT} |

## New Features

Brief list of new features (link to docs for details).

## Upgrade Steps

1. Preview the upgrade -- dependency changes and any applicable codemods, without writing:
   ```bash
   bunx guren upgrade --canary --dry-run
   ```
2. Apply it -- this updates the `@guren/*` dependency ranges and runs the codemods:
   ```bash
   bunx guren upgrade --canary
   ```
3. Run doctor to check for remaining issues:
   ```bash
   bunx guren doctor
   ```
4. Verify:
   ```bash
   bun run codegen && bun run typecheck && bun run build && bun run test
   ```

## Known Issues

List any known issues or workarounds for this version.

## Need Help?

- [GitHub Discussions](https://github.com/user/guren/discussions)
- [Issue Tracker](https://github.com/user/guren/issues)
