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
 * 3. Delete every tracked file in the clone, copy the rendered tree in, and
 *    commit. Ordinary fast-forward push — never --force. Claude Code keeps a
 *    local clone of a registered marketplace and refreshes it; a rewritten
 *    history risks non-fast-forward failures for every registered user, and
 *    the payload is deterministic anyway.
 *
 * `--dry-run` does everything except commit and push, and prints the diff.
 * `--yes` skips the confirmation prompt (for the release checklist).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { auditRenderedFiles, claudePluginValidate, writeCatalog } from './build-agent-catalog'
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

function git(cwd: string, args: string[]): { ok: boolean; out: string; stdout: string } {
  const run = Bun.spawnSync(['git', ...args], { cwd })
  return {
    ok: run.success,
    out: (run.stdout.toString() + run.stderr.toString()).trim(),
    stdout: run.stdout.toString(),
  }
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
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
    const validated = await claudePluginValidate(renderDir)
    if (validated.kind === 'fail') {
      fail(`Refusing to publish: claude plugin validate --strict failed.\n${validated.output}`)
    }
    if (validated.kind === 'unavailable') {
      // CI cannot run the validator (no `claude` on the ubuntu runner), so
      // publish is where it must run — this is the last gate before users.
      // Refuse rather than warn: an unavailable check is not a green one.
      // --skip-validate is the explicit override, for a maintainer who has
      // run it by hand.
      if (!args.includes('--skip-validate')) {
        fail(`Refusing to publish: claude plugin validate could not run (${validated.reason}). Install the Claude Code CLI, or pass --skip-validate after validating by hand.`)
      }
      console.warn(`Note: --skip-validate given; publishing without claude plugin validate (${validated.reason}).`)
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

    git(cloneDir, ['add', '-A'])
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
    const diffStat = git(cloneDir, ['diff', '--cached', '--stat'])
    console.log(diffStat.out)

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
    // ordinary push: fast-forward only, never --force
    const push = git(cloneDir, ['push', '--quiet', 'origin', PUBLISH_BRANCH])
    if (!push.ok) fail(`git push failed (a non-fast-forward means someone else pushed; re-run to rebase onto their tip):\n${push.out}`)
    console.log(`Published: ${message}`)
  } finally {
    await cleanup()
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
