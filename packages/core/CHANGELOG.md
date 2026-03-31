# @guren/core

## 1.0.0-rc.12

### Patch Changes

- fix(server): use figlet importable-fonts for bundled builds
- Updated dependencies
  - @guren/server@1.0.0-rc.12
  - @guren/cli@1.0.0-rc.13

## 1.0.0-rc.11

### Patch Changes

- fix(ci): upgrade to Node 24 for npm OIDC trusted publishing
- Updated dependencies
  - @guren/server@1.0.0-rc.11
  - @guren/orm@1.0.0-rc.11
  - @guren/cli@1.0.0-rc.11

## 1.0.0-rc.10

### Patch Changes

- Align all packages to rc.10.
- Updated dependencies
  - @guren/server@1.0.0-rc.10
  - @guren/cli@1.0.0-rc.10

## 1.0.0-rc.9

### Patch Changes

- Align all packages to rc.9.
- Updated dependencies
  - @guren/server@1.0.0-rc.9
  - @guren/orm@1.0.0-rc.9
  - @guren/cli@1.0.0-rc.9

## 1.0.0-rc.8

### Major Changes

- v1.0 Release Candidate

  New subsystems: OAuth, MySQL adapter, typed broadcasting, OpenAPI generation,
  production error pages, request ID/logging middleware, plugin test harness,
  API-only and worker starter kits.

  DX: Golden path standardization, doctor autofixes, CLI consistency,
  upgrade productization, security defaults.

  Quality: Playwright E2E, CI matrix, nightly canary, benchmarks,
  smoke tests for all starter kits.

  Docs: Task-completion guides (en/ja), plugin authoring guide,
  deployment recipes (Docker, Fly.io, VPS, serverless).

  Governance: API stability tiers, deprecation policy, SemVer guidance,
  RFC process, release cadence, issue triage SLAs.

### Patch Changes

- Updated dependencies
  - @guren/server@1.0.0-rc.8
  - @guren/orm@1.0.0-rc.8
  - @guren/cli@1.0.0-rc.8

## 0.2.0-alpha.7

### Patch Changes

- Fix the project created with the `create-guren-app` command so it can start successfully.
- Updated dependencies
  - @guren/cli@0.2.0-alpha.7
  - @guren/orm@0.2.0-alpha.7
  - @guren/server@0.2.0-alpha.7

## 0.2.0-alpha.6

### Minor Changes

- Added SSR support, ORM relationships, pagination, and authentication enhancements.

### Patch Changes

- Updated dependencies
  - @guren/cli@0.2.0-alpha.6
  - @guren/orm@0.2.0-alpha.6
  - @guren/server@0.2.0-alpha.6

## 0.1.1-alpha.5

### Patch Changes

- Ensure dev asset server resolves and serves Inertia client chunks so the scaffold works in dev.
- Updated dependencies
  - @guren/cli@0.1.1-alpha.5
  - @guren/orm@0.1.1-alpha.5
  - @guren/server@0.1.1-alpha.5

## 0.1.1-alpha.4

### Patch Changes

- Fixed registerDevAssets to resolve the bundled Inertia client via @guren/inertia-client/app, rebuilt @guren/server, and confirmed the scaffolded app now loads without blank-screen 404s.
- Updated dependencies
  - @guren/cli@0.1.1-alpha.4
  - @guren/orm@0.1.1-alpha.4
  - @guren/server@0.1.1-alpha.4

## 0.1.1-alpha.3

### Patch Changes

- The release build runs build:create-app so the CLI binary is bundled.
- Updated dependencies
  - @guren/cli@0.1.1-alpha.3
  - @guren/orm@0.1.1-alpha.3
  - @guren/server@0.1.1-alpha.3

## 0.1.1-alpha.2

### Patch Changes

- Updated the scaffolded app template so new projects pull in the freshly published prerelease.
- Updated dependencies
  - @guren/cli@0.1.1-alpha.2
  - @guren/orm@0.1.1-alpha.2
  - @guren/server@0.1.1-alpha.2

## 0.1.1-alpha.1

### Patch Changes

- Pinned dependencies to specific versions for consistency across packages
- Updated dependencies
  - @guren/cli@0.1.1-alpha.1
  - @guren/orm@0.1.1-alpha.1
  - @guren/server@0.1.1-alpha.1

## 0.1.1-alpha.0

### Patch Changes

- 7f52ba4: Add open-source metadata, licensing, and community docs to prepare the packages for an initial public release.
- first release
- Updated dependencies [7f52ba4]
- Updated dependencies
  - @guren/server@0.1.1-alpha.0
  - @guren/orm@0.1.1-alpha.0
  - @guren/cli@0.1.1-alpha.0
