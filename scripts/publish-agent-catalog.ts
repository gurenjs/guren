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
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const run = Bun.spawnSync(['git', ...args], { cwd })
  return { ok: run.success, out: (run.stdout.toString() + run.stderr.toString()).trim() }
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
      // publishing without the validator is a maintainer decision, made
      // visibly; the audit in CI already ran on the same sources
      console.warn(`Note: claude plugin validate could not run here (${validated.reason}); publishing on the derived-fact audit alone.`)
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
    if (publishedVersion === nextVersion) {
      console.log(`${PUBLISH_REPO} already publishes @guren/cli ${nextVersion}; nothing to do.`)
      return
    }
    console.log(`Publishing @guren/cli ${nextVersion} to ${PUBLISH_REPO} (currently ${publishedVersion ?? 'unpublished'}).`)

    // 3. replace tracked contents with the rendered tree
    const tracked = git(cloneDir, ['ls-files'])
    if (!tracked.ok) fail(`git ls-files failed in the clone:\n${tracked.out}`)
    for (const path of tracked.out.split('\n').filter(Boolean)) {
      await rm(join(cloneDir, path), { force: true })
    }
    // copy rendered files in (recursive dir copy via cp -R keeps this dependency-free)
    for (const entry of await readdir(renderDir)) {
      const cp = Bun.spawnSync(['cp', '-R', join(renderDir, entry), join(cloneDir, entry)])
      if (!cp.success) fail(`Failed to copy ${entry} into the clone.`)
    }
    // sweep empty directories left behind by removed files
    Bun.spawnSync(['find', cloneDir, '-type', 'd', '-empty', '-not', '-path', '*/.git*', '-delete'])

    git(cloneDir, ['add', '-A'])
    const status = git(cloneDir, ['status', '--porcelain'])
    if (status.out === '') {
      console.log('Rendered payload is byte-identical to what is published; nothing to commit.')
      return
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
