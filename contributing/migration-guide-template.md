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

1. Update dependencies:
   ```bash
   bunx guren upgrade --canary
   ```
2. Run doctor to check for issues:
   ```bash
   bunx guren doctor
   ```
3. Run codemods (if any):
   ```bash
   bunx guren upgrade --canary --check-only
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
