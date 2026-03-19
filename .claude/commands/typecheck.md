# /typecheck - Type Check

Run TypeScript type checking across the monorepo without emitting files.

## Instructions

1. Run type checking
2. Report any type errors with file locations
3. Confirm success when complete

## Command

```bash
bun run typecheck
```

This runs:
- Root monorepo type check
- Blog example type check

## On Failure

If type errors are found:
1. List each error with file path and line number
2. Show the error message
3. Suggest fixes for common issues like:
   - Missing type annotations
   - Incorrect imports
   - Type mismatches
