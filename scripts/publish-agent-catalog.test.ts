import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { diffPublished } from './build-agent-catalog.ts'
import { repoRoot } from './workspace-packages.ts'

/**
 * The publish script end to end, against a local bare repository standing in
 * for gurenjs/agent-skills. Three runs, three distinct outcomes the script
 * must tell apart: a first publish that writes the whole tree, a re-run on
 * the same version that is a no-op success (not a failure — most releases do
 * not move @guren/cli), and a re-run whose tree differs only in content
 * (same version) that still refuses to push a byte-identical tree.
 *
 * Kept as a scripts-level guard rather than a unit test because the script's
 * value is the git choreography — clone, replace tracked files, fast-forward
 * push — and that is not meaningfully testable without a real repository.
 */

const script = join(repoRoot, 'scripts', 'publish-agent-catalog.ts')

/**
 * A commit identity supplied by the test rather than by the machine. A CI
 * runner has no `user.email` and a hostname of `(none)`, so git cannot
 * auto-detect one and every commit the script makes would fail there while
 * passing on a maintainer's laptop.
 */
const gitIdentity = {
  GIT_AUTHOR_NAME: 'Guren publish test',
  GIT_AUTHOR_EMAIL: 'publish-test@guren.dev',
  GIT_COMMITTER_NAME: 'Guren publish test',
  GIT_COMMITTER_EMAIL: 'publish-test@guren.dev',
}

function run(remote: string, ...args: string[]) {
  return runWithEnv(remote, {}, ...args)
}

/**
 * The git choreography these tests are about, with the validator gate stood
 * down: `claude` is not on a CI runner's PATH and the script refuses to
 * publish when the validator cannot run. That refusal has its own test below,
 * so it is not a condition on all the others.
 */
function runWithEnv(remote: string, extraEnv: Record<string, string>, ...args: string[]) {
  return spawnPublish(remote, extraEnv, ['--yes', '--skip-validate', ...args])
}

function spawnPublish(remote: string, extraEnv: Record<string, string>, args: string[]) {
  // argv[0] is this bun, not whatever `bun` PATH resolves to, so a test may
  // hand the script a PATH that is missing tools without losing its runtime
  const proc = Bun.spawnSync([process.execPath, script, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...gitIdentity, GUREN_AGENT_SKILLS_REMOTE: remote, ...extraEnv },
  })
  return {
    code: proc.exitCode,
    out: (proc.stdout.toString() + proc.stderr.toString()).replace(/\[guren\/orm\][^\n]*\n/gu, ''),
  }
}

function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(['git', ...args], { cwd })
  return proc.stdout.toString().trim()
}

