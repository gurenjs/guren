# SemVer Guidance

Guren follows [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html). This document provides operational guidance for maintainers on when and how to bump versions.

## Version Increment Rules

### Patch (`x.y.Z`)

Increment the patch version for:

- Bug fixes that do not change public API behavior
- Documentation corrections shipped alongside code
- Internal refactors with no observable behavior change
- Dependency updates that do not affect the public API

**Not allowed:** New APIs, new configuration options, behavioral changes (even "improvements"), deprecation additions.

### Minor (`x.Y.0`)

Increment the minor version for:

- New features and new public APIs
- New configuration options with sensible defaults
- Adding deprecation warnings to existing APIs
- Changes to Experimental APIs (with deprecation warnings when feasible)
- Performance improvements that change observable timing characteristics

**Not allowed:** Removal of Stable APIs, changes to Stable API signatures or return types.

### Major (`X.0.0`)

Increment the major version for:

- Removal of deprecated Stable APIs
- Changes to Stable API signatures, return types, or default behavior
- Minimum runtime version bumps (e.g., requiring a newer Bun version)
- Any change that requires users to modify existing working code

**Required:** Migration guide, updated examples, all deprecated APIs removed in batch.

## Pre-1.0 Exception

During `0.x` development:

- **Minor versions (`0.Y.0`)** may contain breaking changes to Stable APIs, but only after the deprecation period defined in [Deprecation Policy](./deprecation-policy.md) (2 minor versions minimum).
- **Patch versions (`0.x.Z`)** follow the same rules as post-1.0 patches -- bug fixes only.
- This exception is documented in `SECURITY.md` and communicated in release notes.

Users on `0.x` should pin to exact minor versions (`~0.2.0`) and review CHANGELOG before upgrading.

## The 1.0 Release

The 1.0 release signals:

1. All Stable APIs (as defined in [API Stability](./api-stability.md)) are locked. No breaking changes without a major bump.
2. All previously deprecated APIs from 0.x are removed.
3. A comprehensive migration guide from 0.x to 1.0 is published.
4. The Experimental tier still exists -- experimental features may still change in minor versions.

## Version Bumping Process

### Who Decides

- **Patch:** Any maintainer can release after PR review.
- **Minor:** Requires agreement from at least 2 maintainers.
- **Major:** Requires full team discussion and a published migration guide before release.

### Release Steps

1. Ensure all items in `contributing/release-checklist.md` are complete.
2. Update `CHANGELOG.md` -- move `[Unreleased]` entries to the new version heading.
3. Bump version numbers across all packages (monorepo-wide).
4. Tag the release: `git tag v{version}`.
5. Publish to npm.
6. Post release notes linking the CHANGELOG and migration guide (if applicable).

### Communication

- **Patch releases:** CHANGELOG entry is sufficient.
- **Minor releases:** CHANGELOG entry + brief summary in GitHub release notes highlighting new features and deprecations.
- **Major releases:** CHANGELOG + dedicated migration guide + announcement in project communication channels.

## Quick Reference

| Change type | Patch | Minor | Major |
|---|---|---|---|
| Bug fix | Yes | -- | -- |
| New feature / API | -- | Yes | -- |
| Add deprecation warning | -- | Yes | -- |
| Experimental API change | -- | Yes | -- |
| Remove deprecated Stable API | -- | Pre-1.0 only | Yes |
| Change Stable API behavior | -- | -- | Yes |
| Bump minimum runtime version | -- | -- | Yes |
