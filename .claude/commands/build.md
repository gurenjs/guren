# /build - Build All Packages

Build all packages in the Guren monorepo in the correct dependency order.

## Instructions

1. Run the build command
2. Report any compilation errors
3. Confirm success when complete

## Command

```bash
bun run build
```

This builds packages in order:
1. testing
2. orm
3. server
4. cli
5. core
6. create-app
7. inertia-client

## On Failure

If build fails:
1. Identify which package failed
2. Show the TypeScript or build error
3. The error is usually in the package that failed, check its `src/` directory
