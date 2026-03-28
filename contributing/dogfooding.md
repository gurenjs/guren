# Dogfooding Process

Guren uses its own reference applications to validate every release before it ships. This document describes the dogfooding workflow, expectations, and how contributors can participate.

## Reference Applications

| App | Path | Purpose |
|-----|------|---------|
| Blog | `examples/blog` | Full-stack Inertia.js application with auth, CRUD, relationships |
| API | `examples/api` | API-only application with JSON resources, validation, middleware |

Both apps exercise the core framework surface area: routing, controllers, models, middleware, authentication, validation, database migrations, and code generation.

## Pre-Release Verification

Before every tagged release, the maintainers run the following checks against each reference app.

### 1. Upgrade to canary

```bash
cd examples/blog
bunx guren upgrade --canary
```

This installs the latest unpublished packages from the monorepo workspace, simulating what a real user would receive on the next publish.

### 2. Build

```bash
bun install
bun run codegen
bun run build
```

The build must complete without errors or warnings.

### 3. Type check

```bash
bun run typecheck
```

All generated types (`.guren/pages.gen.ts`, `.guren/routes.gen.ts`, etc.) must pass strict type checking.

### 4. Run tests

```bash
bun run test
```

Every existing test must pass. If a test fails due to a framework change, the framework change must include a corresponding test update.

### 5. Run the integrity check

```bash
bunx guren check
bunx guren doctor --next
```

The `check` command validates route-controller-page consistency. The `doctor` command surfaces any actionable issues.

### 6. Deploy

Deploy each reference app to verify the production build path:

```bash
# Docker
docker build -f deploy/docker/Dockerfile -t guren-blog-test .
docker run --rm -p 3333:3333 guren-blog-test

# Smoke test
curl -f http://localhost:3333/health
```

### 7. Manual smoke test

Visit the running application and verify:

- Pages render without errors
- Forms submit and validate correctly
- Authentication flow works end-to-end
- Database operations succeed

## Issue Tracking

Issues discovered during dogfooding receive:

- **Label**: `dogfooding`
- **Priority**: P1 (blocks release)
- **Assignee**: The maintainer who discovered the issue

Dogfooding issues are resolved before the release proceeds. If a fix requires a breaking change, it is documented in the migration guide.

## Quarterly Review

Every quarter, maintainers perform a full review of all reference applications:

1. **Build and test** -- Confirm both apps still build, pass type checking, and pass all tests on the latest framework commit.
2. **Dependency audit** -- Update third-party dependencies and verify compatibility.
3. **Feature coverage** -- Compare the framework's public API surface against what the reference apps exercise. Add coverage for any gaps.
4. **Deployment verification** -- Deploy each app using at least two deployment recipes (Docker + one platform) and verify the health check passes.
5. **Documentation sync** -- Ensure the deployment recipes and reference app READMEs reflect current behavior.

Results are summarized in a GitHub Discussion under the "Dogfooding" category.

## Community Dogfooding

Contributors and early adopters are encouraged to test pre-release versions in their own projects.

### How to participate

1. Install the canary version: `bunx guren upgrade --canary`
2. Run your application and exercise its main workflows
3. Report issues via [GitHub Discussions](https://github.com/nicely-guren/guren/discussions) with the tag `dogfooding`
4. Include the output of `bunx guren doctor --next` in your report

### What to look for

- Breaking changes that lack migration guidance
- Type errors after upgrading
- Performance regressions
- Missing or incorrect code generation output
- Deployment failures with the provided recipes

Community reports receive the same `dogfooding` label and P1 priority as internal findings.
