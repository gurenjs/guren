/**
 * Publish the tutorial app's chapter checkpoints (RFC 0019 §3): the `main` a
 * full `smoke:tutorial` run built, plus its `chapter-NN` tags, pushed to a
 * companion repository. A reader whose agent produced something else checks out
 * `chapter-07` and carries on; nothing here is hand-maintained.
 *
 * The workspace is an argument rather than something this script builds, so a
 * publish always describes a run that already went green.
 */
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const REMOTE_ENV = 'TUTORIAL_APP_REMOTE'

function usage(message: string): never {
  console.error(`${message}

Usage: bun scripts/smoke/tutorial-checkpoints.ts <workspace> [--dry-run]

  <workspace>   the directory a kept smoke run printed ("Keeping tutorial
                workspace: …"), or the app inside it
  --dry-run     report what would be pushed, push nothing

  ${REMOTE_ENV}   the companion repository to push to. Required without
                --dry-run; a URL git can push to, credentials included by
                whatever the environment already gives git.`)
  process.exit(2)
}

async function capture(cmd: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn({ cmd, cwd, stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`${cmd.join(' ')} failed (${code}): ${err.trim() || out.trim()}`)
  return out
}

async function run(cmd: string[], cwd: string): Promise<void> {
  console.log(`$ ${cmd.join(' ')}`)
  const proc = Bun.spawn({ cmd, cwd, stdout: 'inherit', stderr: 'inherit' })
  const code = await proc.exited
  if (code !== 0) throw new Error(`${cmd.join(' ')} failed with exit code ${code}`)
}

/** The app is either the path given or the single directory under `workspace/`. */
async function resolveApp(input: string): Promise<string> {
  const direct = resolve(input)
  if (await Bun.file(join(direct, 'package.json')).exists()) return direct

  const nested = join(direct, 'workspace')
  const entries = await readdir(nested).catch(() => null)
  if (!entries) usage(`No app in ${input}: it has no package.json and no workspace/ directory.`)
  for (const entry of entries) {
    const candidate = join(nested, entry)
    if (await Bun.file(join(candidate, 'package.json')).exists()) return candidate
  }
  usage(`No app under ${nested}.`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const target = args.find((arg) => !arg.startsWith('--'))
  if (!target) usage('Pass the workspace a kept smoke run left behind.')

  const app = await resolveApp(target)
  const tags = (await capture(['git', 'tag', '--list', 'chapter-*'], app)).split('\n').filter(Boolean).sort()
  if (tags.length === 0) {
    throw new Error(`${app} carries no chapter-* tags. Only a full smoke:tutorial run writes them, one per chapter that passed its gate.`)
  }

  const head = (await capture(['git', 'rev-parse', '--short', 'HEAD'], app)).trim()
  const last = tags[tags.length - 1]!
  const lastCommit = (await capture(['git', 'rev-parse', '--short', `${last}^{commit}`], app)).trim()
  if (lastCommit !== head) {
    throw new Error(`The last tag (${last} at ${lastCommit}) is not HEAD (${head}); publish a complete run, not a partial one.`)
  }

  console.log(`app:  ${app}`)
  console.log(`head: ${head}`)
  console.log(`tags: ${tags.join(', ')}`)

  const remote = process.env[REMOTE_ENV]?.trim()
  if (dryRun) {
    console.log(`\n[dry-run] Would push main and ${tags.length} tag(s)${remote ? ` to ${remote}` : ` once ${REMOTE_ENV} is set`}.`)
    return
  }
  if (!remote) usage(`${REMOTE_ENV} is not set, and a publish needs somewhere to push.`)

  await run(['git', 'remote', 'remove', 'checkpoints'], app).catch(() => {})
  await run(['git', 'remote', 'add', 'checkpoints', remote], app)
  // Force, because a rerun of the same chapter is a different commit: the
  // checkpoints describe the current text, not the history of the course.
  await run(['git', 'push', '--force', 'checkpoints', 'HEAD:refs/heads/main'], app)
  await run(['git', 'push', '--force', '--tags', 'checkpoints'], app)
  console.log(`\nPublished ${tags.length} checkpoint(s) to ${remote}.`)
}

await main()
