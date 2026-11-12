---
name: release
description: Cut a release of the Guren packages to npm, from pending changesets to the published-package check. Use when the user says "release", "prepare a release", "cut a release", "version PR", "version packages", "publish to npm", "リリース", "リリースの準備", "リリース進めて", asks what the next version or tag will be, or asks why a release run failed. Also use to finish a release someone else started (merge the version PR, check the publish, publish the agent catalog).
---

# Release

A release is five things in order: a version PR that consumes the changesets,
a GitHub Release on the merged commit, the `Release Publish` workflow that the
Release triggers, the agent catalog, and a check of what npm now serves.

Read `references/troubleshooting.md` once before you start. It is short, it
holds the wait loops and shell traps the steps below rely on, and when
something goes red the cause is usually already in it.

## Who does what

Two steps publish to the public and cannot be undone: creating the GitHub
Release (it starts the npm publish, which finishes within about ten minutes)
and `publish:agent-catalog` (it pushes to `gurenjs/agent-skills`). Prepare both
and hand the exact command to the user unless they tell you to run it. Merging
the version PR also waits for the user to say so. Everything else is yours.

## How the pieces fit

- `bun run version-packages` runs the release gates, then `changeset version`,
  then syncs the template dependency ranges and import floors, then
  `bun install`. It can stop partway; its message says why.
- `.github/workflows/release.yml` runs on `release: published`. Its `validate`
  job builds, typechecks, tests and runs the smokes; its `publish` job runs
  `changeset publish` with npm trusted publishing. Never run `bun run release`
  locally.
- The tag is `v<@guren/server version>` when the server moved and that tag is
  free. Otherwise it is the newest `v*` tag with its patch number raised by
  one: after `v2.37.0`, a release that leaves the server at 2.37.0 is
  `v2.37.1`. Say so in the PR body and the notes. The tag name does not affect
  what npm receives.
- `@guren/core` versions on its own line. A server minor does not bump core:
  core's range already admits it.
- Code ships from the tagged commit. A changeset decides only the version
  number and the changelog line, so a PR merged after the version PR was cut
  ships in this release while its changeset waits for the next one.

`contributing/release-checklist.md` is the policy. The version PR's CI covers
its build, typecheck, test, audit, smoke and E2E items, the MySQL golden path
included, and `validate` repeats most of them at publish time, so you do not
run those by hand. Its documentation and deprecation items belong to the PRs
that made the changes; check them only when a changelog section announces a
breaking change or a deprecation. Announcing the release and watching the
canary afterwards are the user's.

## 1. Look before starting

```bash
git fetch origin main --tags
git ls-tree --name-only origin/main .changeset/     # what this release consumes
gh pr list --state open --json number,title,mergeable
gh run list --workflow nightly-canary.yml --branch main --limit 3
git tag -l 'v*' --sort=-v:refname | head -3
```

Count the changesets yourself; a number someone gave you earlier may be stale.
A red nightly canary on `main` is a reason to stop and fix that first, since
the canary runs tests PR CI skips.

If an open PR carries a changeset and looks ready to merge, ask the user
whether it goes in before you continue. Adding one after the version PR exists
means rebuilding it.

## 2. Version in a worktree of your own

The main checkout may be on another branch or in use by another session, so
work from a fresh worktree cut from `origin/main`:

```bash
git worktree add --no-track -b chore/version-packages-next <scratch dir>/release origin/main
cd <scratch dir>/release
bun install
bun run build
bun run version-packages
```

`bun install` and `bun run build` come first because the gates import built
packages. Once the bump has run you know the tag (see the rule above; confirm
it is free with `git tag -l 'vX.Y*'`), so rename the branch:
`git branch -m chore/version-packages-vX.Y.Z`.

Then read what changed with `git status --short`:

- Every changeset is gone. Each moved package has a new `CHANGELOG.md` section.
  The private workspaces (`examples/*`, `web`) move with their dependencies,
  and the template `package.json` files and `bun.lock` change too. All of that
  is expected.
- The gate output ends a line with `(N workspace package(s) not on npm)`. If N
  is not 0, a package is being published for the first time, which trusted
  publishing refuses. Read that entry in troubleshooting before going further.
- If `@guren/server` or `create-guren-app` changed its major or minor, update
  the "verified against" line in `docs/en/tutorials/00-overview.md` and
  `docs/ja/tutorials/00-overview.md`.

`bun run audit:docs` checks that line. The sync steps inside
`version-packages` already hold the template ranges, import floors and plugin
compatibility; `bun run audit:starter-template` is worth one more run because
it reads the template manifests the sync just rewrote.

