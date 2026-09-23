# Release & Compatibility Policy

This document defines the minimum release contract for production use.

## Versioning (SemVer)

Guren uses Semantic Versioning for stable releases:

- **MAJOR**: incompatible API or behavioral changes
- **MINOR**: backward-compatible features
- **PATCH**: backward-compatible bug fixes and security updates

From `1.0`, breaking changes ship only in major releases; minors and patches are backward compatible. Every breaking change must be documented in migration notes.

## Runtime Compatibility Matrix

| Runtime | Supported | Notes |
| --- | --- | --- |
| Bun `1.4.2` | Primary | Development, tests, CLI and self-hosted production; pinned in CI and release workflows |
| Bun `1.3.14` | Previous | Non-blocking CI lane; not the release baseline |
| Node.js | Deployment adapters | AWS Lambda and Vercel builds use their adapter's supported runtime; development and CLI still require Bun |
| Cloudflare Workers | Deployment adapter | Requires the Cloudflare plugin and its generated compatibility settings |

If the matrix changes, update this guide and the [Support Matrix](./support-matrix.md) in the same PR, and add a changeset that states the change so it reaches the release notes.

## Backward Compatibility Rules

- Public exports in `@guren/*` are considered API surface.
- Removing or changing public types/behavior requires:
  - a migration section in the release notes
  - a deprecation path when feasible
  - tests covering old/new behavior boundaries

## Release Cadence & Notes

- Every release must include changelog/release notes.
- Notes must include at least:
  - Added / Changed / Fixed
  - Breaking changes (if any)
  - Migration steps
  - Runtime compatibility changes

## Upgrade Documentation Requirement

Each minor release must have an upgrade entry in `docs/en/guides/upgrading.md` and `docs/ja/guides/upgrading.md`.
