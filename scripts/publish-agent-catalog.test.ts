import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { diffPublished } from './build-agent-catalog.ts'
import { isPublishRepo } from './publish-agent-catalog.ts'
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

/**
 * The git choreography these tests are about, with the validator gate stood
 * down: `claude` is not on a CI runner's PATH and the script refuses to
 * publish when the validator cannot run. That refusal has its own test below,
 * so it is not a condition on all the others.
 */
function run(remote: string, extraEnv: Record<string, string> = {}, ...args: string[]) {
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

/** A bare repo with one placeholder commit on main, like the real one had. */
async function seedRemote(name: string): Promise<string> {
  const remote = join(scratch, name)
  Bun.spawnSync(['git', 'init', '--quiet', '--bare', '--initial-branch=main', remote])
  const seed = join(scratch, `${name}-seed`)
  Bun.spawnSync(['git', 'clone', '--quiet', remote, seed])
  await Bun.write(join(seed, 'README.md'), 'placeholder\n')
  await Bun.write(join(seed, 'STALE.md'), 'a file the publish must remove\n')
  Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: seed })
  Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'seed'], { cwd: seed })
  Bun.spawnSync(['git', 'push', '--quiet', 'origin', 'main'], { cwd: seed })
  return remote
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'guren-publish-test-'))
  bare = await seedRemote('agent-skills.git')
})

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe('isPublishRepo', () => {
  // what decides whether a run is pointed at the public repository. Unit
  // tested because the guard that uses it cannot be mutation tested: making
  // it answer wrongly, with the override set, is a run that clones and
  // pushes to the real gurenjs/agent-skills.
  it('recognizes the real repository however it is addressed', () => {
    for (const remote of [
      'git@github.com:gurenjs/agent-skills.git',
      'https://github.com/gurenjs/agent-skills.git',
      'https://github.com/gurenjs/agent-skills',
      'ssh://git@github.com/GurenJS/Agent-Skills.git',
    ]) {
      expect(isPublishRepo(remote)).toBe(true)
    }
  })

  it('never mistakes a local path for it, however the path is spelled', () => {
    for (const remote of [
      '/tmp/gurenjs/agent-skills.git',
      './gurenjs/agent-skills.git',
      'file:///tmp/gurenjs/agent-skills.git',
      'git@github.com:gurenjs/agent-skills-fork.git',
      'https://example.com/gurenjs/agent-skills.git',
    ]) {
      expect(isPublishRepo(remote)).toBe(false)
    }
  })
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
    const result = run(bare, { GUREN_CATALOG_VERSION_OVERRIDE: '99.0.0' })
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

    // byte-only drift, the same-version case the drift job exists for: every
    // path is present and one file's contents differ
    const byteDrift = await diffPublished(bare)
    expect(byteDrift.code).toBe(1)
    expect(byteDrift.report).toContain('differs: README.md')
    expect(byteDrift.report).not.toContain('missing in published')

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

    const result = run(bare, {}, '--dry-run')
    expect(result.code).toBe(0)
    expect(result.out).toContain('--dry-run: not committing or pushing.')
    expect(result.out).toMatch(/\d+ files? changed/u)
    expect(result.out).toContain('plugins/guren/plugin.json')
    // the patch, not only the stat: a stat cannot show what the replacement
    // text of a same-version wording change actually says
    expect(result.out).toMatch(/^\+.*guren/mu)
    const check = join(scratch, 'check3')
    Bun.spawnSync(['git', 'clone', '--quiet', bare, check])
    expect(git(check, 'rev-list', '--count', 'main')).toBe('1')
  })

  it('a global gitignore cannot thin the published tree', async () => {
    // core.excludesFile applies inside the clone too, so a plain `git add -A`
    // stages whatever the maintainer's global ignores leave behind — a tree
    // that passed the audit as ten files and reaches users as six
    const remote = await seedRemote('excludes.git')
    const excludes = join(scratch, 'global-excludes')
    await Bun.write(excludes, '*.md\n')
    const result = run(remote, {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.excludesFile',
      GIT_CONFIG_VALUE_0: excludes,
    })

    expect(result.code).toBe(0)
    const check = join(scratch, 'check-excludes')
    Bun.spawnSync(['git', 'clone', '--quiet', remote, check])
    const files = git(check, 'ls-files').split('\n').sort()
    expect(files).toContain('plugins/guren/skills/guren-new-app/SKILL.md')
    expect(files).toContain('README.md')
    expect(files.length).toBe(10)
  })

  it('refuses to publish a tree a clean filter rewrote on its way into the index', async () => {
    // core.attributesFile is global too, and a clean filter rewrites bytes
    // between the tree that passed the audit and the tree that gets pushed
    const remote = await seedRemote('filtered.git')
    const attributes = join(scratch, 'global-attributes')
    await Bun.write(attributes, '*.md filter=upcase\n')
    const result = run(remote, {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.attributesFile',
      GIT_CONFIG_VALUE_0: attributes,
      GIT_CONFIG_KEY_1: 'filter.upcase.clean',
      GIT_CONFIG_VALUE_1: 'tr a-z A-Z',
    })

    expect(result.code).toBe(1)
    expect(result.out).toContain('the staged tree is not the tree that was audited')
    expect(result.out).toContain('staged bytes differ from the rendered bytes')
    const check = join(scratch, 'check-filtered')
    Bun.spawnSync(['git', 'clone', '--quiet', remote, check])
    expect(git(check, 'rev-list', '--count', 'main')).toBe('1')
  })

  it('refuses to push onto a remote that moved after this run cloned it', async () => {
    // the confirmation prompt is the one moment a test can move the remote
    // out from under a run that has already cloned it. A rollback is the
    // dangerous shape: the new commit is still a fast-forward from the
    // remote's rewound tip, so a plain push would restore exactly the history
    // somebody had just removed.
    const remote = await seedRemote('moved.git')
    expect(run(remote).code).toBe(0)
    const proc = Bun.spawn([process.execPath, script, '--skip-validate'], {
      cwd: repoRoot,
      env: { ...process.env, ...gitIdentity, GUREN_AGENT_SKILLS_REMOTE: remote, GUREN_CATALOG_VERSION_OVERRIDE: '99.0.0' },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const reader = proc.stdout.getReader()
    let seen = ''
    while (!seen.includes('Push this to')) {
      const { value, done } = await reader.read()
      if (done) break
      seen += new TextDecoder().decode(value)
    }
    reader.releaseLock()
    expect(seen).toContain('Push this to')

    // roll the remote back while the run waits for an answer
    const rewind = join(scratch, 'moved-rewind')
    Bun.spawnSync(['git', 'clone', '--quiet', remote, rewind])
    const seedSha = git(rewind, 'rev-list', '--max-parents=0', 'main')
    Bun.spawnSync(['git', 'reset', '--quiet', '--hard', seedSha], { cwd: rewind })
    Bun.spawnSync(['git', 'push', '--quiet', '--force', 'origin', 'main'], { cwd: rewind })

    proc.stdin.write('y\n')
    proc.stdin.end()
    const code = await proc.exited
    const out = seen + (await new Response(proc.stderr).text())

    expect(code).toBe(1)
    expect(out).toContain('the remote moved since this run cloned it')
    // the rollback stands: still one commit, not the restored history
    const check = join(scratch, 'check-moved')
    Bun.spawnSync(['git', 'clone', '--quiet', remote, check])
    expect(git(check, 'rev-list', '--count', 'main')).toBe('1')
  })

  it('runs no hook the maintainer has configured globally', async () => {
    // core.hooksPath is global, so it applies to this fresh clone too, and
    // its hooks run at the moments the provenance guarantee depends on:
    // post-checkout after the clone, pre-commit between the staged-tree check
    // and the tree that gets committed, post-commit before the push
    const hooks = join(scratch, 'global-hooks')
    await mkdir(hooks, { recursive: true })
    const marker = join(scratch, 'hook-ran')
    for (const hook of ['post-checkout', 'pre-commit', 'post-commit']) {
      await Bun.write(join(hooks, hook), `#!/bin/sh\necho ${hook} >> ${marker}\n`)
      await chmod(join(hooks, hook), 0o755)
    }
    const remote = await seedRemote('hooked.git')

    const result = run(remote, {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: hooks,
    })

    expect(result.code).toBe(0)
    expect(result.out).toContain('Published:')
    expect(await Bun.file(marker).exists()).toBe(false)
  })

  it('refuses the generator version override against the real remote', () => {
    // the override is a test hook. Left in a maintainer's environment it
    // would publish a version @guren/cli does not have, under the real name.
    // The remote is named rather than left empty: an empty one is falsy, so
    // it would also refuse under the older guard that only asked whether the
    // variable was set, and the test could not tell the two apart.
    const result = spawnPublish('https://github.com/gurenjs/agent-skills.git', { GUREN_CATALOG_VERSION_OVERRIDE: '99.0.0' }, [
      '--yes',
      '--skip-validate',
    ])

    expect(result.code).toBe(1)
    expect(result.out).toContain('GUREN_CATALOG_VERSION_OVERRIDE=99.0.0')
    // refused before it could reach the network at all
    expect(result.out).not.toContain('Could not clone')
  })

  it('allows the override against a local remote whose path merely reads like the real one', async () => {
    // the destination is decided by what the remote is, not by whether its
    // spelling contains the repository name: a bare repo under a directory
    // called gurenjs/agent-skills is a test remote
    await mkdir(join(scratch, 'gurenjs'), { recursive: true })
    const remote = await seedRemote(join('gurenjs', 'agent-skills.git'))
    const result = run(remote, { GUREN_CATALOG_VERSION_OVERRIDE: '99.0.0' })

    expect(result.code).toBe(0)
    expect(result.out).toContain('Publishing @guren/cli 99.0.0')
  })

  it('--skip-validate does not run the validator, rather than forgiving its verdict', async () => {
    // a `claude` on PATH that fails loudly if it is ever invoked. Without
    // --skip-validate the script would run it and refuse; with it, the
    // publish must not touch it at all.
    const bin = join(scratch, 'fake-bin')
    await mkdir(bin, { recursive: true })
    const marker = join(scratch, 'validator-was-run')
    await Bun.write(join(bin, 'claude'), `#!/bin/sh\ntouch ${marker}\necho 'validation failed' >&2\nexit 1\n`)
    await chmod(join(bin, 'claude'), 0o755)
    const remote = await seedRemote('skip-validate.git')

    const skipped = spawnPublish(remote, { PATH: `${bin}:${process.env.PATH ?? ''}` }, ['--yes', '--skip-validate'])
    expect(skipped.code).toBe(0)
    expect(await Bun.file(marker).exists()).toBe(false)

    // and without the flag the same fake validator refuses the publish
    const validated = spawnPublish(remote, { PATH: `${bin}:${process.env.PATH ?? ''}` }, ['--yes'])
    expect(validated.code).toBe(1)
    expect(validated.out).toContain('claude plugin validate --strict failed')
    expect(await Bun.file(marker).exists()).toBe(true)
  })
})
