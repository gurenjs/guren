# Release troubleshooting

Read this once before a release, then come back to the step you are on. Each
entry is something a past release hit, what it turned out to be, and what to
do.

Two habits apply to all of them. Before reading a red check literally, ask what
it measures: a version bump is the first moment some guards can fire, so a red
version PR is often work the release was always going to need. And before
calling a failure a flake, look for the same failure on `main` without your
change; a rerun that happens to pass hides a real one.

## Contents

- Waiting for a run
- `version-packages` stops
- A package is published for the first time
- `main` moved while the version PR waited
- The version PR's CI is red
- The canary is red
- `Release Publish` is red
- Tags and `gh release create`
- A changeset that missed the release
- npm, the catalog and the drift check
- Shell and tooling traps

## Waiting for a run

Wait in a background command so the turn is not spent polling, and test
`.status`: a run in progress has an empty `.conclusion`.

```bash
until [ "$(gh run view <id> --json status -q .status)" = "completed" ]; do sleep 30; done
gh run view <id> --json conclusion,jobs -q '.conclusion, (.jobs[] | .name+": "+(.conclusion // ""))'
```

Find a run you dispatched with
`gh run list --workflow <file> --branch <ref> --limit 1`.

For npm, print each published package's `latest` beside the version you expect,
and repeat until they match. Give the repeat a limit, so a publish that never
arrives ends the wait:

```bash
while read -r pkg want; do
  echo "$pkg $(curl -s "https://registry.npmjs.org/$pkg" | jq -r '."dist-tags".latest') (want $want)"
done <<'LIST'
@guren/server X.Y.Z
create-guren-app X.Y.Z
LIST
```

## `version-packages` stops

The script chains its gates with `&&`, so the first failure is the last output.
The gates ahead of `changeset version` write nothing. The ones after it stop
with the bump already in the working tree, and can be run again as they are.

| Stops at | Meaning | Do |
|---|---|---|
| `node_modules/.bin/changeset is missing` | Fresh worktree | `bun install`, run again |
| a module that cannot be resolved | Packages not built | `bun run build`, run again |
| `sync-template-deps --gate-ages` | A third-party range a scaffold resolves has no version old enough for the release-age gate | Wait until the versions clear the gate, or lower the range to a version that has; the message lists each range and why |
| `audit:core-semver` | The plan majors `@guren/server` without majoring `@guren/core` | Add a core major changeset; core re-exports the server |
| `audit:published-imports` | The pending release drops a name an already published dependent imports | Keep the name exported and deprecated. Releasing the dependent alongside does not help apps on its old range |
| `The templates changed but create-guren-app is still X` | Template ranges moved but `create-guren-app` is not in the plan | Normally `plan-create-app-bump.ts` writes that changeset itself. If it did not, add a `create-guren-app` patch changeset and run again |
| `audit:plugin-compat` | A plugin's `gurenPlugin.compatibility` contradicts the range changesets just rewrote | Update `compatibility` in that plugin's manifest |

Running `version-packages` a second time after adding a changeset consumes only
the addition. That is fine for one small addition. After several, rebuild from
`main` (below) so each package moves once.

## A package is published for the first time

npm trusted publishing cannot create a package: the `publish` step fails with
`E404` for the new one after the others have gone out. The line
`N workspace package(s) not on npm` in the `audit:published-imports` output
warns of it.

Do the first publish by hand, before the Release exists:

1. Merge the version PR.
2. Build the merged `main` in the release worktree.
3. The user logs in to npm and runs `npm publish --access public` in the
   package's directory.
4. Wait until the registry serves it, then create the Release.

Publish the version the bump produced, not the one the manifest had before. A
0.x package with a minor changeset goes 0.1.0 → 0.2.0, and publishing 0.1.0
leaves the train to fail on 0.2.0. From the second release on, trusted
publishing handles the package.

## `main` moved while the version PR waited

Check before merging and again just before the Release:

```bash
git fetch origin main
git log --oneline origin/chore/version-packages-vX.Y.Z..origin/main
git diff --stat origin/chore/version-packages-vX.Y.Z...origin/main -- .changeset
```

A new commit without a changeset needs nothing: it ships with the release, so
name it in the notes. A new commit with a changeset needs a rebuild, or its
changelog line and possibly its version bump are missing. Merging `main` into
the branch is not enough, since the changeset arrives unconsumed.

Rebuild in the release worktree, with no force push:

```bash
git merge --no-commit --no-ff origin/main
git read-tree -u --reset origin/main     # the tree is main's again
bun install
bun run version-packages
# tutorial version line again if it applies, then commit and push
```

Start the canary again on the new head. If this keeps happening, ask the user
to hold merges to `main` until the version PR is in.

## The version PR's CI is red

