/**
 * Publish the rendered agent-catalog payload to gurenjs/agent-skills
 * (RFC 0011 §5).
 *
 * This is a maintainer-run script, not a CI job — the same shape Remotion
 * uses to publish `packages/skills/` from its monorepo to `remotion-dev/skills`.
 * It runs over the maintainer's own git credentials; there is no repository
 * token or secret anywhere. It belongs at the end of the release procedure,
 * after the npm publish the maintainer can see succeeded.
 *
 * What it does, in order, and why each step is where it is:
 *
 * 1. Render the payload into a temporary directory and run the same
 *    derived-fact assertions `audit:agent-catalog` runs, over that same tree.
 *    Provenance: the tree that is audited is the tree that is pushed, never
 *    a second render.
 * 2. Clone gurenjs/agent-skills shallow. Compare the plugin `version` already
 *    published with the one just rendered. Equal → nothing to do, exit 0.
 *    Most releases do not move @guren/cli, and failing here would make a
 *    routine step red for a reason that has nothing to do with the catalog.
 * 3. Delete every tracked file in the clone, write the rendered tree in, and
 *    check that what git staged is that same tree, path set and bytes — a
 *    global excludesFile or clean filter sits between the two. Then commit
 *    and push, appending to history rather than rewriting it: Claude Code
 *    keeps a local clone of a registered marketplace and refreshes it, so a
 *    rewritten history risks non-fast-forward failures for every registered
 *    user, and the payload is deterministic anyway. The push is leased to the
 *    tip that was cloned, so a remote that moved in the meantime — including
 *    one somebody deliberately rolled back, which a plain fast-forward would
 *    restore — is refused rather than overwritten.
 *
 * `--dry-run` does everything except commit and push, and prints the diff.
 * `--yes` skips the confirmation prompt (for the release checklist).
 * `--skip-validate` publishes without `claude plugin validate`, for a
 * maintainer who has run it by hand; without it, a validator that cannot run
 * refuses the publish.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { auditRenderedFiles, claudePluginValidate, writeCatalog, type RenderedFile } from './build-agent-catalog'
import { repoRoot } from './workspace-packages'

const PUBLISH_REPO = 'gurenjs/agent-skills'
const PUBLISH_BRANCH = 'main'

/**
 * Where to clone from and push to. The real remote by default; a test points
 * this at a local bare repository via `GUREN_AGENT_SKILLS_REMOTE` so the
 * no-op and fast-forward paths can be exercised without touching GitHub.
 */
function remotes(): string[] {
  const override = process.env.GUREN_AGENT_SKILLS_REMOTE
  if (override) return [override]
  return [`git@github.com:${PUBLISH_REPO}.git`, `https://github.com/${PUBLISH_REPO}.git`]
}

/**
 * `core.hooksPath` pointed at nothing, on every git command this script runs.
 * The clone is fresh, but hooks are not: a maintainer's global `core.hooksPath`
 * (or an `init.templateDir` that installs into the new clone) applies to it,
 * and those hooks run at exactly the moments this script's guarantee depends
 * on — `post-checkout` after the clone, `pre-commit` between the staged-tree
 * check and the tree that gets committed, `post-commit` before the push. The
 * rest of the maintainer's configuration is deliberately left alone: their
 * credential helper and SSH setup are how this pushes at all.
 */
const NO_HOOKS = ['-c', 'core.hooksPath=']

/**
 * Does this remote name the public repository? A local path is never it, however
 * it is spelled — a bare repo at `/tmp/gurenjs/agent-skills.git` is a test
 * remote, not GitHub — and the owner/repo pair is compared case-insensitively
 * because GitHub treats it that way while a substring check would not.
 */
