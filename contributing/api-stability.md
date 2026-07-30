# API Stability

This document defines the stability tiers for Guren's public surface and explains how to determine the stability level of any given API.

## Stability Tiers

### Stable

Stable APIs follow strict SemVer. They will not change in backwards-incompatible ways without a major version bump and a full deprecation cycle (see [Deprecation Policy](./deprecation-policy.md)).

Stable APIs include all exports from the `@guren/core` package index:

**From `@guren/server` (re-exported via `@guren/core`):**
- `Controller`, `Router`, `Route`
- `createApp`, `Application`
- Middleware factories: `defineMiddleware`, `requireAuthenticated`, `createCsrfMiddleware`
- Auth helpers: session management, password hashing
- Validation: `validateRequest`, `validateRequestWith`, `getValidatedData`
- Inertia integration: `inertia()` renderer
- Exception handling: `ExceptionHandler`, built-in exception classes
- Service providers, container, and lifecycle hooks

**From `@guren/orm` (re-exported via `@guren/core`):**
- `Model`, `defineModel`
- `DrizzleAdapter`, `createPostgresDatabase`, `createSqliteDatabase`, `createMySqlDatabase`, `createAwsDataApiDatabase`
- `runSeeders`, `defineSeeder`, `loadSeeders`
- All exported types: `InferModelRecord`, `InferModelInsert`, `PlainObject`, `WhereClause`, `FindManyOptions`, `PaginateOptions`, `PaginatedResult`, etc.

### Experimental

Experimental APIs may change in minor versions. Changes will be accompanied by deprecation warnings when feasible. These APIs are identified by:

- A `@experimental` JSDoc tag on the export
- Residence in a package or subpath explicitly labeled experimental (e.g., `@guren/openapi`)

Current experimental packages/features:
- `@guren/openapi` -- OpenAPI document generation
- Codegen artifacts (`.guren/*.gen.ts`) -- output format may change
- AI agent CLI commands (`guren context`, `guren check`, `guren guidelines`)

### Internal

Internal APIs carry no stability guarantee. They may change or disappear in any release, including patches. Internal APIs are identified by:

- Not being exported from any package's `src/index.ts`
- Being accessible only via deep imports (e.g., `@guren/server/internal`, `@guren/orm/src/utils`)
- Residing in files prefixed with `_` or directories named `internal`

Current internal subpaths:
- `@guren/core/internal/deploy-build` -- build-time helpers the official deploy plugins share (manifest and path resolution, the output-directory guard, and the list of dev-only modules a deployed bundle must stub). Exists to keep one copy of knowledge about the framework's own module graph, not as an extension point.

## How to Determine Stability

Use this decision tree:

1. **Is the API re-exported from `@guren/core`?** Yes --> Stable.
2. **Does the export or its package have an `@experimental` tag?** Yes --> Experimental.
3. **Is the API exported from a package's `src/index.ts` but not from `@guren/core`?** --> Check the package README. If no stability annotation exists, treat as Experimental.
4. **Is the API only reachable via deep imports?** --> Internal. No guarantees.

## Stability Promotion Process

An API moves from Experimental to Stable when:

1. It has existed for at least 2 minor releases with no signature or behavioral changes.
2. It has sufficient test coverage and documentation.
3. A maintainer explicitly promotes it by re-exporting it from `@guren/core` and removing the `@experimental` tag.
4. The promotion is noted in the CHANGELOG.

## Stability Demotion

In rare cases a Stable API may be demoted to Deprecated. This follows the full deprecation cycle described in [Deprecation Policy](./deprecation-policy.md) and requires a major version bump for removal.
