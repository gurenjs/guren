import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describeStepWork } from '../src/plan-verify'
import type { PlanActiveStep, PlanStepRecord, PlanStepWork } from '../src/plan/state'
import { measureStepWork, readStepStart, stepWork, type PlanStepWorkReading } from '../src/plan/work'
import { createTempRoot, writeWorkspaceFiles } from './helpers'
import { measured } from './plan-fixture'

let ROOT: string

function git(dir: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

function commit(dir: string, message: string): string {
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', message)
  return git(dir, 'rev-parse', 'HEAD')
}

/** An application with a plan, committed: the commit `plan:next` would mark a step at. */
async function createRepo(name: string, files: Record<string, string> = {}): Promise<{ app: string; plan: string; start: string }> {
  const app = join(ROOT, name)
  await writeWorkspaceFiles(app, {
    'package.json': '{"name":"app"}\n',
    'src/a.ts': 'one\ntwo\nthree\n',
    'comments.plan.json': '{}\n',
    ...files,
  })
  git(app, 'init', '-q')
  return { app, plan: join(app, 'comments.plan.json'), start: commit(app, 'init') }
}

beforeAll(async () => {
  ROOT = await createTempRoot('guren-plan-work-')
})

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

describe('measureStepWork', () => {
  test('should count every commit since the start, uncommitted edits and untracked files, and nothing before the start', async () => {
    const { app, plan } = await createRepo('several-commits')
    await writeFile(join(app, 'src/a.ts'), 'one\ntwo\nthree\nfour\n', 'utf8')
    const start = commit(app, 'before the step')

    await writeWorkspaceFiles(app, { 'src/b.ts': 'b1\nb2\n' })
    commit(app, 'the step, first commit')
    await writeFile(join(app, 'src/a.ts'), 'one\nTWO\nthree\nfour\n', 'utf8')
    commit(app, 'the step, second commit')
    await writeFile(join(app, 'src/b.ts'), 'b1\nb2\nb3\n', 'utf8')
    await writeWorkspaceFiles(app, { 'src/c.ts': 'c1\nc2\nc3\nc4' })
    await writeFile(join(app, 'logo.png'), new Uint8Array([0x89, 0x50, 0x00, 0x01]))

    const work = measured(await measureStepWork(app, plan, start))

    expect(work.from).toBe(start)
    expect(work.files).toEqual([
      { path: 'logo.png', added: null, removed: null },
      { path: 'src/a.ts', added: 1, removed: 1 },
      { path: 'src/b.ts', added: 3, removed: 0 },
      { path: 'src/c.ts', added: 4, removed: 0 },
    ])
    expect([work.added, work.removed]).toEqual([8, 1])
    expect(describeStepWork({ ...work, settled: true })).toBe(`4 files (1 binary), +8 -1 since ${start.slice(0, 12)}`)
  })

  test('should measure nothing as a zero-file measurement, which is a measurement', async () => {
    const { app, plan, start } = await createRepo('nothing')

    expect(await measureStepWork(app, plan, start)).toEqual({ measured: true, from: start, files: [], added: 0, removed: 0 })
  })

  test('should leave out the plan and its records, .guren/, lockfiles and drizzle-kit snapshots, and count the migration SQL', async () => {
    const { app, plan, start } = await createRepo('exclusions', { '.guren/pages.gen.ts': 'export const pages = {}\n', 'bun.lock': '{}\n' })

    await writeWorkspaceFiles(app, {
      'comments.plan.json': '{"title":"edited"}\n',
      'comments.approvals.json': '{}\n',
      'comments.decisions.json': '{}\n',
      'comments.plan.html': '<html></html>\n',
      '.guren/pages.gen.ts': 'export const pages = { posts: {} }\n',
      '.guren/plans/.gitignore': 'x\n',
      'bun.lock': '{"changed":true}\n',
      'packages/web/package-lock.json': '{}\n',
      'db/migrations/20260924000000_comments/migration.sql': 'CREATE TABLE comments ();\n',
      'db/migrations/20260924000000_comments/snapshot.json': '{\n  "tables": {}\n}\n',
      'db/migrations/meta/_journal.json': '{}\n',
      'db/migrations/meta/0001_snapshot.json': '{}\n',
      'fixtures/snapshot.json': '{}\n',
    })

    const work = measured(await measureStepWork(app, plan, start))

    // A `snapshot.json` with no `migration.sql` beside it is not drizzle-kit's, so it counts.
    expect(work.files.map((file) => file.path)).toEqual(['db/migrations/20260924000000_comments/migration.sql', 'fixtures/snapshot.json'])
  })

  test('should keep a path git would quote, or one ending in a space, as the file is named, and count its lines', async () => {
    const names = ['src/back\\slash.ts', 'src/"quoted".ts', 'src/trailing .ts', 'src/tab\there.ts']
    const { app, plan, start } = await createRepo('odd-names', Object.fromEntries(names.map((name) => [name, 'one\n'])))
    await Promise.all(names.map((name) => writeFile(join(app, name), 'one\ntwo\n', 'utf8')))
    await writeWorkspaceFiles(app, Object.fromEntries(names.map((name) => [name.replace('src/', 'new/'), 'a\nb\nc\n'])))

    const work = measured(await measureStepWork(app, plan, start))

    const expected = [
      ...names.map((name) => ({ path: name, added: 1, removed: 0 })),
      ...names.map((name) => ({ path: name.replace('src/', 'new/'), added: 3, removed: 0 })),
    ].sort((a, b) => a.path.localeCompare(b.path))
    expect(work.files).toEqual(expected)
  })

  test('should count an untracked symlink as one line, as git does its target, and a large file without reading it whole', async () => {
    const { app, plan, start } = await createRepo('symlink-and-large')
    await symlink('a.ts', join(app, 'src/link.ts'))
    // Past one stream chunk (64 KiB), with no newline at the end: the last line still counts.
    await writeFile(join(app, 'src/large.ts'), `${'x'.repeat(99)}\n`.repeat(2000) + 'last', 'utf8')
    // A NUL past the 8000-byte probe does not make a file binary, as it does not for git.
    await writeFile(join(app, 'src/late-nul.ts'), `${'y'.repeat(9000)}\n\0\n`, 'utf8')

    const work = measured(await measureStepWork(app, plan, start))

    expect(work.files).toEqual([
      { path: 'src/large.ts', added: 2001, removed: 0 },
      { path: 'src/late-nul.ts', added: 2, removed: 0 },
      { path: 'src/link.ts', added: 1, removed: 0 },
    ])
  })

  test('should measure an application below the repository root in paths relative to it, and leave out work beside it', async () => {
    const repo = join(ROOT, 'monorepo')
    await writeWorkspaceFiles(repo, { 'apps/web/src/a.ts': 'a\n', 'apps/web/comments.plan.json': '{}\n', 'apps/api/src/b.ts': 'b\n' })
    git(repo, 'init', '-q')
    const start = commit(repo, 'init')
    await writeWorkspaceFiles(repo, { 'apps/web/src/a.ts': 'a\nb\n', 'apps/web/src/new.ts': 'n\n', 'apps/api/src/b.ts': 'b\nc\n', 'README.md': 'r\n' })

    const work = measured(await measureStepWork(join(repo, 'apps/web'), join(repo, 'apps/web/comments.plan.json'), start))

    expect(work.files).toEqual([
      { path: 'src/a.ts', added: 1, removed: 0 },
      { path: 'src/new.ts', added: 1, removed: 0 },
    ])
  })

  test('should say why instead of a number when the start is gone from the history, unknown, or there is no git repository', async () => {
    const { app, plan, start } = await createRepo('rewritten')
    await writeWorkspaceFiles(app, { 'src/a.ts': 'rewritten\n' })
    const marked = commit(app, 'the step')
    git(app, 'reset', '-q', '--hard', start)
    await writeWorkspaceFiles(app, { 'src/other.ts': 'o\n' })
    commit(app, 'history went another way')

    expect(await measureStepWork(app, plan, marked)).toEqual({
      measured: false,
      reason: `the commit the step started from (${marked.slice(0, 12)}) is no longer an ancestor of HEAD, so a diff would count work that is not the step's`,
    })
    expect(await measureStepWork(app, plan, 'f'.repeat(40))).toEqual({
      measured: false,
      reason: 'the commit the step started from (ffffffffffff) is not in this repository, or git could not be run',
    })

    const bare = join(ROOT, 'no-git')
    await writeWorkspaceFiles(bare, { 'comments.plan.json': '{}\n' })
    expect((await measureStepWork(bare, join(bare, 'comments.plan.json'), start)).measured).toBe(false)
  })
})

describe('readStepStart', () => {
  test('should name the commit HEAD names, detached or not, and nothing outside a repository or before a first commit', async () => {
    const { app, start } = await createRepo('start')
    expect(await readStepStart(app)).toBe(start)
    git(app, 'checkout', '-q', '--detach')
    expect(await readStepStart(app)).toBe(start)

    const empty = join(ROOT, 'empty-repo')
    await writeWorkspaceFiles(empty, { 'a.ts': 'a\n' })
    git(empty, 'init', '-q')
    expect(await readStepStart(empty)).toBeUndefined()
    const bare = join(ROOT, 'no-git-start')
    await writeWorkspaceFiles(bare, { 'a.ts': 'a\n' })
    expect(await readStepStart(bare)).toBeUndefined()
  })
})

describe('stepWork', () => {
  const STEP = 'task/entity/model.comment/http'
  const START = 'a'.repeat(40)
  const MARK: PlanActiveStep = { plan: 'comments.plan.json', step: STEP, startedAt: 't', continuations: 0, from: START }
  const IMPLEMENTED: PlanStepWork = { measured: true, from: 'a'.repeat(40), files: [{ path: 'src/a.ts', added: 40, removed: 2 }], added: 40, removed: 2, settled: true }
  const RECHECK: PlanStepWorkReading = { measured: true, from: 'b'.repeat(40), files: [{ path: 'routes/web.ts', added: 1, removed: 1 }], added: 1, removed: 1 }

  function record(outcome: PlanStepRecord['outcome'], work?: PlanStepWork): PlanStepRecord {
    return {
      outcome,
      planDigest: 'd',
      ranAt: 't',
      durationMs: 1,
      commands: [],
      acceptance: [],
      incomplete: [],
      waived: [],
      fingerprint: { files: {}, environment: { runtime: 'bun', platform: 'darwin', arch: 'arm64', hostname: 'h' } },
      ...(work ? { work } : {}),
    }
  }

  function measureFrom(reading: PlanStepWorkReading): { measure: (from: string) => Promise<PlanStepWorkReading>; starts: string[] } {
    const starts: string[] = []
    return { starts, measure: async (from) => (starts.push(from), reading) }
  }

  test('should measure the marked step from its mark while it is not verified, and settle the measurement once it is', async () => {
    const { settled: _settled, ...reading } = IMPLEMENTED
    const { measure, starts } = measureFrom(reading)
    const base = { stepId: STEP, planFile: 'comments.plan.json', active: MARK, measure }

    expect(await stepWork({ ...base, previous: undefined, outcome: 'incomplete' })).toMatchObject({ measured: true, added: 40, settled: false })
    const unsettled: PlanStepWork = { ...IMPLEMENTED, settled: false }
    expect(await stepWork({ ...base, previous: record('failed', unsettled), outcome: 'verified' })).toMatchObject({ measured: true, added: 40, settled: true })
    expect(starts).toEqual([START, START])
  })

  test('should keep the measurement taken when the step first verified through a re-check under a fresh mark, failed or verified', async () => {
    const { measure, starts } = measureFrom(RECHECK)
    const fresh: PlanActiveStep = { ...MARK, from: 'b'.repeat(40) }
    const base = { stepId: STEP, planFile: 'comments.plan.json', active: fresh, measure }

    const failedRecheck = await stepWork({ ...base, previous: record('verified', IMPLEMENTED), outcome: 'failed' })
    expect(failedRecheck).toEqual(IMPLEMENTED)
    expect(await stepWork({ ...base, previous: record('failed', failedRecheck), outcome: 'verified' })).toEqual(IMPLEMENTED)
    expect(starts).toEqual([])
  })

  test('should record a step no mark names as unmeasured rather than zero, and measure it once it is marked', async () => {
    const { measure } = measureFrom(RECHECK)
    const unmarked = await stepWork({ stepId: STEP, planFile: 'comments.plan.json', active: { ...MARK, step: 'another' }, previous: undefined, outcome: 'failed', measure })
    expect(unmarked).toEqual({ measured: false, reason: 'plan:next did not mark this step, so where its work started is not known', settled: false })
    // Another plan's mark on a step of the same id is not this step's.
    expect(await stepWork({ stepId: STEP, planFile: 'comments.plan.json', active: { ...MARK, plan: 'billing.plan.json' }, previous: undefined, outcome: 'verified', measure })).toMatchObject({ measured: false, settled: true })

    expect(await stepWork({ stepId: STEP, planFile: 'comments.plan.json', active: MARK, previous: record('failed', unmarked), outcome: 'failed', measure })).toMatchObject({ measured: true, settled: false })
  })

  test('should tell a mark whose HEAD git could not read from one written before marks recorded a start, and a record verified before the field existed', async () => {
    const { measure, starts } = measureFrom(RECHECK)
    const { from: _from, ...oldMark } = MARK
    expect(await stepWork({ stepId: STEP, planFile: 'comments.plan.json', active: oldMark, previous: undefined, outcome: 'failed', measure })).toEqual({
      measured: false,
      reason: 'plan:next marked this step before it recorded where work starts',
      settled: false,
    })
    expect(await stepWork({ stepId: STEP, planFile: 'comments.plan.json', active: { ...MARK, from: null }, previous: undefined, outcome: 'failed', measure })).toEqual({
      measured: false,
      reason: 'git could not read HEAD when plan:next marked the step',
      settled: false,
    })
    expect(await stepWork({ stepId: STEP, planFile: 'comments.plan.json', active: MARK, previous: record('verified'), outcome: 'verified', measure })).toEqual({
      measured: false,
      reason: 'the step verified before files touched and lines changed were recorded',
      settled: true,
    })
    expect(starts).toEqual([])
  })
})