- The `Docs audit` step: the tutorial "verified against" line. It compares major.minor
  of `create-guren-app` and `@guren/server`, so it fires on a minor and never
  on a patch. Update both locales.
- A template or scaffold test that names a `@guren/*` range: the bump changed
  the range. The test is telling you a template needs the change the new
  version allows. Make it in the version PR.
- A smoke fails in `bun install` on a version that is not on npm: some package
  is installed from the registry instead of the checkout. Which packages a
  smoke resolves locally is derived in `scripts/smoke/local-packages.ts`; a
  package no template declares is not in that set.
- A trial matrix lane: `continue-on-error` covers it. Check that the failing
  step is the one the trial exists for, then leave it.
- Tests that time out only in CI: compare with `main`. The same test failing on
  a commit without your change is a flake; `gh run rerun --failed` once.

Scripts and tests are not published, so fixing them in the version PR needs no
changeset.

## The canary is red

The canary runs what PR CI skips, the wrangler-backed tests among them. Look at
the scheduled runs on `main`: if they are red for the same reason, the defect
is on `main` and is fixed there first. A single timeout in a package the
release does not touch is worth one `gh run rerun --failed`.

The checklist asks for a canary that has been green for three days. When the
nightly has not run that long on the current code, the run you dispatch on the
version branch stands in for it; say so in the PR.

## `Release Publish` is red

Read the conclusions before the log:

```bash
gh run view <id> --json jobs -q '.jobs[] | .name, (.steps[] | select(.conclusion=="failure") | "  failed: "+.name)'
```

**`validate` failed.** Nothing has been published. The release gate is not the
same run as CI: it runs the smokes and the tests on one runner, so a test that
depends on its environment can pass in CI and fail here. Decide whether the
failure is deterministic by reading the test, not by rerunning. If it is, fix
it on `main`, delete the Release and its tag, and create the Release again
under the same number on the new commit. npm never saw the first attempt, so no
version is skipped.

**`publish` failed.** Some packages are already out and cannot be withdrawn.
Do not delete the Release. Find which package failed (`New tag:` lines list the
ones that succeeded); a first publish is the usual cause, and the fix is the
manual publish above.

## Tags and `gh release create`

- `--target` takes a full SHA or a branch name. A short SHA fails with
  `target_commitish is invalid`.
- With `--target main`, a commit that landed since the merge is what gets
  tagged and published. Pass the merge commit's SHA.
- Check `git tag -l 'vX.Y*'` first. The convention that the tag equals the
  server version slips by one every time a release leaves the server alone.
- Run without `--title` and `--notes-file`, `gh` asks for them interactively.

## A changeset that missed the release

A PR merged between the version PR and the tag is in the published code, and
its changeset is still in `.changeset/`. Either leave it for the next release
and say in the notes that the change is already out, or open a small PR that
moves its text into the released version's `CHANGELOG.md` section and deletes
the changeset.

## npm, the catalog and the drift check

- Right after the publish, `npm view` and the registry return the old `latest`,
  and for a new package a 404. `New tag:` in the workflow log is the proof of
  publish; then wait for the registry.
- `publish:agent-catalog` does nothing when `@guren/cli` did not move. When it
  did, the diff is usually five version strings. It clones over SSH; with a
  dead SSH agent it hangs, and this environment makes git use HTTPS through
  `gh`:

  ```bash
  GIT_CONFIG_COUNT=3 \
  GIT_CONFIG_KEY_0=url.https://github.com/.insteadOf GIT_CONFIG_VALUE_0=git@github.com: \
  GIT_CONFIG_KEY_1=url.https://github.com/.insteadOf GIT_CONFIG_VALUE_1=ssh://git@github.com/ \
  GIT_CONFIG_KEY_2=credential.helper GIT_CONFIG_VALUE_2='!gh auth git-credential' \
  bun run publish:agent-catalog --yes
  ```

- `published-drift.yml` is red between a template-facing change and the
  release that publishes what the template needs. That is correct, and the
  release is the fix. Red after the release is a real finding: a red
  `agent-catalog` job means the catalog was not published.

## Shell and tooling traps

- macOS has no `timeout` command.
- zsh does not split an unquoted variable, so `for p in $list` runs once. Feed
  loops with `while read -r pkg want; do …; done <<'EOF'`.
- Pipe `curl` straight into `jq`. `echo "$json" | jq` lets zsh interpret
  escapes and breaks the JSON.
- `gh pr checks --watch` can exit 0 on a network timeout with every check still
  pending. Wait on `gh run view --json status` or the PR's `statusCheckRollup`,
  and test `.status`: a check in progress has an empty `.conclusion`.
- A push command should start with a literal `cd <path>`. The push-overlap hook
  reads the directory from the command and misjudges a path held in a variable.
- A fresh worktree fails `bun run typecheck` on the examples until each has
  run `bun run codegen`. That is setup, not the bump.