let bare: string
let scratch: string

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'guren-publish-test-'))
  bare = join(scratch, 'agent-skills.git')
  // a bare repo with one placeholder commit on main, like the real one had
  Bun.spawnSync(['git', 'init', '--quiet', '--bare', '--initial-branch=main', bare])
  const seed = join(scratch, 'seed')
  Bun.spawnSync(['git', 'clone', '--quiet', bare, seed])
  await Bun.write(join(seed, 'README.md'), 'placeholder\n')
  await Bun.write(join(seed, 'STALE.md'), 'a file the publish must remove\n')
  Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: seed })
  Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'seed'], { cwd: seed })
  Bun.spawnSync(['git', 'push', '--quiet', 'origin', 'main'], { cwd: seed })
})

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe('publish-agent-catalog', () => {
  it('refuses to publish when claude plugin validate could not run', () => {
    // a PATH with no `claude` on it: a CI runner, or a maintainer who has not
    // installed the CLI. Publish is the last gate before users, so an
    // unavailable validator refuses rather than warns — only --skip-validate
    // (which every other test here passes) overrides that. Runs before any
    // publish because it must not reach the remote at all.
    const result = spawnPublish(bare, { PATH: '/usr/bin:/bin' }, ['--yes'])
    expect(result.code).toBe(1)
    expect(result.out).toContain('claude plugin validate could not run')
    expect(result.out).toContain('--skip-validate')
    // it refused before cloning: the remote is still just the seed commit
    const check = join(scratch, 'check-refused')
    Bun.spawnSync(['git', 'clone', '--quiet', bare, check])
    expect(git(check, 'rev-list', '--count', 'main')).toBe('1')
  })

  it('first publish replaces the tracked tree and pushes a fast-forward commit', async () => {
    const result = run(bare)
    expect(result.code).toBe(0)
    expect(result.out).toContain('Publishing @guren/cli')
    expect(result.out).toContain('Published:')

    const check = join(scratch, 'check1')
    Bun.spawnSync(['git', 'clone', '--quiet', bare, check])
    const files = git(check, 'ls-files').split('\n').sort()
    expect(files).toContain('plugins/guren/plugin.json')
    expect(files).toContain('plugins/guren/skills/guren-new-app/SKILL.md')
    expect(files).toContain('.claude-plugin/marketplace.json')
    // the placeholder-era file the publish does not render is gone
    expect(files).not.toContain('STALE.md')
    // history is linear: seed + publish, no force
    expect(git(check, 'rev-list', '--count', 'main')).toBe('2')
    expect(git(check, 'log', '-1', '--format=%s')).toMatch(/^Publish @guren\/cli \d/u)
  })

  it('the drift check is green right after a publish and reports drift against a stale remote', async () => {
    // right after the first publish above, published == rendered
    const fresh = await diffPublished(bare)
    expect(fresh.code).toBe(0)
    // and against a remote that only has the seed, every file is missing
    const stale = join(scratch, 'stale.git')
    Bun.spawnSync(['git', 'clone', '--quiet', '--bare', bare, stale])
    Bun.spawnSync(['git', 'update-ref', 'refs/heads/main', 'main~1'], { cwd: stale })
    const drift = await diffPublished(stale)
    expect(drift.code).toBe(1)
    expect(drift.report).toContain('missing in published: plugins/guren/plugin.json')
    expect(drift.report).toContain('extra in published: STALE.md')
    // an unreachable remote is neither pass nor fail
    const gone = await diffPublished(join(scratch, 'does-not-exist.git'))
    expect(gone.code).toBe(2)
  })

  it('a second, higher version publishes over the populated tree without nesting directories', async () => {
    // the bug this pins: `cp -R plugins clone/plugins` nests into
    // clone/plugins/plugins/ when the destination already exists — which it
    // does on every publish after the first
    const result = runWithEnv(bare, { GUREN_CATALOG_VERSION_OVERRIDE: '99.0.0' })
    expect(result.code).toBe(0)
    expect(result.out).toContain('Publishing @guren/cli 99.0.0')
    expect(result.out).toContain('Published:')

    const check = join(scratch, 'check-v2')
    Bun.spawnSync(['git', 'clone', '--quiet', bare, check])
    const files = git(check, 'ls-files').split('\n').sort()
    expect(files.filter((f) => f.startsWith('plugins/plugins/'))).toEqual([])
    expect(files.filter((f) => f.startsWith('.claude-plugin/.claude-plugin/'))).toEqual([])
    expect(files).toContain('plugins/guren/plugin.json')
    const manifest = JSON.parse(await Bun.file(join(check, 'plugins/guren/plugin.json')).text())
    expect(manifest.version).toBe('99.0.0')
    // exactly the rendered set, nothing extra
    expect(files.length).toBe(10)
    expect(git(check, 'rev-list', '--count', 'main')).toBe('3')

    // and publish the real version back on top so later tests see it
    const back = run(bare)
    expect(back.code).toBe(0)
  })

  it('same version, different content republishes (a LICENSE or wording change), with a warning', async () => {
    // simulate a drifted publish: overwrite one published file, keep the version
    const drift = join(scratch, 'drift')
    Bun.spawnSync(['git', 'clone', '--quiet', bare, drift])
    await Bun.write(join(drift, 'README.md'), 'someone hand-edited this\n')
    Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-am', 'hand edit'], { cwd: drift })
    Bun.spawnSync(['git', 'push', '--quiet', 'origin', 'main'], { cwd: drift })

    const result = run(bare)
    expect(result.code).toBe(0)
    expect(result.out).toContain('already published but the tree differs; republishing')
    expect(result.out).toContain('Published:')
    const check = join(scratch, 'check-drift')
    Bun.spawnSync(['git', 'clone', '--quiet', bare, check])
    expect(await Bun.file(join(check, 'README.md')).text()).not.toContain('hand-edited')
  })

  it('a re-run on the same version is a no-op success, not a failure', () => {
    const result = run(bare)
    expect(result.code).toBe(0)
    expect(result.out).toContain('byte-identical to what is published; nothing to do')
    expect(result.out).not.toContain('Published:')
    const check = join(scratch, 'check2')
    Bun.spawnSync(['git', 'clone', '--quiet', bare, check])
    const before = git(check, 'rev-list', '--count', 'main')
    run(bare)
    const check2 = join(scratch, 'check2b')
    Bun.spawnSync(['git', 'clone', '--quiet', bare, check2])
    expect(git(check2, 'rev-list', '--count', 'main')).toBe(before)
  })

  it('--dry-run against a stale remote shows the diff and pushes nothing', async () => {
    // rewind the remote all the way to the seed commit so there is a full
    // publish's worth of diff to show
    const rewind = join(scratch, 'rewind')
    Bun.spawnSync(['git', 'clone', '--quiet', bare, rewind])
    const seedSha = git(rewind, 'rev-list', '--max-parents=0', 'main')
    Bun.spawnSync(['git', 'reset', '--quiet', '--hard', seedSha], { cwd: rewind })
    Bun.spawnSync(['git', 'push', '--quiet', '--force', 'origin', 'main'], { cwd: rewind })

    const result = run(bare, '--dry-run')
    expect(result.code).toBe(0)
    expect(result.out).toContain('--dry-run: not committing or pushing.')
    expect(result.out).toMatch(/\d+ files? changed/u)
    expect(result.out).toContain('plugins/guren/plugin.json')
    const check = join(scratch, 'check3')
    Bun.spawnSync(['git', 'clone', '--quiet', bare, check])
    expect(git(check, 'rev-list', '--count', 'main')).toBe('1')
  })
})
