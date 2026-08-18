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

function run(remote: string, ...args: string[]) {
  const proc = Bun.spawnSync(['bun', script, '--yes', ...args], {
    cwd: repoRoot,
    env: { ...process.env, GUREN_AGENT_SKILLS_REMOTE: remote },
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

  it('a re-run on the same version is a no-op success, not a failure', () => {
    const result = run(bare)
    expect(result.code).toBe(0)
    expect(result.out).toContain('already publishes')
    expect(result.out).not.toContain('Published:')
    const check = join(scratch, 'check2')
    Bun.spawnSync(['git', 'clone', '--quiet', bare, check])
    expect(git(check, 'rev-list', '--count', 'main')).toBe('2')
  })

  it('--dry-run against a stale remote shows the diff and pushes nothing', async () => {
    // rewind the remote to the seed commit so there is something to publish
    const rewind = join(scratch, 'rewind')
    Bun.spawnSync(['git', 'clone', '--quiet', bare, rewind])
    Bun.spawnSync(['git', 'reset', '--quiet', '--hard', 'HEAD~1'], { cwd: rewind })
    Bun.spawnSync(['git', 'push', '--quiet', '--force', 'origin', 'main'], { cwd: rewind })

    const result = run(bare, '--dry-run')
    expect(result.code).toBe(0)
    expect(result.out).toContain('--dry-run: not committing or pushing.')
    expect(result.out).toContain('files changed')
    const check = join(scratch, 'check3')
    Bun.spawnSync(['git', 'clone', '--quiet', bare, check])
    expect(git(check, 'rev-list', '--count', 'main')).toBe('1')
  })
})
