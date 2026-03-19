# /pr-check - Pre-PR Validation

Run all checks required before opening a pull request.

## Instructions

Run the following checks in order. Stop and report if any step fails:

1. **Build** - Compile all packages
2. **Type Check** - Verify no type errors
3. **Test** - Run full test suite

## Commands

```bash
bun run build && bun run typecheck && bun run test
```

## Success

If all checks pass, confirm:
- All packages built successfully
- No type errors found
- All tests passing

## On Failure

If any check fails:
1. Stop at the failing step
2. Report which check failed (build/typecheck/test)
3. Show the specific error
4. Do not continue to next checks
