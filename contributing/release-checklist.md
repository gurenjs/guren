# Release Checklist

## Pre-Release

- [ ] All CI checks pass on the release branch
- [ ] `bun run build` succeeds
- [ ] `bun run typecheck` succeeds
- [ ] `bun run test` succeeds (all packages + examples)
- [ ] All audit scripts pass (`audit:core-first`, `audit:contracts`, `audit:feature-runtime`, `audit:starter-template`, `audit:docs`, `audit:bundle-budgets`)
- [ ] Smoke tests pass (`smoke:starter`, `smoke:starter:packed`, `smoke:upgrade-existing-app`, `smoke:golden-path`)
- [ ] Per-driver golden paths pass (`smoke:golden-path:postgres`, `smoke:golden-path:mysql`)
- [ ] E2E tests pass
- [ ] Nightly canary has been green for 3+ days

The release workflow has no MySQL service, so `smoke:golden-path:mysql` runs
only on the PR's CI and here. Start the databases first: `bun run db:up` and
`bun run db:up:mysql`.

## Version Bump

- [ ] Update version numbers in all `packages/*/package.json`
- [ ] Update `CHANGELOG.md` with release notes
- [ ] Create migration guide from template (if breaking changes)
- [ ] Run `bunx guren doctor` on a fresh scaffolded app with new version

## Documentation

- [ ] Update docs if APIs changed
- [ ] Update `docs/en/guides/upgrading.md` with version-specific notes
- [ ] Verify `bunx guren guidelines` output is current
- [ ] Run `bun run audit:docs` to verify doc consistency

## Deprecations

- [ ] All deprecated APIs have console warnings
- [ ] Deprecation entries added to `packages/cli/src/deprecations.ts`
- [ ] Migration guide documents all deprecations
- [ ] Codemods added to `packages/cli/src/codemods.ts` (if applicable)

## Release

- [ ] Create a git tag following semver
- [ ] Create GitHub release with changelog excerpt
- [ ] Verify npm publish succeeds for all packages
- [ ] If `@guren/cli` moved: `bun run publish:agent-catalog` (renders the agent catalog, audits it, and pushes it to `gurenjs/agent-skills` over your own git credentials — no token; a no-op when the published version already matches). The nightly `Published Package Drift` workflow turns red if this is forgotten.
- [ ] Verify `bunx create-guren-app` works with the new version
- [ ] Run `bunx guren upgrade --canary` on an older app to verify upgrade path

## Post-Release

- [ ] Announce on GitHub Discussions
- [ ] Update any open issues resolved by this release
- [ ] Monitor nightly canary for 48 hours after release
- [ ] Archive completed migration guide in `docs/`
