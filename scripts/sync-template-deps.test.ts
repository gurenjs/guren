import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { assertCreateAppRepublishes } from './sync-template-deps'

/**
 * The create-guren-app republish refusal, against throwaway repositories.
 *
 * It only says anything against real commits — it compares the version
 * committed at `HEAD` against the one in the working tree — so each case here
 * builds a repository and points the refusal at it.
 *
 * The fixture carries the one file the refusal reads. Everything else in
 * `sync-template-deps.ts` runs against the real workspace and is covered by
 * `bun run audit:template-deps`.
 */
describe('assertCreateAppRepublishes', () => {
  let scratch: string
  let repoCount = 0

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'guren-template-deps-'))
  })
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true })
  })

  /**
   * Every git call is hardened against the machine it runs on: a global
   * `core.hooksPath` reaches repositories created here, a global
   * `commit.gpgsign` would make a commit *prompt* — and a hang in bun:test is
   * charged to the following test, so it would not even look like this one —
   * and a CI runner has no committer identity to inherit.
   */
  const HERMETIC = [
    '-c', 'core.hooksPath=',
    '-c', 'commit.gpgsign=false',
    '-c', 'user.name=Guren template-deps test',
    '-c', 'user.email=template-deps-test@guren.dev',
  ]

  function git(repo: string, ...args: string[]): string {
    const proc = Bun.spawnSync(['git', ...HERMETIC, ...args], { cwd: repo })
    if (!proc.success) {
      throw new Error(`git ${args.join(' ')} failed: ${proc.stderr.toString().trim()}`)
    }
    return proc.stdout.toString().trim()
  }

  const MANIFEST = 'packages/create-app/package.json'

  const manifest = (version: string) =>
    `${JSON.stringify({ name: 'create-guren-app', version }, null, 2)}\n`

  async function put(repo: string, path: string, content: string): Promise<void> {
    const full = join(repo, path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, content, 'utf8')
  }

  /** A repository whose committed create-app manifest is `committed`. */
  async function repoAt(committed: string): Promise<string> {
    const repo = join(scratch, `repo-${++repoCount}`)
    await mkdir(repo, { recursive: true })
    git(repo, 'init', '--quiet', '--initial-branch=main')
    await put(repo, MANIFEST, committed)
    git(repo, 'add', '-A')
    git(repo, 'commit', '--quiet', '-m', 'base')
    return repo
  }

  it('passes when the working tree moved the version', async () => {
    const repo = await repoAt(manifest('2.7.1'))
    await put(repo, MANIFEST, manifest('2.8.0'))
    expect(await assertCreateAppRepublishes(repo)).toBeUndefined()
  })

  it('refuses when the version did not move, and names it', async () => {
    const repo = await repoAt(manifest('2.7.1'))
    await expect(assertCreateAppRepublishes(repo)).rejects.toThrow(/create-guren-app is still 2\.7\.1/)
  })

  // The rest is the same fact from both sides: a version nobody could read is
  // not a version that moved. `undefined !== '2.8.0'` compares unequal, so
  // every one of these cases used to *pass* the refusal and let a release ship
  // rewritten template ranges inside no new tarball.

  it('refuses a committed manifest with no version, rather than reading it as a bump', async () => {
    const repo = await repoAt(`${JSON.stringify({ name: 'create-guren-app' }, null, 2)}\n`)
    await put(repo, MANIFEST, manifest('2.8.0'))
    await expect(assertCreateAppRepublishes(repo)).rejects.toThrow(/no readable version committed at HEAD/)
  })

  it('refuses a committed manifest whose version is not a string', async () => {
    const repo = await repoAt(`${JSON.stringify({ name: 'create-guren-app', version: 2 }, null, 2)}\n`)
    await put(repo, MANIFEST, manifest('2.8.0'))
    await expect(assertCreateAppRepublishes(repo)).rejects.toThrow(/no readable version committed at HEAD/)
  })

  it('reports malformed committed JSON rather than throwing a raw SyntaxError', async () => {
    const repo = await repoAt('{ "name": "create-guren-app", oops\n')
    await put(repo, MANIFEST, manifest('2.8.0'))
    // The message has to be this refusal's, not the JSON parser's: an
    // unguarded parse aborts the release with no mention of which manifest or
    // why the comparison mattered.
    await expect(assertCreateAppRepublishes(repo)).rejects.toThrow(/no readable version committed at HEAD/)
  })

  it('refuses a working tree that lost its version', async () => {
    const repo = await repoAt(manifest('2.7.1'))
    await put(repo, MANIFEST, `${JSON.stringify({ name: 'create-guren-app' }, null, 2)}\n`)
    await expect(assertCreateAppRepublishes(repo)).rejects.toThrow(/no readable version in the working tree/)
  })

  it('names both sides when neither declares a version', async () => {
    const empty = `${JSON.stringify({ name: 'create-guren-app' }, null, 2)}\n`
    const repo = await repoAt(empty)
    await put(repo, MANIFEST, empty)
    await expect(assertCreateAppRepublishes(repo)).rejects.toThrow(
      /committed at HEAD and in the working tree/,
    )
  })

  it('skips, audibly, when there is no manifest at HEAD to compare against', async () => {
    // A scaffolder not yet committed leaves nothing to compare — that is an
    // absent comparison, not a broken one, so it warns and returns rather than
    // failing a release for a file git never had.
    const repo = join(scratch, `repo-${++repoCount}`)
    await mkdir(repo, { recursive: true })
    git(repo, 'init', '--quiet', '--initial-branch=main')
    await put(repo, 'README.md', 'no packages yet\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '--quiet', '-m', 'base')
    await put(repo, MANIFEST, manifest('2.8.0'))

    const warnings: string[] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => void warnings.push(args.join(' '))
    try {
      expect(await assertCreateAppRepublishes(repo)).toBeUndefined()
    } finally {
      console.warn = original
    }
    expect(warnings.join('\n')).toContain(MANIFEST)
  })
})
