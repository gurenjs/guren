# Release & Compatibility Policy

This document defines the minimum release contract for production use.

## Versioning (SemVer)

Guren uses Semantic Versioning for stable releases:

- **MAJOR**: incompatible API or behavioral changes
- **MINOR**: backward-compatible features
- **PATCH**: backward-compatible bug fixes and security updates

For `0.x`, breaking changes may occur between minors. Every breaking change must be documented in migration notes.

## Runtime Compatibility Matrix

| Runtime | Supported | Notes |
| --- | --- | --- |
| Bun `1.3.x` | Yes (primary) | CI and release workflows run on Bun `1.3.1` |
| Node.js `20.x` | Tooling compatibility only | For docs/build tooling where applicable |
| Node.js `22.x` | Tooling compatibility only | For docs/build tooling where applicable |

If the matrix changes, update this guide and `CHANGELOG.md` in the same PR.

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
