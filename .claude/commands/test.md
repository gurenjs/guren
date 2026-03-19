# /test - Run Tests

Run the full test suite for the Guren framework.

## Instructions

1. Run framework unit tests and example app tests
2. Report any failures with file paths and error messages
3. If tests pass, confirm success

## Command

```bash
bun run test
```

This runs:
- `bun run test:bun` - Framework tests (packages/server, packages/orm)
- `bun run test:examples` - Example blog app tests

## On Failure

If tests fail:
1. Identify the failing test file and test name
2. Show the relevant error message
3. Suggest potential fixes based on the error
