# Guren Release Workflow

Changesets manages versioning and changelog generation for the Guren monorepo.

## Quick Commands

- `bun run changeset` – create a new changeset describing your changes.
- `bun run version-packages` – apply pending changesets and bump versions (updates `package.json`, `bun.lock`, and changelog files).
- `bun run release` – build all packages and publish the releasable ones to npm.

## Workflow

1. **During development** add a changeset for every PR that affects published packages. Choose the bump type (patch/minor/major) per package when prompted.
2. **Before merging** run `bun run version-packages` on the main branch. Commit the generated changelog and version updates together with your PR.
3. **When releasing** execute `bun run release` from the main branch after tagging or merging the release PR. The script builds every workspace first to ensure published artifacts are up to date.

### Notes

- Example applications (e.g. `@guren/example-blog`) are ignored by Changesets.
- Private packages still receive version bumps but no git tags.
- All published packages share the `main` base branch and default changelog formatter.
- Publishing from GitHub releases is automated via `.github/workflows/release.yml`; set the `NPM_TOKEN` secret with publish rights before triggering a release.