export function isPublishRepo(remote: string): boolean {
  if (remote.startsWith('/') || remote.startsWith('.') || remote.startsWith('file:')) return false
  const address = remote.replace(/^[a-z+]+:\/\//iu, '').replace(/^[^@/]+@/u, '')
  const [host, ...rest] = address.split(/[:/]/u)
  const path = rest.join('/').replace(/\.git$/u, '')
  // the host too: a different server offering a path of the same name is
  // somebody's mirror, not the repository this script may not publish to
  return host?.toLowerCase() === 'github.com' && path.toLowerCase() === PUBLISH_REPO.toLowerCase()
}

function git(cwd: string, args: string[]): { ok: boolean; out: string; stdout: string } {
  const run = Bun.spawnSync(['git', ...NO_HOOKS, ...args], { cwd })
  return {
    ok: run.success,
    out: (run.stdout.toString() + run.stderr.toString()).trim(),
    stdout: run.stdout.toString(),
  }
}

/**
 * Throws rather than exits: every refusal here happens inside the `try` that
 * owns two temp directories, and `process.exit` would skip the `finally` that
 * removes them. The top-level catch prints the message and exits 1, which is
 * what a refusal looked like before.
 */
function fail(message: string): never {
  throw new PublishRefusal(message)
}

class PublishRefusal extends Error {}

/**
 * Is what git has staged exactly the tree that was rendered and audited? The
 * script's whole claim is that those two are the same tree, and between them
 * sit a maintainer's global git configuration and any hook or filter it
 * installs — an excludesFile that drops `*.md`, an attributes filter that
 * rewrites bytes. Compared here, at the point the two can still differ, by
 * path set and then blob by blob.
 */
async function stagedTreeProblems(cloneDir: string, files: readonly RenderedFile[]): Promise<string[]> {
  // --stage, so the mode comes with the path: a tree records `100755` and
  // `120000` as surely as it records bytes, and a publish that turned a
  // rendered file into an executable or a symlink would pass a comparison
  // that only read its content.
  const listed = git(cloneDir, ['ls-files', '--stage', '-z'])
  if (!listed.ok) return [`git ls-files failed after staging: ${listed.out}`]
  const entries = listed.stdout.split('\0').filter(Boolean).map((line) => {
    const [meta = '', path = ''] = line.split('\t')
    const [mode = '', , stage = ''] = meta.split(' ')
    return { mode, stage, path }
  })
  const stagedPaths = entries.map((entry) => entry.path)
  const staged = new Set(stagedPaths)
  const rendered = new Set(files.map((file) => file.path))
  const problems = [
    ...stagedPaths.filter((p) => !rendered.has(p)).map((p) => `staged but not rendered: ${p}`),
    ...[...rendered].filter((p) => !staged.has(p)).map((p) => `rendered but not staged: ${p}`),
  ].sort()
  if (problems.length > 0) return problems
  for (const entry of entries) {
    if (entry.mode !== '100644') problems.push(`staged as ${entry.mode}, not a plain file: ${entry.path}`)
    if (entry.stage !== '0') problems.push(`staged unmerged (stage ${entry.stage}): ${entry.path}`)
  }
  for (const file of files) {
    const blob = git(cloneDir, ['show', `:${file.path}`])
    if (!blob.ok) {
      problems.push(`could not read the staged copy of ${file.path}: ${blob.out}`)
    } else if (blob.stdout !== file.content) {
      problems.push(`staged bytes differ from the rendered bytes: ${file.path}`)
    }
  }
  return problems
}

/** The plugin version a rendered or cloned tree declares, or null if unreadable. */
async function pluginVersionIn(dir: string): Promise<string | null> {
  try {
    const manifest = (await Bun.file(join(dir, 'plugins', 'guren', 'plugin.json')).json()) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const yes = args.includes('--yes')

  // the generator's version override exists so this script's own test can
  // render a second version without editing packages/cli/package.json. Left
  // in a maintainer's environment it would otherwise publish that synthetic
  // version to the real repository under the real plugin name.
  // asked of the destination this run actually resolved, not of the env var
  // that happens to redirect it today: a second way to point somewhere else
  // would leave a proxy check green while the hole it closes reopened
  const override = process.env.GUREN_CATALOG_VERSION_OVERRIDE
  if (override && remotes().some(isPublishRepo)) {
    fail(
      `Refusing to publish: GUREN_CATALOG_VERSION_OVERRIDE=${override} is set. It is a test hook for a local remote, not a way to publish a version @guren/cli does not have.`,
    )
  }

  // 1. render + audit the tree we are about to push
  const renderDir = await mkdtemp(join(tmpdir(), 'guren-catalog-publish-'))
  const cloneDir = await mkdtemp(join(tmpdir(), 'guren-catalog-clone-'))
  const cleanup = async (): Promise<void> => {
    await rm(renderDir, { recursive: true, force: true })
    await rm(cloneDir, { recursive: true, force: true })
  }

  try {
    const files = await writeCatalog(renderDir)
    const problems = await auditRenderedFiles(files)
    if (problems.length > 0) {
      fail(`Refusing to publish: the rendered payload fails its own audit.\n${problems.map((p) => `  ${p}`).join('\n')}`)
    }
    // CI cannot run the validator (no `claude` on the ubuntu runner), so
    // publish is where it must run — this is the last gate before users.
    // An unavailable check is not a green one, so it refuses; --skip-validate
    // is the explicit override, for a maintainer who has run it by hand, and
    // it skips the run itself rather than only forgiving the outcome.
    if (args.includes('--skip-validate')) {
      console.warn('Note: --skip-validate given; publishing without claude plugin validate.')
    } else {
      const validated = await claudePluginValidate(renderDir)
      if (validated.kind === 'fail') {
        fail(`Refusing to publish: claude plugin validate --strict failed.\n${validated.output}`)
      }
      if (validated.kind === 'unavailable') {
        fail(`Refusing to publish: claude plugin validate could not run (${validated.reason}). Install the Claude Code CLI, or pass --skip-validate after validating by hand.`)
      }
    }
    const nextVersion = (await pluginVersionIn(renderDir)) ?? fail('Rendered payload has no plugin version — refusing to publish.')

    // 2. clone and compare
    // try each remote form in turn: SSH first, HTTPS for maintainers who
    // authenticate that way
    let cloned = false
    const errors: string[] = []
    for (const remote of remotes()) {
      await rm(cloneDir, { recursive: true, force: true })
      const clone = git(repoRoot, ['clone', '--quiet', '--depth', '1', '--branch', PUBLISH_BRANCH, remote, cloneDir])
      if (clone.ok) {
        cloned = true
        break
      }
      errors.push(clone.out)
    }
    if (!cloned) fail(`Could not clone ${PUBLISH_REPO}:\n${errors.join('\n')}`)
    // the tip this run is allowed to move: the push leases it, so a remote
    // that changed under us — including one somebody force-rolled backwards,
    // which an ordinary fast-forward would happily restore — is refused
    // asked again of the clone, because the URL this run resolved is not
    // necessarily the one git will push to: a global `remote.origin.pushurl`
    // applies to any repository whose remote is named origin, including this
    // fresh one.
    const pushUrl = git(cloneDir, ['remote', 'get-url', '--push', 'origin']).stdout.trim()
    if (override && isPublishRepo(pushUrl)) {
      fail(
        `Refusing to publish: GUREN_CATALOG_VERSION_OVERRIDE=${override} is set and this clone pushes to ${pushUrl}.`,
      )
    }
    const baseOid = git(cloneDir, ['rev-parse', 'HEAD']).stdout.trim()
    const publishedVersion = await pluginVersionIn(cloneDir)
    console.log(
      publishedVersion === nextVersion
        ? `${PUBLISH_REPO} already publishes @guren/cli ${nextVersion}; checking the tree is byte-identical.`
        : `Publishing @guren/cli ${nextVersion} to ${PUBLISH_REPO} (currently ${publishedVersion ?? 'unpublished'}).`,
    )

    // 3. replace tracked contents with the rendered tree. Every tracked file
    // is removed, then every rendered file is written at its exact path with
    // mkdir -p — never `cp -R` of a directory, which nests (`plugins/plugins/`)
    // when the destination already exists, i.e. on every publish after the
    // first. Directories emptied by the removals are swept last.
    const tracked = git(cloneDir, ['ls-files', '-z'])
    if (!tracked.ok) fail(`git ls-files failed in the clone:\n${tracked.out}`)
    for (const path of tracked.stdout.split('\0').filter(Boolean)) {
      await rm(join(cloneDir, path), { force: true })
    }
    for (const file of files) {
      const dest = join(cloneDir, file.path)
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, file.content, 'utf8')
    }
    Bun.spawnSync(['find', cloneDir, '-type', 'd', '-empty', '-not', '-path', '*/.git*', '-delete'])

    // --force: a maintainer's global excludesFile applies inside the clone,
    // and a publish that quietly stages nine of ten rendered files would be
    // indistinguishable from a correct one
    const add = git(cloneDir, ['add', '--force', '-A'])
    if (!add.ok) fail(`git add failed in the clone:\n${add.out}`)
    const staged = await stagedTreeProblems(cloneDir, files)
    if (staged.length > 0) {
      fail(
        `Refusing to publish: the staged tree is not the tree that was audited.\n${staged.map((p) => `  ${p}`).join('\n')}`,
      )
    }
    // the index just verified, named. Everything after this point — the
    // prompt, the commit — is checked against this OID rather than trusted to
    // have left it alone.
    const verifiedTree = git(cloneDir, ['write-tree'])
    if (!verifiedTree.ok) fail(`git write-tree failed in the clone:\n${verifiedTree.out}`)
    const verifiedTreeOid = verifiedTree.stdout.trim()
    const status = git(cloneDir, ['status', '--porcelain'])
    if (status.out === '') {
      // the same-version no-op: most releases do not move @guren/cli, and a
      // publish that finds nothing to write is a success, not a failure
      console.log('Rendered payload is byte-identical to what is published; nothing to do.')
      return
    }
    if (publishedVersion === nextVersion) {
      // same version, different bytes: a LICENSE change, a wording fix that
      // rode a CLI release, or a corrupted earlier publish. Republish — but
      // note that plugin.json's version is Claude Code's cache key, so
      // already-installed copies will not pick this up until the next bump.
      console.warn(`Note: version ${nextVersion} is already published but the tree differs; republishing. Installed plugins keyed on this version will not refresh until @guren/cli moves.`)
    }
    // the stat says which files move; the patch is what a maintainer is
    // actually authorizing, and the next step is a public push
    console.log(git(cloneDir, ['diff', '--cached', '--stat']).out)
    console.log(git(cloneDir, ['diff', '--cached', '--no-ext-diff']).out)

    if (dryRun) {
      console.log('\n--dry-run: not committing or pushing.')
      return
    }
    if (!yes) {
      process.stdout.write(`\nPush this to ${PUBLISH_REPO}/${PUBLISH_BRANCH}? [y/N] `)
      const answer = await new Promise<string>((resolve) => {
        process.stdin.once('data', (d) => resolve(d.toString().trim()))
      })
      if (!/^y(es)?$/iu.test(answer)) {
        console.log('Aborted.')
        return
      }
    }
    const message = `Publish @guren/cli ${nextVersion}`
    const commit = git(cloneDir, ['commit', '--quiet', '-m', message])
    if (!commit.ok) fail(`git commit failed:\n${commit.out}`)

    // what actually got committed, checked rather than assumed: the tree must
    // be the one verified above, and its one parent the tip that was cloned.
    const head = git(cloneDir, ['rev-parse', 'HEAD'])
    if (!head.ok) fail(`git rev-parse HEAD failed in the clone:\n${head.out}`)
    const commitOid = head.stdout.trim()
    const tree = git(cloneDir, ['rev-parse', `${commitOid}^{tree}`]).stdout.trim()
    const parents = git(cloneDir, ['rev-list', '--parents', '-n', '1', commitOid]).stdout.trim().split(' ').slice(1)
    if (tree !== verifiedTreeOid || parents.length !== 1 || parents[0] !== baseOid) {
      fail(
        `Refusing to publish: the commit is not the one this run built (tree ${tree}, parents ${parents.join(' ') || 'none'}; expected tree ${verifiedTreeOid} on ${baseOid}).`,
      )
    }

    // that commit by OID, not a branch name that something could have moved,
    // onto a remote leased to the tip that was cloned: any other value there
    // means the remote changed while this ran, and the answer is always to
    // re-run rather than to overwrite. A plain push would reject a divergent
    // remote but would happily fast-forward a deliberate rollback back into
    // place.
    const push = git(cloneDir, [
      'push',
      '--quiet',
      `--force-with-lease=${PUBLISH_BRANCH}:${baseOid}`,
      'origin',
      `${commitOid}:refs/heads/${PUBLISH_BRANCH}`,
    ])
    if (!push.ok) fail(`git push failed (the remote moved since this run cloned it; re-run to publish onto its new tip):\n${push.out}`)
    console.log(`Published: ${message}`)
  } finally {
    await cleanup()
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    // a refusal is a sentence written for the maintainer and its stack says
    // nothing; anything else is a crash, and reducing that to one line is how
    // a real bug in this script looks like a considered decision not to
    // publish
    console.error(error instanceof PublishRefusal ? error.message : error)
    process.exit(1)
  })
}