## 3. Open the version PR

```bash
cd <scratch dir>/release
git add -A && git commit -m "chore: version packages for vX.Y.Z"
git push -u origin chore/version-packages-vX.Y.Z
gh pr create --base main --title "chore: version packages for vX.Y.Z" --body-file <body file>
gh workflow run nightly-canary.yml --ref chore/version-packages-vX.Y.Z
gh run list --workflow nightly-canary.yml --branch chore/version-packages-vX.Y.Z --limit 1
```

Run the commit and the push as separate commands, and start the push with a
literal `cd <path>`: the push hook reads the directory from the command text.

The body carries a table of each published package's old and new version, the
PRs the release contains, why the server or core did not move if they did not,
and the tag. The changelog names commits, not PRs;
`git log --oneline <previous tag>..origin/main` gives the PR numbers.

The canary is not part of the PR's checks, which is why it is started by hand.
It stands in for the checklist's three green nights when the newest scheduled
run predates the commits being released.

## 4. Draft the release notes

Write them to a file while CI runs; `gh release create` takes `--notes-file`.
Build them from the new `CHANGELOG.md` sections, grouped by what a user of the
framework sees. Open with a `## Packages` list of the published versions, then
upgrade notes, then the changes. Say plainly:

- anything that changes behaviour on upgrade (sessions ended, a command that
  now refuses, a default that moved);
- any fix that lives in scaffolded files. An app that already generated the
  file keeps the old copy, so tell the reader which lines to change;
- a 0.x package that moved a minor: a caret range does not follow it;
- a tag number that differs from the server version, and why.

## 5. Merge when green and nothing moved

Before merging, all three hold:

- every PR check passed. A pending or missing check is not a pass:
  `gh pr view <n> --json statusCheckRollup -q '.statusCheckRollup[] | select(.status != "COMPLETED" or (.conclusion != "SUCCESS" and .conclusion != "SKIPPED")) | .name'`
  prints nothing, and the list it filtered was not empty;
- the canary run on the version branch concluded `success`;
- `git fetch origin main && git rev-list --count origin/chore/version-packages-vX.Y.Z..origin/main`
  prints `0`.

If `main` moved, look at what arrived. A commit with a changeset means the
changelog would miss it: rebuild the PR (troubleshooting has the commands). A
commit without one ships as it is; mention it in the notes.

When the user says to merge:

```bash
gh pr merge <n> --squash
gh pr view <n> --json mergeCommit -q .mergeCommit.oid
```

Leave out `--delete-branch`. Deleting the branch at merge has taken the release
worktree with it, and the close-out steps still use that worktree.

## 6. Create the Release

Hand this to the user, with the SHA the last command printed:

```bash
gh release create vX.Y.Z --target <full merge sha> --latest --title vX.Y.Z --notes-file <notes file>
```

The full SHA pins the release to the version commit whatever has landed on
`main` since; a short SHA is rejected, and `--target main` tags whatever `main`
is by then. `--title` and `--notes-file` keep `gh` from opening its interactive
prompts.

## 7. Watch the publish

```bash
gh run list --workflow release.yml --limit 1 --json databaseId,status,headSha
```

Wait for that run in the background (the loop is in troubleshooting), then
judge it by job and step conclusions, not by grepping the log. The `New tag:`
lines in the log list what was published.

npm's `latest` lags the publish by several minutes, and one package can lag the
others by ten. Poll the registry until every published package shows its new
version before you report the release as out:

```bash
curl -s https://registry.npmjs.org/@guren/server | jq -r '."dist-tags".latest'
```

## 8. Close out

- If `@guren/cli` moved, the catalog follows it. The script reads the local
  `packages/cli/package.json`, so it has to run where that file is the released
  one: in the release worktree after
  `git fetch origin && git checkout --detach <full merge sha>`, or in a main
  checkout that has pulled the release. The user runs
  `bun run publish:agent-catalog --yes`; `--dry-run` shows the diff first.
  Without `--yes` it exits 0 at its prompt and publishes nothing.
- `gh workflow run published-drift.yml --ref main`, then wait for it. It
  installs the published packages into fresh scaffolds and compares the agent
  catalog. All jobs green is the evidence that the release works from npm.
- `git worktree remove <scratch dir>/release`. The version branch can stay; it
  is the record of what the squash contained.
- Report: the versions published, the tag and its commit, the canary, publish
  and drift run ids, and any open PR that did not make this release.
