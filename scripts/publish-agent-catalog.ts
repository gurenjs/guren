/**
 * Publish the rendered agent-catalog payload to gurenjs/agent-skills (RFC 0011 §5).
 * Maintainer-run after the npm publish. Renders to a temp dir, runs the
 * `audit:agent-catalog` assertions over that same tree, and exits 0 when the published
 * plugin `version` equals the rendered one; else replaces every tracked file, checks
 * git staged exactly that tree (a global excludesFile or clean filter sits between),
 * and appends a commit: history is never rewritten, since Claude Code keeps a local
 * clone of each registered marketplace, and the push is leased to the cloned tip.
 * Flags: `--dry-run` (diff only), `--yes` (no prompt), `--skip-validate` (no `claude plugin validate`).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { auditRenderedFiles, claudePluginValidate, NO_HOOKS, writeCatalog, type RenderedFile } from './build-agent-catalog'
import { repoRoot } from './workspace-packages'

const PUBLISH_REPO = 'gurenjs/agent-skills'
const PUBLISH_BRANCH = 'main'

/**
 * The real remote by default; `GUREN_AGENT_SKILLS_REMOTE` points a test at a
 * local bare repository so the no-op and fast-forward paths can run.
 */
function remotes(): string[] {
  const override = process.env.GUREN_AGENT_SKILLS_REMOTE
  if (override) return [override]
  return [`git@github.com:${PUBLISH_REPO}.git`, `https://github.com/${PUBLISH_REPO}.git`]
}

/**
 * Does this remote name the public repository? A local path is never it however
 * it is spelled, and the owner/repo pair is compared case-insensitively because
 * GitHub treats it that way while a substring check would not.
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

/**
 * `NO_HOOKS` on every git command, not only the clone: this script's guarantee
 * depends on hook moments throughout — `post-checkout` after the clone,
 * `pre-commit` between the staged-tree check and the commit, `post-commit`
 * before the push. The rule lives with the constant in build-agent-catalog.
 */
function git(cwd: string, args: string[]): { ok: boolean; out: string; stdout: string } {
  const run = Bun.spawnSync(['git', ...NO_HOOKS, ...args], { cwd })
  return {
    ok: run.success,
    out: (run.stdout.toString() + run.stderr.toString()).trim(),
    stdout: run.stdout.toString(),
  }
}

/**
 * Throws rather than exits: refusals happen inside the `try` owning two temp
 * directories, and `process.exit` would skip the `finally` that removes them.
 */
function fail(message: string): never {
  throw new PublishRefusal(message)
}

class PublishRefusal extends Error {}

/**
 * Is what git staged exactly the tree that was rendered and audited? Between the
 * two sit the maintainer's global git configuration and any hook or filter it
 * installs, so they are compared by path set and then blob by blob.
 */
async function stagedTreeProblems(cloneDir: string, files: readonly RenderedFile[]): Promise<string[]> {
  // --stage, so the mode comes with the path: a publish that turned a rendered
  // file into an executable or a symlink would pass a content-only comparison.
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

  // The generator's version override is a test hook; left in a maintainer's
  // environment it would publish a synthetic version to the real repository.
  // Asked of the destination this run resolved rather than of the env var that
  // redirects it, so a second redirect cannot leave this check green.
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
    // CI has no `claude` on the ubuntu runner, so publish is the last gate before
    // users. An unavailable check is not a green one, so it refuses;
    // --skip-validate skips the run itself rather than forgiving the outcome.
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
    // Asked again of the clone: a global `remote.origin.pushurl` applies to any
    // repository whose remote is named origin, including this fresh one.
    const pushUrl = git(cloneDir, ['remote', 'get-url', '--push', 'origin']).stdout.trim()
    if (override && isPublishRepo(pushUrl)) {
      fail(
        `Refusing to publish: GUREN_CATALOG_VERSION_OVERRIDE=${override} is set and this clone pushes to ${pushUrl}.`,
      )
    }
    // the tip this run is allowed to move: the push leases it, so a remote that
    // changed under us (a rollback included) is refused
    const baseOid = git(cloneDir, ['rev-parse', 'HEAD']).stdout.trim()
    const publishedVersion = await pluginVersionIn(cloneDir)
    console.log(
      publishedVersion === nextVersion
        ? `${PUBLISH_REPO} already publishes @guren/cli ${nextVersion}; checking the tree is byte-identical.`
        : `Publishing @guren/cli ${nextVersion} to ${PUBLISH_REPO} (currently ${publishedVersion ?? 'unpublished'}).`,
    )

    // 3. replace tracked contents with the rendered tree, writing each file at
    // its exact path — never `cp -R` of a directory, which nests
    // (`plugins/plugins/`) once the destination exists.
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

    // --force: a maintainer's global excludesFile applies inside the clone, and a
    // publish staging nine of ten rendered files would look correct
    const add = git(cloneDir, ['add', '--force', '-A'])
    if (!add.ok) fail(`git add failed in the clone:\n${add.out}`)
    const staged = await stagedTreeProblems(cloneDir, files)
    if (staged.length > 0) {
      fail(
        `Refusing to publish: the staged tree is not the tree that was audited.\n${staged.map((p) => `  ${p}`).join('\n')}`,
      )
    }
    // the index just verified: everything after this point is checked against
    // this OID rather than trusted to have left it alone
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
      // Same version, different bytes: republish, but plugin.json's version is
      // Claude Code's cache key, so installed copies wait for the next bump.
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

    // That commit by OID, not a branch name something could have moved, onto a
    // remote leased to the cloned tip: any other value means the remote changed
    // while this ran, and the answer is to re-run. A plain push would reject a
    // divergent remote but fast-forward a deliberate rollback back into place.
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
    // A refusal is a sentence written for the maintainer and its stack says
    // nothing; reducing anything else to one line makes a real bug look like a
    // considered decision not to publish.
    console.error(error instanceof PublishRefusal ? error.message : error)
    process.exit(1)
  })
}
