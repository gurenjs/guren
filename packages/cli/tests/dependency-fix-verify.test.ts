import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DependencyFix, Packument, PackumentReader } from '../src/dependency-fix'
import { verifyFix, type LockfileResolver } from '../src/dependency-fix-verify'

const advisory = { package: 'leaf', ghsa: 'GHSA-AAAA-BBBB-CCCC', ranges: ['<1.2.0'] }
const proposal: DependencyFix = { status: 'candidate', steps: [{ kind: 'update', package: 'leaf', to: '1.2.0' }] }
const NOW = Date.parse('2026-11-04T00:00:00.000Z')

const lock = (version: string) => JSON.stringify({
  lockfileVersion: 1,
  workspaces: { '': { name: 'app', dependencies: { leaf: '^1.0.0' } } },
  packages: { leaf: [`leaf@${version}`, '', {}, 'sha512-a=='] },
})

const reader = (packuments: Record<string, Packument>): PackumentReader => async (name) => packuments[name] ?? null

describe('verifyFix', () => {
  let app: string

  beforeEach(async () => {
    app = await mkdtemp(join(tmpdir(), 'guren-fix-app-'))
    await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'app', dependencies: { leaf: '^1.0.0' } }))
    await writeFile(join(app, 'bun.lock'), lock('1.1.0'))
    await writeFile(join(app, 'bunfig.toml'), '[install]\nminimumReleaseAge = 259200\nminimumReleaseAgeExcludes = [\n  "@guren/core",\n]\n')
  })

  afterEach(async () => {
    await rm(app, { recursive: true, force: true })
  })

  it('verifies a fix whose resolution leaves no instance in range, resolving with the step applied', async () => {
    const seen: string[] = []
    const resolve: LockfileResolver = async (dir) => {
      seen.push(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).dependencies.leaf)
      await writeFile(join(dir, 'bun.lock'), lock('1.2.0'))
      return { exitCode: 0, stderr: '' }
    }

    const fix = await verifyFix({ cwd: app, workspace: '', advisory, fix: proposal, read: reader({}), resolve, now: NOW })

    expect(fix).toEqual({ status: 'verified', steps: proposal.steps })
    expect(seen).toEqual(['^1.2.0'])
  })

  it('adds a cooldown exclusion for each version the gate blocks, then resolves again', async () => {
    const bunfigs: string[] = []
    const resolve: LockfileResolver = async (dir) => {
      const bunfig = await readFile(join(dir, 'bunfig.toml'), 'utf8')
      bunfigs.push(bunfig)
      if (!bunfig.includes('"leaf@1.2.0"')) {
        return { exitCode: 1, stderr: 'error: No version matching "^1.2.0" found for specifier "leaf" (blocked by minimum-release-age: 259200 seconds)\n' }
      }
      await writeFile(join(dir, 'bun.lock'), lock('1.2.0'))
      return { exitCode: 0, stderr: '' }
    }
    const read = reader({ leaf: { versions: { '1.1.0': {}, '1.2.0': {} }, time: { '1.1.0': '2026-01-01T00:00:00.000Z', '1.2.0': '2026-11-03T00:00:00.000Z' } } })

    const fix = await verifyFix({ cwd: app, workspace: '', advisory, fix: proposal, read, resolve, now: NOW })

    expect(fix).toEqual({
      status: 'verified',
      steps: [...proposal.steps, { kind: 'cooldown-exclude', entry: 'leaf@1.2.0', publishedAt: '2026-11-03T00:00:00.000Z' }],
    })
    expect(bunfigs[1]).toContain('  "@guren/core",\n  "leaf@1.2.0",\n]')
  })

  it('stays a candidate, naming what still resolves, when the fix does not move the package', async () => {
    const resolve: LockfileResolver = async () => ({ exitCode: 0, stderr: '' })

    const fix = await verifyFix({ cwd: app, workspace: '', advisory, fix: proposal, read: reader({}), resolve, now: NOW })

    expect(fix).toEqual({ status: 'candidate', reason: 'bun install --lockfile-only still resolves leaf@1.1.0.', steps: proposal.steps })
  })

  it('stays a candidate on a resolution that fails for another reason, or in a workspace app', async () => {
    const failing: LockfileResolver = async () => ({ exitCode: 1, stderr: 'error: GET https://registry.npmjs.org/leaf - 503\n' })

    expect((await verifyFix({ cwd: app, workspace: '', advisory, fix: proposal, read: reader({}), resolve: failing, now: NOW })).reason)
      .toBe('bun install --lockfile-only failed: error: GET https://registry.npmjs.org/leaf - 503')
    expect((await verifyFix({ cwd: app, workspace: 'apps/web', advisory, fix: proposal, read: reader({}), resolve: failing, now: NOW })).reason)
      .toBe('The app shares a workspace lockfile, so the fix is checked only from the workspace root.')
  })

  it('stays a candidate when the resolved lockfile is only partly readable, even with no instance in range', async () => {
    const resolve: LockfileResolver = async (dir) => {
      await writeFile(join(dir, 'bun.lock'), JSON.stringify({
        lockfileVersion: 1,
        workspaces: { '': { name: 'app', dependencies: { top: '^1.0.0' } } },
        packages: { top: ['top@1.0.0', '', { dependencies: { leaf: '^1.0.0' } }, 'sha512-a=='] },
      }))
      return { exitCode: 0, stderr: '' }
    }

    const fix = await verifyFix({ cwd: app, workspace: '', advisory, fix: proposal, read: reader({}), resolve, now: NOW })

    expect(fix.status).toBe('candidate')
    expect(fix.reason).toContain('The resolved bun.lock reads partial')
  })

  it('refuses to rewrite a spec that is not a registry range, and to resolve without the lockfile', async () => {
    const resolve: LockfileResolver = async () => {
      throw new Error('must not resolve')
    }
    await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'app', dependencies: { leaf: 'npm:real-leaf@^1.0.0' } }))

    expect((await verifyFix({ cwd: app, workspace: '', advisory, fix: proposal, read: reader({}), resolve, now: NOW })).reason)
      .toBe('leaf is declared as npm:real-leaf@^1.0.0, not a registry range, so the check does not rewrite it.')

    await rm(join(app, 'bun.lock'))
    expect((await verifyFix({ cwd: app, workspace: '', advisory, fix: proposal, read: reader({}), resolve, now: NOW })).reason)
      .toBe('bun.lock could not be copied, so the fix was not resolved against the installed tree.')
  })

  it('starts no resolution round after the deadline', async () => {
    const resolve: LockfileResolver = async () => {
      throw new Error('must not resolve')
    }

    const fix = await verifyFix({ cwd: app, workspace: '', advisory, fix: proposal, read: reader({}), resolve, now: NOW, deadline: Date.now() - 1 })

    expect(fix).toEqual({ status: 'candidate', reason: 'The fix search ran out of its time budget before the resolution finished.', steps: proposal.steps })
  })

  it('keeps the caret or tilde of the declared range', async () => {
    const specs: string[] = []
    const resolve: LockfileResolver = async (dir) => {
      specs.push(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).dependencies.leaf)
      await writeFile(join(dir, 'bun.lock'), lock('1.2.0'))
      return { exitCode: 0, stderr: '' }
    }
    for (const declared of ['~1.1.0', '1.1.0']) {
      await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'app', dependencies: { leaf: declared } }))
      await verifyFix({ cwd: app, workspace: '', advisory, fix: proposal, read: reader({}), resolve, now: NOW })
    }

    expect(specs).toEqual(['~1.2.0', '1.2.0'])
  })

  it('writes an override into the copied manifest', async () => {
    let overrides: unknown
    const resolve: LockfileResolver = async (dir) => {
      overrides = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).overrides
      await writeFile(join(dir, 'bun.lock'), lock('1.2.0'))
      return { exitCode: 0, stderr: '' }
    }
    const override: DependencyFix = { status: 'candidate', steps: [{ kind: 'override', package: 'leaf', to: '1.2.0', note: 'n' }] }

    expect((await verifyFix({ cwd: app, workspace: '', advisory, fix: override, read: reader({}), resolve, now: NOW })).status).toBe('verified')
    expect(overrides).toEqual({ leaf: '1.2.0' })
  })
})
