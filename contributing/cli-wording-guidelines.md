# CLI Wording Guidelines

## Success Messages
- Resource creation: `consola.success('{Type} created at {path}')`
- Database operations: `consola.success('{Action} completed successfully.')`
- Dry-run: `consola.info('[dry-run] Would {action}. No changes were made.')`

## Error Messages
- Missing file: `consola.error('{Type} not found: {path}')`
- Validation failure: `consola.error('Validation failed: {reason}')`

## Flag Conventions
- `--force`: "Skip confirmation prompt in production" (required for destructive ops)
- `--json`: Output structured JSON to stdout (use `console.log`, not `consola`)
- `--dry-run` (`-d`): Preview changes without executing

## Output Library
- `consola.success()` — operation completed
- `consola.error()` — fatal error
- `consola.warn()` — caution/production warning
- `consola.info()` — informational/dry-run
- `console.log()` — ONLY for `--json` structured output
