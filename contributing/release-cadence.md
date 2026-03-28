# Release Cadence

This document describes the release schedule and process for Guren.

## Release Types

### Patch Releases (x.y.Z)

- Released as needed for bug fixes and security patches
- No fixed schedule; published when fixes are ready
- Backward compatible; no new features
- Example: `0.2.1`, `0.2.2`

### Minor Releases (x.Y.0)

- Targeted every 4-6 weeks during active development
- May include new features, deprecations, and non-breaking enhancements
- Backward compatible within the same major version
- Example: `0.3.0`, `0.4.0`

### Major Releases (X.0.0)

- Released when 1.0 stability criteria are met (see [api-stability.md](./api-stability.md))
- May include breaking changes documented in the migration guide
- Accompanied by a migration guide and changelog
- Example: `1.0.0`, `2.0.0`

## Pre-release Tags

Pre-release versions use the following tags in order of stability:

| Tag | Purpose | Example |
|-----|---------|---------|
| `alpha` | Early testing, APIs may change significantly | `1.0.0-alpha.1` |
| `beta` | Feature complete, APIs stabilizing | `1.0.0-beta.1` |
| `rc` | Release candidate, final testing before stable | `1.0.0-rc.1` |

Install a pre-release version with:

```bash
bun add @guren/core@next
```

## Canary Releases

Nightly builds are published from the `main` branch for bleeding-edge testing:

- Published automatically when CI passes on `main`
- Tagged as `canary` on npm (e.g., `0.3.0-canary.20260328`)
- Not recommended for production use
- Useful for verifying that a merged fix works before the next release

Install the canary version with:

```bash
bun add @guren/core@canary
```

## Release Freeze

A release freeze begins one week before each minor or major release:

- Only bug fixes and documentation changes are merged during the freeze
- New features are held until after the release
- The freeze ensures stability and gives time for final testing

## Hotfix Process

Critical issues bypass the regular cadence:

- **Security vulnerabilities**: Patch released within 48 hours of a confirmed fix
- **Data loss bugs**: Patch released within 48 hours
- **Complete breakage** (e.g., package fails to import): Patch released within 24 hours

Hotfixes are cherry-picked from `main` onto the latest release branch and published immediately.

## Release Checklist

See [release-checklist.md](./release-checklist.md) for the step-by-step process used when cutting a release.
