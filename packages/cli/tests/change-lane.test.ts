import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { runCommand } from 'citty'

import { judgeChangeLane, type ChangeLaneReport, type JudgeChangeLaneOptions } from '../src/change/lane'
import { changeAdvisories } from '../src/change/revision-advisories'
import { openChange, resolveChange } from '../src/change/resolve'
import type { ChangeAudits } from '../src/change/revision-audit'
import { SECURITY_RECORD_VERSION, type RouteSecurityRecord, type SecurityRecordPair } from '../src/change/security-records'
import { builtinSubCommands } from '../src/commands'
import { renderChangeLane } from '../src/commands/change'
import { providerFile } from '../src/make-provider'
import { createTempRoot, PG_SCHEMA_FIXTURE } from './helpers'
import { approvePlanFile, loadApprovedCommentsPlan, loadCommentsPlan } from './plan-fixture'

const ROOT_PREFIX = 'guren-change-lane-'
let ROOT: string
let repos = 0

beforeAll(async () => {
  ROOT = await createTempRoot(ROOT_PREFIX)
})

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed with code ${code}: ${stderr}`)
  return stdout.trim()
}

/** Writes the files (`null` deletes one), commits, and returns the commit's SHA. */
async function commit(repo: string, files: Record<string, string | null>): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      await rm(join(repo, path))
      continue
    }
    await mkdir(dirname(join(repo, path)), { recursive: true })
    await writeFile(join(repo, path), content, 'utf8')
  }
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '--allow-empty', '-m', 'change'])
  return git(repo, ['rev-parse', 'HEAD'])
}

const POLICY = (abilities: string[]): string => `import { Policy } from '@guren/core'

export class PostPolicy extends Policy {
${abilities.map((name) => `  ${name}() {\n    return true\n  }`).join('\n')}
}
`

const BASE_FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'app', scripts: { test: 'bun test', lint: 'oxlint -c lint/rules.json' }, dependencies: { zod: '^4.0.0' } }, null, 2),
  'lint/rules.json': '{}',
  'README.md': '# app\n',
  'docs/guide.md': 'A guide.\n',
  'db/schema.ts': PG_SCHEMA_FIXTURE,
  'db/migrations/0001_users/migration.sql': 'CREATE TABLE "users" ("id" serial PRIMARY KEY);\n',
  'app/Policies/PostPolicy.ts': POLICY(['view', 'update']),
  'app/Http/Controllers/PostController.ts': 'export class PostController {}\n',
  'tests/posts.test.ts': "test('[AC-posts-1] lists posts', () => {})\n",
  'tests/helpers.test.ts': "test('adds', () => {})\n",
  'tests/browser/generated/smoke.browser.ts': '// generated\n',
}

async function createRepo(files: Record<string, string> = BASE_FILES): Promise<{ repo: string; base: string }> {
  const repo = join(ROOT, `repo-${repos++}`)
  await mkdir(repo, { recursive: true })
  await git(repo, ['init', '--initial-branch=main'])
  await git(repo, ['config', 'user.email', 'test@example.com'])
  await git(repo, ['config', 'user.name', 'Test'])
  return { repo, base: await commit(repo, files) }
}

async function laneOf(cwd: string, base: string, head: string): Promise<ChangeLaneReport> {
  const change = await resolveChange(cwd, base, head)
  const { reader, dispose } = openChange(cwd, change)
  try {
    return await judgeChangeLane(change, reader)
  } finally {
    await dispose()
  }
}

/** The report of one commit on top of the base fixture. */
async function laneAfter(files: Record<string, string | null>): Promise<ChangeLaneReport> {
  const { repo, base } = await createRepo()
  return laneOf(repo, base, await commit(repo, files))
}

const codes = (report: ChangeLaneReport): string[] => report.facts.map((fact) => fact.code).sort()
const factAt = (report: ChangeLaneReport, code: string) => report.facts.find((fact) => fact.code === code)

describe('resolveChange', () => {
  test('should refuse a base that is not a SHA', async () => {
    const { repo, base } = await createRepo()
    await expect(resolveChange(repo, 'main', base)).rejects.toThrow('takes a commit SHA')
  })

  test('should refuse a commit the clone does not have', async () => {
    const { repo, base } = await createRepo()
    await expect(resolveChange(repo, base, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).rejects.toThrow('is not in this clone')
  })

  test('should refuse a ref whose name reads as a SHA', async () => {
    const { repo, base } = await createRepo()
    await git(repo, ['branch', 'deadbeef1'])
    await expect(resolveChange(repo, 'deadbeef1', base)).rejects.toThrow('is not in this clone')
  })

  test('should refuse two commits that share no history', async () => {
    const { repo, base } = await createRepo()
    await git(repo, ['checkout', '--orphan', 'other'])
    const orphan = await commit(repo, { 'README.md': '# other\n' })
    await expect(resolveChange(repo, base, orphan)).rejects.toThrow('share no history')
  })

  test('should return each path with its status and a rename with its old path', async () => {
    const { repo, base } = await createRepo()
    await git(repo, ['mv', 'docs/guide.md', 'docs/handbook.md'])
    const head = await commit(repo, { 'README.md': '# renamed app\n', 'lint/rules.json': null, 'app/Models/Post.ts': 'export class Post {}\n' })

    const change = await resolveChange(repo, base.slice(0, 12), head)

    expect(change.base).toBe(base)
    expect(change.mergeBase).toBe(base)
    expect(change.paths.sort((a, b) => (a.path < b.path ? -1 : 1))).toEqual([
      { path: 'README.md', status: 'modified' },
      { path: 'app/Models/Post.ts', status: 'added' },
      { path: 'docs/handbook.md', status: 'renamed', oldPath: 'docs/guide.md' },
      { path: 'lint/rules.json', status: 'deleted' },
    ])
  })

  test('should read from the merge base, leaving out what only the base branch changed', async () => {
    const { repo, base } = await createRepo()
    await git(repo, ['checkout', '-b', 'feature'])
    const head = await commit(repo, { 'app/Models/Post.ts': 'export class Post {}\n' })
    await git(repo, ['checkout', 'main'])
    const moved = await commit(repo, { 'README.md': '# moved on\n' })

    const change = await resolveChange(repo, moved, head)

    expect(change.mergeBase).toBe(base)
    expect(change.paths).toEqual([{ path: 'app/Models/Post.ts', status: 'added' }])
  })

  test('should keep an application directory named with a leading space', async () => {
    const { repo, base } = await createRepo({ ' web/app/Policies/PostPolicy.ts': POLICY(['view']) })
    const head = await commit(repo, { ' web/app/Policies/PostPolicy.ts': null })

    const report = await laneOf(join(repo, ' web'), base, head)

    expect(report.facts).toEqual([expect.objectContaining({ code: 'policy-removed', lane: 'high', files: ['app/Policies/PostPolicy.ts'] })])
  })

  test('should mark a path outside the application root and keep the rest app-relative', async () => {
    const { repo, base } = await createRepo({ 'apps/web/package.json': '{}', '.github/workflows/ci.yml': 'on: push\n', 'notes.txt': 'a\n' })
    const head = await commit(repo, { 'apps/web/app/Models/Post.ts': 'export class Post {}\n', '.github/workflows/ci.yml': 'on: pull_request\n', 'notes.txt': 'b\n' })

    const report = await laneOf(join(repo, 'apps/web'), base, head)

    expect(report.facts.map((fact) => [fact.code, fact.lane, fact.files])).toEqual([
      ['gate-input', 'high', ['.github/workflows/ci.yml']],
      ['outside-app', 'medium', ['notes.txt']],
      ['file-added', 'medium', ['app/Models/Post.ts']],
    ])
  })
})

const SUBDIRECTORY_APP: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'root', scripts: { test: 'bun run --cwd apps/web test' } }),
  'bun.lock': '{}',
  'apps/web/package.json': JSON.stringify({ name: 'web', scripts: { test: 'bun test' } }),
  'apps/web/db/migrations/0001_users/migration.sql': 'CREATE TABLE "users" ("id" serial PRIMARY KEY);\n',
  'apps/web/tests/posts.test.ts': "test('[AC-posts-1] lists posts', () => {})\n",
}

describe('openChange', () => {
  test("should answer whether the newest commit on the merge base's history adding a record had a path", async () => {
    const { repo } = await createRepo(SUBDIRECTORY_APP)
    await commit(repo, { 'apps/web/docs/plans/comments/approvals.json': '{}\n' })
    const added = await commit(repo, { 'apps/web/app/Models/Comment.ts': 'export class Comment {}\n', 'apps/web/later.approvals.json': '{}\n' })
    const head = await commit(repo, { 'apps/web/app/Models/Comment.ts': 'export class Comment { body = 1 }\n', 'apps/web/head.approvals.json': '{}\n' })
    const cwd = join(repo, 'apps/web')
    const { reader } = openChange(cwd, await resolveChange(cwd, added, head))

    expect(await reader.presentWhenAdded('docs/plans/comments/approvals.json', 'app/Models/Comment.ts')).toBe(false)
    expect(await reader.presentWhenAdded('docs/plans/comments/approvals.json', 'package.json')).toBe(true)
    expect(await reader.presentWhenAdded('later.approvals.json', 'app/Models/Comment.ts')).toBe(true)
    // Added only after the merge base, or never: no answer.
    expect(await reader.presentWhenAdded('head.approvals.json', 'app/Models/Comment.ts')).toBeUndefined()
    expect(await reader.presentWhenAdded('none.approvals.json', 'app/Models/Comment.ts')).toBeUndefined()
  })

  test('should give no cut-off at a shallow boundary, where every inherited file reads as added', async () => {
    const { repo } = await createRepo(SUBDIRECTORY_APP)
    await commit(repo, { 'apps/web/docs/plans/comments/approvals.json': '{}\n' })
    const added = await commit(repo, { 'apps/web/app/Models/Comment.ts': 'export class Comment {}\n' })
    const head = await commit(repo, { 'apps/web/app/Models/Comment.ts': 'export class Comment { body = 1 }\n' })
    const shallow = join(ROOT, `repo-${repos++}`)
    await git(ROOT, ['clone', '-q', '--depth', '2', `file://${repo}`, shallow])
    const cwd = join(shallow, 'apps/web')
    const { reader } = openChange(cwd, await resolveChange(cwd, added, head))

    expect(await reader.presentWhenAdded('docs/plans/comments/approvals.json', 'app/Models/Comment.ts')).toBeUndefined()
  })

  test('should throw on a file the commit has and git cannot read, rather than read it as absent', async () => {
    const { repo, base } = await createRepo()
    const blob = await git(repo, ['rev-parse', `${base}:package.json`])
    await rm(join(repo, '.git/objects', blob.slice(0, 2), blob.slice(2)))
    const change = await resolveChange(repo, base, base)
    const { reader } = openChange(repo, change)

    await expect(reader.read('base', 'package.json')).rejects.toThrow('git could not read package.json')
    expect(await reader.read('base', 'no/such/file.ts')).toBeNull()
  })

  test('should read an application below the repository root the same under diff.relative and grep.fullName', async () => {
    const { repo, base } = await createRepo(SUBDIRECTORY_APP)
    await git(repo, ['config', 'diff.relative', 'true'])
    await git(repo, ['config', 'grep.fullName', 'true'])
    const head = await commit(repo, {
      'apps/web/db/migrations/0002_drop/migration.sql': 'DROP TABLE "users";\n',
      'apps/web/tests/posts-again.test.ts': "test('[AC-posts-1] lists posts', () => {})\n",
    })

    const report = await laneOf(join(repo, 'apps/web'), base, head)

    expect(report.facts.map((fact) => [fact.code, fact.lane, fact.files])).toEqual([
      ['migration-destructive', 'high', ['db/migrations/0002_drop/migration.sql']],
      ['acceptance-added', 'medium', ['tests/posts-again.test.ts']],
    ])
  })
})

describe('judgeChangeLane', () => {
  test('should put a documentation-only change in the low lane', async () => {
    const report = await laneAfter({ 'docs/guide.md': 'A longer guide.\n', 'docs/more.md': 'More.\n' })

    expect(report.floor).toBe('low')
    expect(report.facts).toEqual([{ code: 'ambient', lane: 'low', target: 'documentation', evidence: 'path', message: '2 files: documentation', files: ['docs/guide.md', 'docs/more.md'] }])
    expect(report.unjudged).toEqual([])
  })

  test('should report an empty change as low with no fact', async () => {
    const { repo, base } = await createRepo()
    const report = await laneOf(repo, base, base)

    expect(report).toMatchObject({ schemaVersion: 1, base, mergeBase: base, head: base, floor: 'low', facts: [], unjudged: [], plans: [] })
  })

  test('should call a rewritten package.json script a gate input', async () => {
    const report = await laneAfter({ 'package.json': JSON.stringify({ name: 'app', scripts: { test: 'true', lint: 'oxlint -c lint/rules.json' }, dependencies: { zod: '^4.0.0' } }, null, 2) })

    expect(report.floor).toBe('high')
    expect(factAt(report, 'gate-input')).toMatchObject({ lane: 'high', target: 'package.json scripts', message: 'scripts changed: test' })
    expect(codes(report)).toEqual(['gate-input'])
  })

  test('should call a file a script names a gate input', async () => {
    const report = await laneAfter({ 'lint/rules.json': '{"rules":{}}' })

    expect(factAt(report, 'gate-input')?.message).toContain('a package.json script names it')
  })

  test('should find a file a script names behind a separator or a directory it enters', async () => {
    const scripts = { a: 'bun tools/a.ts; bun tools/b.ts', c: 'cd tools && bun c.ts', d: '(bun tools/d.ts)', e: 'bun tools/e.ts|tee log' }
    const tools = (body: string): Record<string, string> => Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'unnamed'].map((name) => [`tools/${name}.ts`, body]))
    const { repo, base } = await createRepo({ 'package.json': JSON.stringify({ scripts }), ...tools('export {}\n') })

    const report = await laneOf(repo, base, await commit(repo, tools('export const edited = true\n')))

    expect(report.facts.map((fact) => [fact.code, fact.files[0]])).toEqual([
      ['gate-input', 'tools/a.ts'], ['gate-input', 'tools/b.ts'], ['gate-input', 'tools/c.ts'], ['gate-input', 'tools/d.ts'], ['gate-input', 'tools/e.ts'], ['source-edited', 'tools/unnamed.ts'],
    ])
  })

  test('should find a file a script names in quotes or behind two cds', async () => {
    const scripts = { check: 'bun "tools/my check.ts"', deep: 'cd tools && cd checks && bun check.ts' }
    const files = (body: string): Record<string, string> => ({ 'tools/my check.ts': body, 'tools/checks/check.ts': body })
    const { repo, base } = await createRepo({ 'package.json': JSON.stringify({ scripts }), ...files('export {}\n') })

    const report = await laneOf(repo, base, await commit(repo, files('export const edited = true\n')))

    expect(report.facts.map((fact) => [fact.code, fact.files[0]])).toEqual([['gate-input', 'tools/checks/check.ts'], ['gate-input', 'tools/my check.ts']])
  })

  test('should call scripts that left the root package.json with a rename a gate input', async () => {
    const { repo, base } = await createRepo()
    await mkdir(join(repo, 'pkg'))
    await git(repo, ['mv', 'package.json', 'pkg/package.json'])
    const report = await laneOf(repo, base, await commit(repo, {}))

    expect(factAt(report, 'gate-input')).toMatchObject({ target: 'package.json scripts', message: 'scripts changed: test, lint', files: ['pkg/package.json'] })
  })

  test('should read the scripts and the lockfile of a repository root above the application', async () => {
    const { repo, base } = await createRepo(SUBDIRECTORY_APP)
    const head = await commit(repo, { 'package.json': JSON.stringify({ name: 'root', scripts: { test: 'true' } }), 'bun.lock': '{ "changed": true }' })

    const report = await laneOf(join(repo, 'apps/web'), base, head)

    expect(report.facts.map((fact) => [fact.code, fact.lane, fact.files])).toEqual([
      ['gate-input', 'high', ['package.json']],
      ['dependencies-changed', 'medium', ['bun.lock']],
    ])
    expect(report.unjudged.map((entry) => entry.reader)).toEqual(['audit', 'dependency-advisory'])
  })

  test('should read the scripts of a package a root script enters with --cwd', async () => {
    const { repo, base } = await createRepo(SUBDIRECTORY_APP)
    const head = await commit(repo, { 'apps/web/package.json': JSON.stringify({ name: 'web', scripts: { test: 'true' } }) })

    const report = await laneOf(repo, base, head)

    expect(factAt(report, 'gate-input')).toMatchObject({ target: 'package.json scripts', files: ['apps/web/package.json'] })
  })

  test('should report changed dependencies and that their advisories were not read', async () => {
    const report = await laneAfter({ 'package.json': JSON.stringify({ name: 'app', scripts: { test: 'bun test', lint: 'oxlint -c lint/rules.json' }, dependencies: { zod: '^4.1.0' } }, null, 2), 'bun.lock': '{}' })

    expect(codes(report)).toEqual(['dependencies-changed', 'dependencies-changed'])
    expect(report.unjudged.map((entry) => entry.reader)).toContain('dependency-advisory')
    expect(report.floor).toBe('medium')
  })

  test('should raise an advisory the head has and the base does not, and say why when none could be read', async () => {
    const { repo, base } = await createRepo()
    const head = await commit(repo, { 'package.json': JSON.stringify({ name: 'app', scripts: { test: 'bun test', lint: 'oxlint -c lint/rules.json' }, dependencies: { zod: '^4.1.0', minimist: '1.2.0' } }, null, 2), 'bun.lock': '{}' })
    const judged = async (advisories: NonNullable<JudgeChangeLaneOptions['advisories']>): Promise<ChangeLaneReport> => {
      const change = await resolveChange(repo, base, head)
      const { reader, dispose } = openChange(repo, change)
      try {
        return await judgeChangeLane(change, reader, { advisories })
      } finally {
        await dispose()
      }
    }

    const raised = await judged(async (files) => [{ directory: '', files: files.map((entry) => entry.file), base: ['deps:zod:GHSA-aaaa-bbbb-cccc'], head: ['deps:minimist:GHSA-xvch-5gv4-984h', 'deps:zod:GHSA-aaaa-bbbb-cccc'] }])
    expect(raised.facts.filter((fact) => fact.code === 'dependency-advisory')).toEqual([
      expect.objectContaining({ lane: 'high', target: 'minimist:GHSA-xvch-5gv4-984h', files: ['package.json', 'bun.lock'] }),
    ])
    expect(raised.floor).toBe('high')
    expect(raised.unjudged.map((entry) => entry.reader)).not.toContain('dependency-advisory')

    const unread = await judged(async (files) => [{ directory: '', files: files.map((entry) => entry.file), unavailable: 'Dependencies could not be scanned (bun audit exited with code 2).' }])
    expect(unread.unjudged).toContainEqual(expect.objectContaining({ reader: 'dependency-advisory', lane: 'medium', reason: expect.stringContaining('bun audit exited with code 2') }))
    expect(unread.facts.some((fact) => fact.code === 'dependency-advisory')).toBe(false)
  })

  test('should not run bun audit for a change that touches no dependency', async () => {
    let asked = false
    const { repo, base } = await createRepo()
    const change = await resolveChange(repo, base, await commit(repo, { 'README.md': '# app, again\n' }))
    const { reader, dispose } = openChange(repo, change)
    try {
      await judgeChangeLane(change, reader, { advisories: async () => { asked = true; return [] } })
    } finally {
      await dispose()
    }
    expect(asked).toBe(false)
  })

  describe('changeAdvisories', () => {
    const MANIFEST = (deps: Record<string, string>): string => JSON.stringify({ name: 'app', dependencies: deps })
    const LOCK = (version: string): string => `{ "packages": { "minimist": ["minimist@${version}"] } }\n`
    // Stands in for `bun audit --json`: an advisory for the old minimist, nothing for the patched one, and nothing for a registry named evil.
    // `bunfig.toml` with `production` hides dev dependencies, and a lock naming `@private/` makes bun warn of a registry it skipped.
    const scan = async (directory: string) => {
      const lock = await Bun.file(join(directory, 'bun.lock')).text()
      const npmrc = await Bun.file(join(directory, '.npmrc')).text().catch(() => '')
      const bunfig = await Bun.file(join(directory, 'bunfig.toml')).text().catch(() => '')
      if (lock.includes('@private/')) return { stdout: '{}', stderr: 'warn: skipped @private: the registry returned 404\n', exitCode: 0 }
      const vulnerable = lock.includes('minimist@1.2.0') && !npmrc.includes('evil') && !bunfig.includes('production')
      return { stdout: vulnerable ? JSON.stringify({ minimist: [{ url: 'https://github.com/advisories/GHSA-xvch-5gv4-984h', title: 'Prototype Pollution', severity: 'critical', vulnerable_versions: '<1.2.6' }] }) : '{}', stderr: '', exitCode: vulnerable ? 1 : 0 }
    }
    async function laneWith(baseFiles: Record<string, string>, headFiles: Record<string, string | null>): Promise<ChangeLaneReport> {
      const { repo, base } = await createRepo({ 'README.md': '# app\n', ...baseFiles })
      const change = await resolveChange(repo, base, await commit(repo, headFiles))
      const { reader, dispose } = openChange(repo, change)
      try {
        return await judgeChangeLane(change, reader, { advisories: (files) => changeAdvisories(repo, change, files, { scan }) })
      } finally {
        await dispose()
      }
    }
    const advisoryFacts = (report: ChangeLaneReport) => report.facts.filter((fact) => fact.code === 'dependency-advisory').map(({ target, files }) => [target, files])
    const advisoryUnjudged = (report: ChangeLaneReport) => report.unjudged.filter((entry) => entry.reader === 'dependency-advisory').map(({ reason, files }) => [reason, files])

    test('should raise what the change brings in and nothing for what it fixes', async () => {
      const worse = await laneWith({ 'package.json': MANIFEST({ minimist: '1.2.8' }), 'bun.lock': LOCK('1.2.8') }, { 'package.json': MANIFEST({ minimist: '1.2.0' }), 'bun.lock': LOCK('1.2.0') })
      const better = await laneWith({ 'package.json': MANIFEST({ minimist: '1.2.0' }), 'bun.lock': LOCK('1.2.0') }, { 'package.json': MANIFEST({ minimist: '1.2.8' }), 'bun.lock': LOCK('1.2.8') })

      expect(advisoryFacts(worse)).toEqual([['minimist:GHSA-XVCH-5GV4-984H', ['package.json', 'bun.lock']]])
      expect(advisoryFacts(better)).toEqual([])
      expect(advisoryUnjudged(better)).toEqual([])
    })

    test('should scan the lockfile that governs each changed file, not the application\'s alone', async () => {
      const report = await laneWith(
        { 'package.json': MANIFEST({}), 'bun.lock': LOCK('1.2.8'), 'tools/site/package.json': MANIFEST({ minimist: '1.2.8' }), 'tools/site/bun.lock': LOCK('1.2.8') },
        { 'tools/site/package.json': MANIFEST({ minimist: '1.2.0' }), 'tools/site/bun.lock': LOCK('1.2.0') },
      )

      expect(advisoryFacts(report)).toEqual([['minimist:GHSA-XVCH-5GV4-984H', ['tools/site/package.json', 'tools/site/bun.lock']]])
    })

    test('should not judge a manifest whose lockfile did not change, a binary lockfile, or a base with dependencies and no lockfile', async () => {
      const stale = await laneWith({ 'package.json': MANIFEST({}), 'bun.lock': LOCK('1.2.8') }, { 'package.json': MANIFEST({ minimist: '1.2.0' }) })
      const binary = await laneWith({ 'package.json': MANIFEST({}), 'bun.lockb': 'binary' }, { 'package.json': MANIFEST({ minimist: '1.2.0' }), 'bun.lockb': 'binary, changed' })
      const unlocked = await laneWith({ 'package.json': MANIFEST({ minimist: '1.2.0' }) }, { 'package.json': MANIFEST({ minimist: '1.2.0', zod: '^4.0.0' }), 'bun.lock': LOCK('1.2.0') })
      const fresh = await laneWith({ 'package.json': MANIFEST({}) }, { 'package.json': MANIFEST({ minimist: '1.2.0' }), 'bun.lock': LOCK('1.2.0') })

      expect(advisoryUnjudged(stale)).toEqual([[expect.stringContaining('bun.lock did not'), ['package.json']]])
      expect(advisoryUnjudged(binary)).toEqual([[expect.stringContaining('bun.lockb is binary'), ['package.json', 'bun.lockb']]])
      expect(advisoryUnjudged(unlocked)).toEqual([[expect.stringContaining('the base declares dependencies in package.json and no bun.lock governs it'), ['package.json', 'bun.lock']]])
      expect(advisoryFacts(fresh)).toEqual([['minimist:GHSA-XVCH-5GV4-984H', ['package.json', 'bun.lock']]])
    })

    test('should scan the root\'s lockfile and the application\'s apart when their files share a name', async () => {
      const { repo, base } = await createRepo({
        'package.json': MANIFEST({ minimist: '1.2.8' }), 'bun.lock': LOCK('1.2.8'),
        'apps/web/package.json': MANIFEST({}), 'apps/web/bun.lock': '{ "packages": {} }\n',
      })
      const head = await commit(repo, { 'package.json': MANIFEST({ minimist: '1.2.0' }), 'bun.lock': LOCK('1.2.0'), 'apps/web/package.json': MANIFEST({ zod: '^4.0.0' }), 'apps/web/bun.lock': '{ "packages": { "zod": ["zod@4.0.0"] } }\n' })
      const app = join(repo, 'apps/web')
      const change = await resolveChange(app, base, head)
      const { reader, dispose } = openChange(app, change)
      try {
        const report = await judgeChangeLane(change, reader, { advisories: (files) => changeAdvisories(app, change, files, { scan }) })
        expect(advisoryFacts(report)).toEqual([['minimist:GHSA-XVCH-5GV4-984H', ['package.json', 'bun.lock']]])
        expect(advisoryUnjudged(report)).toEqual([])
      } finally {
        await dispose()
      }
    })

    test('should not read a workspace root with no lockfile at the base as one with no advisories', async () => {
      const report = await laneWith(
        { 'package.json': JSON.stringify({ name: 'app', workspaces: ['packages/*'] }), 'packages/a/package.json': MANIFEST({ minimist: '1.2.0' }) },
        { 'bun.lock': LOCK('1.2.0'), 'packages/a/package.json': MANIFEST({ minimist: '1.2.0', zod: '^4.0.0' }) },
      )

      expect(advisoryFacts(report)).toEqual([])
      expect(advisoryUnjudged(report)).toEqual([[expect.stringContaining('the base declares dependencies in packages/a/package.json and no bun.lock governs it'), ['packages/a/package.json', 'bun.lock']]])
    })

    test('should leave bunfig.toml out of the scan, and not judge a report bun audit warned it left packages out of', async () => {
      const production = await laneWith(
        { 'package.json': MANIFEST({}), 'bun.lock': LOCK('1.2.8'), 'bunfig.toml': '[install]\nproduction = true\n' },
        { 'package.json': JSON.stringify({ name: 'app', devDependencies: { minimist: '1.2.0' } }), 'bun.lock': LOCK('1.2.0') },
      )
      const skipped = await laneWith(
        { 'package.json': MANIFEST({}), 'bun.lock': LOCK('1.2.8') },
        { 'package.json': MANIFEST({ '@private/lib': '1.0.0' }), 'bun.lock': '{ "packages": { "@private/lib": ["@private/lib@1.0.0"] } }\n' },
      )

      expect(advisoryFacts(production)).toEqual([['minimist:GHSA-XVCH-5GV4-984H', ['package.json', 'bun.lock']]])
      expect(advisoryUnjudged(skipped)).toEqual([[expect.stringContaining('warned on the head'), ['package.json', 'bun.lock']]])
    })

    test('should read a renamed package from where it was, and a lockfile another fact claimed', async () => {
      const renamed = await laneWith(
        { 'tools/a/package.json': MANIFEST({ minimist: '1.2.0' }), 'tools/a/bun.lock': LOCK('1.2.0') },
        { 'tools/a/package.json': null, 'tools/a/bun.lock': null, 'tools/b/package.json': MANIFEST({ minimist: '1.2.0' }), 'tools/b/bun.lock': LOCK('1.2.0') },
      )
      const claimed = await laneWith(
        { 'scripts/tool/package.json': MANIFEST({ minimist: '1.2.8' }), 'scripts/tool/bun.lock': LOCK('1.2.8') },
        { 'scripts/tool/package.json': MANIFEST({ minimist: '1.2.0' }), 'scripts/tool/bun.lock': LOCK('1.2.0') },
      )

      expect(advisoryFacts(renamed)).toEqual([])
      expect(advisoryUnjudged(renamed)).toEqual([])
      expect(advisoryFacts(claimed)).toEqual([['minimist:GHSA-XVCH-5GV4-984H', ['scripts/tool/bun.lock']]])
    })

    test('should find the lockfile governing each side apart, when a package leaves its workspace', async () => {
      const report = await laneWith(
        { 'package.json': JSON.stringify({ name: 'root', workspaces: ['packages/*'] }), 'bun.lock': LOCK('1.2.8'), 'packages/a/package.json': MANIFEST({ minimist: '1.2.8' }) },
        { 'packages/a/package.json': MANIFEST({ minimist: '1.2.0' }), 'packages/a/bun.lock': LOCK('1.2.0') },
      )

      expect(advisoryFacts(report)).toEqual([['minimist:GHSA-XVCH-5GV4-984H', ['packages/a/package.json', 'packages/a/bun.lock']]])
    })

    test('should ask the registry the base names, whatever .npmrc the head adds, and read that .npmrc as a gate input', async () => {
      const report = await laneWith(
        { 'package.json': MANIFEST({ minimist: '1.2.8' }), 'bun.lock': LOCK('1.2.8') },
        { 'package.json': MANIFEST({ minimist: '1.2.0' }), 'bun.lock': LOCK('1.2.0'), '.npmrc': 'registry=https://evil.example/\n' },
      )

      expect(advisoryFacts(report)).toEqual([['minimist:GHSA-XVCH-5GV4-984H', ['package.json', 'bun.lock']]])
      expect(factAt(report, 'gate-input')).toMatchObject({ files: ['.npmrc'] })
    })
  })

  test('should not read an unparsable package.json as unchanged scripts', async () => {
    const report = await laneAfter({ 'package.json': '{ not json' })

    expect(report.unjudged).toContainEqual(expect.objectContaining({ reader: 'manifest', lane: 'high' }))
    expect(report.floor).toBe('high')
  })

  test('should call a plan, its approvals and its revision records plan records', async () => {
    const report = await laneAfter({ 'docs/plans/comments/approvals.json': '{}', 'comments.revisions/1.json': '{}', 'comments.decisions.json': '{}' })

    expect(report.facts.map((fact) => [fact.code, fact.lane])).toEqual([['plan-record', 'high'], ['plan-record', 'high'], ['plan-record', 'high']])
  })

  test('should call a deleted test file a removed test', async () => {
    const report = await laneAfter({ 'tests/helpers.test.ts': null })

    expect(report.facts).toEqual([expect.objectContaining({ code: 'test-removed', lane: 'high', files: ['tests/helpers.test.ts'] })])
  })

  test('should call a deleted or edited test that carries an acceptance id an acceptance change', async () => {
    const deleted = await laneAfter({ 'tests/posts.test.ts': null })
    const edited = await laneAfter({ 'tests/posts.test.ts': "test('lists posts', () => {})\n" })

    expect(factAt(deleted, 'acceptance-changed')?.message).toContain('it carried AC-posts-1')
    expect(factAt(edited, 'acceptance-changed')).toMatchObject({ lane: 'high', message: 'tests/posts.test.ts: an acceptance test edited; no longer carries AC-posts-1' })
  })

  test('should call a test renamed out of the test glob an acceptance change', async () => {
    const { repo, base } = await createRepo()
    await git(repo, ['mv', 'tests/posts.test.ts', 'tests/posts.ts.bak'])
    const report = await laneOf(repo, base, await commit(repo, {}))

    expect(factAt(report, 'acceptance-changed')?.message).toContain('which no test run collects')
  })

  test('should call a deleted test of a name only the runner collects an acceptance change', async () => {
    const { repo, base } = await createRepo({ 'tests/posts_test.ts': "test('[AC-posts-2] shows a post', () => {})\n" })
    const report = await laneOf(repo, base, await commit(repo, { 'tests/posts_test.ts': null }))

    expect(report.facts).toEqual([expect.objectContaining({ code: 'acceptance-changed', lane: 'high' })])
  })

  test('should not call a test-named file low where the application loads it', async () => {
    const report = await laneAfter({ 'app/Providers/Extra.test.ts': 'export class ExtraProvider {}\n', 'resources/js/lib/clipboard.browser.ts': 'export {}\n' })

    expect(report.facts.map((fact) => [fact.code, fact.lane, fact.files[0]])).toEqual([
      ['file-added', 'medium', 'app/Providers/Extra.test.ts'],
      ['file-added', 'medium', 'resources/js/lib/clipboard.browser.ts'],
    ])
    expect(report.floor).toBe('medium')
  })

  test('should call an acceptance test renamed to a name another runner collects an acceptance change', async () => {
    const { repo, base } = await createRepo({ 'tests/browser/posts.browser.ts': "test('[AC-posts-1] lists posts', () => {})\n", 'tests/browser/smoke.browser.ts': "test('opens', () => {})\n" })
    await git(repo, ['mv', 'tests/browser/posts.browser.ts', 'tests/browser/posts.e2e.ts'])
    await git(repo, ['mv', 'tests/browser/smoke.browser.ts', 'tests/browser/smoke.e2e.ts'])
    const report = await laneOf(repo, base, await commit(repo, {}))

    expect(report.facts.map((fact) => [fact.code, fact.lane, fact.files])).toEqual([
      ['acceptance-changed', 'high', ['tests/browser/posts.e2e.ts']],
      ['test-removed', 'high', ['tests/browser/smoke.e2e.ts']],
    ])
  })

  test('should let an added test through as low unless it repeats an existing id', async () => {
    const fresh = await laneAfter({ 'tests/comments.test.ts': "test('[AC-comments-1] adds a comment', () => {})\n" })
    const repeated = await laneAfter({ 'tests/posts-again.test.ts': "test('[AC-posts-1] lists posts', () => {})\n" })

    expect(fresh.facts).toEqual([expect.objectContaining({ code: 'test-added', lane: 'low' })])
    expect(repeated.facts).toEqual([expect.objectContaining({ code: 'acceptance-added', lane: 'medium' })])
  })

  test('should treat a generated browser spec as ambient, deleted or not', async () => {
    const report = await laneAfter({ 'tests/browser/generated/smoke.browser.ts': null })

    expect(report.facts).toEqual([expect.objectContaining({ code: 'ambient', lane: 'low', target: 'generated files' })])
  })

  test('should tell a generated behaviour spec from the setup an author keeps', async () => {
    const { repo, base } = await createRepo({ 'tests/browser/behaviours/generated/comments.e2e.ts': '// generated\n', 'tests/browser/behaviours/auth.setup.e2e.ts': '// setup\n' })
    const report = await laneOf(repo, base, await commit(repo, { 'tests/browser/behaviours/generated/comments.e2e.ts': null, 'tests/browser/behaviours/auth.setup.e2e.ts': null }))

    expect(report.facts.map((fact) => [fact.code, fact.lane, fact.files])).toEqual([
      ['test-removed', 'high', ['tests/browser/behaviours/auth.setup.e2e.ts']],
      ['ambient', 'low', ['tests/browser/behaviours/generated/comments.e2e.ts']],
    ])
  })

  test('should call a dropped ability or a deleted policy a removed policy', async () => {
    const dropped = await laneAfter({ 'app/Policies/PostPolicy.ts': POLICY(['view']) })
    const deleted = await laneAfter({ 'app/Policies/PostPolicy.ts': null })

    expect(factAt(dropped, 'policy-removed')).toMatchObject({ lane: 'high', message: 'app/Policies/PostPolicy.ts: abilities removed: update' })
    expect(factAt(deleted, 'policy-removed')).toMatchObject({ lane: 'high' })
  })

  test('should read a policy in a subdirectory, and one named like a spec, as a policy', async () => {
    const { repo, base } = await createRepo({ 'app/Policies/Admin/PostPolicy.ts': POLICY(['view']), 'app/Policies/Post.spec.ts': POLICY(['view', 'update']) })
    const report = await laneOf(repo, base, await commit(repo, { 'app/Policies/Admin/PostPolicy.ts': null, 'app/Policies/Post.spec.ts': POLICY(['view']) }))

    expect(report.facts.map((fact) => [fact.code, fact.lane])).toEqual([['policy-removed', 'high'], ['policy-removed', 'high']])
  })

  test('should not judge a file that declares two policies by the first', async () => {
    const second = POLICY(['view', 'delete']).replace('class PostPolicy', 'class CommentPolicy').replace("import { Policy } from '@guren/core'\n", '')
    const { repo, base } = await createRepo({ 'app/Policies/PostPolicy.ts': `${POLICY(['view'])}${second}` })
    const report = await laneOf(repo, base, await commit(repo, { 'app/Policies/PostPolicy.ts': `${POLICY(['view'])}${second.replace(/  delete\(\) \{\n    return true\n  \}\n/, '')}` }))

    expect(report.unjudged).toContainEqual(expect.objectContaining({ reader: 'policy', lane: 'high' }))
    expect(report.floor).toBe('high')
  })

  test('should keep a policy edit that removes no ability at medium', async () => {
    const report = await laneAfter({ 'app/Policies/PostPolicy.ts': POLICY(['view', 'update', 'delete']), 'app/Policies/CommentPolicy.ts': POLICY(['view']) })

    expect(report.facts.map((fact) => [fact.code, fact.lane])).toEqual([['policy-added', 'medium'], ['policy-changed', 'medium']])
    expect(report.unjudged.map((entry) => entry.reader)).toEqual(['security-records', 'audit'])
  })

  test('should not read a policy that does not parse as one that kept its abilities', async () => {
    const report = await laneAfter({ 'app/Policies/PostPolicy.ts': 'export class PostPolicy {' })

    expect(report.unjudged).toContainEqual(expect.objectContaining({ reader: 'policy', lane: 'high' }))
  })

  test('should report what a schema edit declares, table by table', async () => {
    const report = await laneAfter({
      'db/schema.ts': `${PG_SCHEMA_FIXTURE.replace("pgTable('users', {", "pgTable('users', {\n  nickname: text('nickname'),")}
export const posts = pgTable('posts', { id: serial('id').primaryKey() })
`,
    })

    expect(report.facts.map((fact) => [fact.code, fact.target, fact.message])).toEqual([
      ['schema-changed', 'users', 'table users: columns added: nickname'],
      ['schema-changed', 'posts', 'table posts added (1 columns)'],
    ])
  })

  test('should not read a schema that does not parse as one with no tables', async () => {
    const report = await laneAfter({ 'db/schema.ts': 'export const users = pgTable(' })

    expect(report.unjudged).toContainEqual(expect.objectContaining({ reader: 'schema', lane: 'medium', files: ['db/schema.ts'] }))
    expect(codes(report)).toEqual(['source-edited'])
  })

  test('should read a schema edit that declares nothing new as an edit to source', async () => {
    const report = await laneAfter({ 'db/schema.ts': `// a note\n${PG_SCHEMA_FIXTURE}` })

    expect(report.facts).toEqual([expect.objectContaining({ code: 'source-edited', lane: 'medium', message: 'db/schema.ts: no table the reader sees changed' })])
  })

  test('should judge an added migration and call a destructive one high', async () => {
    const harmless = await laneAfter({ 'db/migrations/0002_posts/migration.sql': 'CREATE TABLE "posts" ("id" serial PRIMARY KEY);\n' })
    const destructive = await laneAfter({ 'db/migrations/0002_drop/migration.sql': 'DROP TABLE "users";\n' })

    expect(harmless.facts).toEqual([expect.objectContaining({ code: 'migration', lane: 'medium', target: 'db/migrations/0002_posts' })])
    expect(factAt(destructive, 'migration-destructive')).toMatchObject({ lane: 'high', target: 'db/migrations/0002_drop', evidence: 'static' })
  })

  test('should not judge a migration that is a link by the link target\'s path', async () => {
    const { repo, base } = await createRepo({ ...BASE_FILES, 'db/drop.sql': 'DROP TABLE "users";\n' })
    await mkdir(join(repo, 'db/migrations/0002_drop'), { recursive: true })
    await symlink('../../drop.sql', join(repo, 'db/migrations/0002_drop/migration.sql'))
    const report = await laneOf(repo, base, await commit(repo, {}))

    expect(report.unjudged).toContainEqual({ reader: 'symlink', reason: expect.any(String), lane: 'high', files: ['db/migrations/0002_drop/migration.sql'] })
    expect(report.floor).toBe('high')
  })

  test('should see a moved submodule pointer whatever diff.ignoreSubmodules says', async () => {
    const { repo, base } = await createRepo()
    await git(repo, ['config', 'diff.ignoreSubmodules', 'all'])
    await git(repo, ['update-index', '--add', '--cacheinfo', `160000,${base},vendor/lib`])
    await git(repo, ['commit', '-m', 'add a submodule pointer'])
    const report = await laneOf(repo, base, await git(repo, ['rev-parse', 'HEAD']))

    expect(report.facts).toEqual([expect.objectContaining({ code: 'non-source-added', lane: 'medium', files: ['vendor/lib'] })])
    expect(report.unjudged).toContainEqual(expect.objectContaining({ reader: 'submodule', lane: 'high', files: ['vendor/lib'] }))
  })

  test('should call an edit to an existing migration destructive', async () => {
    const report = await laneAfter({ 'db/migrations/0001_users/migration.sql': 'CREATE TABLE "users" ("id" bigserial PRIMARY KEY);\n' })

    expect(report.facts).toEqual([expect.objectContaining({ code: 'migration-destructive', lane: 'high', evidence: 'path' })])
  })

  test('should call a new audit suppression high', async () => {
    const report = await laneAfter({ 'app/Http/Controllers/PostController.ts': '// guren-audit-ignore\nexport class PostController {}\n' })

    expect(factAt(report, 'audit-suppressed')).toMatchObject({ lane: 'high' })
  })

  test('should see a suppression moved onto another line, and an edit to the audit configuration', async () => {
    const controller = (suppressed: string, plain: string): string => `export class PostController {\n  // guren-audit-ignore\n  ${suppressed}\n  ${plain}\n}\n`
    const { repo, base } = await createRepo({ 'app/Http/Controllers/PostController.ts': controller('a() {}', 'b() {}'), 'config/audit.ts': 'export default {}\n' })
    const moved = await laneOf(repo, base, await commit(repo, { 'app/Http/Controllers/PostController.ts': controller('b() {}', 'a() {}') }))
    const configured = await laneOf(repo, base, await commit(repo, { 'app/Http/Controllers/PostController.ts': controller('a() {}', 'b() {}'), 'config/audit.ts': "export default { ignore: [{ key: 'x', reason: 'y' }] }\n" }))

    expect(factAt(moved, 'audit-suppressed')?.message).toBe('app/Http/Controllers/PostController.ts: a guren-audit-ignore the base did not have, on `b() {}`')
    expect(configured.facts).toEqual([expect.objectContaining({ code: 'audit-suppressed', lane: 'high', files: ['config/audit.ts'] })])
  })

  test('should say what it did not judge for an edit to a controller', async () => {
    const report = await laneAfter({ 'app/Http/Controllers/PostController.ts': 'export class PostController {\n  index() {}\n}\n' })

    expect(report.facts).toEqual([expect.objectContaining({ code: 'source-edited', lane: 'medium' })])
    expect(report.unjudged.map((entry) => [entry.reader, entry.lane])).toEqual([['security-records', 'medium'], ['audit', 'medium']])
    expect(report.floor).toBe('medium')
  })

  test('should give every changed path at least one fact', async () => {
    const { repo, base } = await createRepo()
    await git(repo, ['mv', 'README.md', 'ABOUT.md'])
    const head = await commit(repo, {
      'docs/lessons/authorize-first.md': 'A lesson.\n',
      'lang/en/app.json': '{ "hello": "Hello" }\n',
      '.guren/routes.gen.ts': 'export {}\n',
      'app/Models/Post.ts': 'export class Post {}\n',
      'lint/rules.json': null,
      'bin/serve.ts': 'export {}\n',
    })
    const change = await resolveChange(repo, base, head)
    const report = await laneOf(repo, base, head)

    const judged = new Set(report.facts.flatMap((fact) => fact.files))
    expect(change.paths.filter((entry) => !judged.has(entry.path))).toEqual([])
    expect(factAt(report, 'lesson')?.lane).toBe('medium')
    expect(factAt(report, 'source-renamed')?.files).toEqual(['ABOUT.md'])
  })

  test('should list the plans at the head with the standing each has there', async () => {
    const { repo, base } = await createRepo()
    const approved = join(repo, 'docs/plans/comments/plan.json')
    await mkdir(dirname(approved), { recursive: true })
    await writeFile(approved, JSON.stringify(loadApprovedCommentsPlan()), 'utf8')
    const hash = await approvePlanFile(approved)
    const head = await commit(repo, { 'draft.plan.json': JSON.stringify(loadCommentsPlan()), 'docs/plans/broken/plan.json': '{' })

    const report = await laneOf(repo, base, head)

    expect(report.plans).toEqual([
      { file: 'docs/plans/broken/plan.json', hash: '', standing: 'unreadable' },
      { file: 'docs/plans/comments/plan.json', hash, standing: 'open' },
      expect.objectContaining({ file: 'draft.plan.json', standing: 'draft' }),
    ])
  })
})

describe('judgeChangeLane with an open plan', () => {
  const MODEL = `import { defineModel } from '@guren/core'
import { comments } from '@/db/schema'

export class Comment extends defineModel(comments) {}
`
  // The table `plan:scaffold` writes for the plan's comments model into a schema holding `posts`.
  const SCHEMA = `${PG_SCHEMA_FIXTURE.replace('import { pgTable,', 'import { index, integer, pgTable,')}
export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
})

export const comments = pgTable('comments', {
  id: serial('id').primaryKey(),
  body: text('body').notNull(),
  postId: integer('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('comments_post_id_index').on(table.postId),
])
`
  const POLICY_FILE = `import { Policy, type AuthUser } from '@guren/core'

export class CommentPolicy extends Policy {
  delete(_user: AuthUser | null): boolean {
    return false
  }
}
`

  const report0Hash = (report: ChangeLaneReport): string => report.plans.find((plan) => plan.file === 'docs/plans/comments/plan.json')!.hash

  /** A repository whose base holds the comments plan, approved unless `approve` is false. */
  async function planRepo(approve = true): Promise<{ repo: string; base: string }> {
    const { repo } = await createRepo()
    const path = join(repo, 'docs/plans/comments/plan.json')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(loadApprovedCommentsPlan()), 'utf8')
    if (approve) await approvePlanFile(path)
    return { repo, base: await commit(repo, {}) }
  }

  /** The comments plan approved in one commit on top of `files`, as a squash merge of the plan's pull request leaves it. */
  async function stampedPlanRepo(files: Record<string, string> = {}): Promise<{ repo: string; approved: string }> {
    const { repo } = await createRepo({ ...BASE_FILES, ...files })
    const path = join(repo, 'docs/plans/comments/plan.json')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(loadApprovedCommentsPlan()), 'utf8')
    await approvePlanFile(path)
    return { repo, approved: await commit(repo, {}) }
  }

  const noRoutes = { recordVersion: SECURITY_RECORD_VERSION, routes: [] }
  /** {@link laneOf} with both sides' security records given, as the audit's two exports would read them. */
  async function laneRecorded(repo: string, base: string, head: string, pair: SecurityRecordPair = { base: noRoutes, head: noRoutes }): Promise<ChangeLaneReport> {
    const change = await resolveChange(repo, base, head)
    const { reader, dispose } = openChange(repo, change)
    try {
      return await judgeChangeLane(change, reader, { audit: async () => ({ unavailable: 'not audited in this test', records: pair }) })
    } finally {
      await dispose()
    }
  }

  test("should read an edit to a file an earlier task of the plan added as that element's addition", async () => {
    const { repo } = await stampedPlanRepo()
    const base = await commit(repo, { 'app/Models/Comment.ts': MODEL })
    const report = await laneRecorded(repo, base, await commit(repo, { 'app/Models/Comment.ts': MODEL.replace('{}', '{\n  static fillable = [\'body\']\n}') }))

    expect(report.facts).toEqual([
      expect.objectContaining({ code: 'file-added', lane: 'low', files: ['app/Models/Comment.ts'], declaredBy: 'docs/plans/comments/plan.json#model.comment', planAddition: true, message: "app/Models/Comment.ts modified: absent when the plan's approval was recorded, so its addition" }),
    ])
    expect(renderChangeLane(report)).toContain("whose change added the file since was not checked")
  })

  test("should hold an edit read as the plan's addition to a raise guren.review.ts sets for source-edited", async () => {
    const { repo } = await stampedPlanRepo()
    const base = await commit(repo, { 'app/Models/Comment.ts': MODEL, 'guren.review.ts': "export default { facts: { 'source-edited': 'high' } }\n" })
    const report = await laneRecorded(repo, base, await commit(repo, { 'app/Models/Comment.ts': MODEL.replace('{}', '{\n  static fillable = [\'body\']\n}') }))

    expect(report.facts.map((fact) => [fact.code, fact.lane, fact.policyFrom, fact.planAddition])).toEqual([['file-added', 'high', 'low', true]])
  })

  test("should read an edit to a controller the plan added as its addition, and keep a validator's edit at medium", async () => {
    const controller = readFileSync(join(import.meta.dir, 'fixtures/change-routes/CommentController.ts.txt'), 'utf8')
    const validator = "import { z } from 'zod'\n\nexport const CommentPayloadSchema = z.object({ body: z.string().min(1) })\n"
    const { repo } = await stampedPlanRepo()
    const base = await commit(repo, { 'app/Http/Controllers/CommentController.ts': controller, 'app/Http/Validators/CommentValidator.ts': validator })
    const head = await commit(repo, {
      'app/Http/Controllers/CommentController.ts': controller.replace("throw HttpException.notImplemented('CommentController.destroy is planned and not written yet')", 'await comment.delete()\n    return this.redirect(`/posts/${comment.postId}`)'),
      // A route may parse with it by hand, which no record names.
      'app/Http/Validators/CommentValidator.ts': validator.replace('z.string().min(1)', 'z.any()'),
    })
    const report = await laneRecorded(repo, base, head)

    expect(report.facts.map((fact) => [fact.code, fact.lane, fact.files[0], fact.declaredBy])).toEqual([
      ['file-added', 'low', 'app/Http/Controllers/CommentController.ts', 'docs/plans/comments/plan.json#controller.comments,action.comments.store,action.comments.destroy'],
      ['source-edited', 'medium', 'app/Http/Validators/CommentValidator.ts', undefined],
    ])
  })

  test("should keep an edit at medium where the commit recording the plan's approval had the file, or the head is not what the plan declares", async () => {
    const edit = { 'app/Models/Comment.ts': MODEL.replace('{}', '{\n  static fillable = [\'body\']\n}') }
    const edited = (report: ChangeLaneReport) => report.facts.map((fact) => [fact.code, fact.lane, fact.declaredBy])

    const present = await stampedPlanRepo({ 'app/Models/Comment.ts': MODEL })
    expect(edited(await laneRecorded(present.repo, present.approved, await commit(present.repo, edit)))).toEqual([['source-edited', 'medium', undefined]])

    // Approved again after the file existed: the newest add of the approvals file is the cut-off.
    const again = await stampedPlanRepo()
    await commit(again.repo, { 'app/Models/Comment.ts': MODEL })
    const approvals = readFileSync(join(again.repo, 'docs/plans/comments/approvals.json'), 'utf8')
    await commit(again.repo, { 'docs/plans/comments/approvals.json': null })
    const reapproved = await commit(again.repo, { 'docs/plans/comments/approvals.json': approvals })
    expect(edited(await laneRecorded(again.repo, reapproved, await commit(again.repo, edit)))).toEqual([['source-edited', 'medium', undefined]])

    const stamped = await stampedPlanRepo()
    const added = await commit(stamped.repo, { 'app/Models/Comment.ts': MODEL })
    const renamed = await laneRecorded(stamped.repo, added, await commit(stamped.repo, { 'app/Models/Comment.ts': MODEL.replace('class Comment', 'class Note') }))
    expect(edited(renamed)).toEqual([['source-edited', 'medium', undefined]])

    // A validator or a model edit can weaken a route outside the security surface: every route's record must have been compared.
    const head = await commit(stamped.repo, edit)
    expect(edited(await laneOf(stamped.repo, added, head))).toEqual([['source-edited', 'medium', undefined]])
    const skipped = { ...noRoutes, skipped: ['the createApp({ boot }) callback'] }
    expect(edited(await laneRecorded(stamped.repo, added, head, { base: skipped, head: skipped }))).toEqual([['source-edited', 'medium', undefined]])
    const inline: RouteSecurityRecord = { method: 'POST', path: '/comments', module: null, middleware: [], contracts: {}, handler: { unread: 'an inline handler' } }
    const unread = { ...noRoutes, routes: [inline] }
    expect(edited(await laneRecorded(stamped.repo, added, head, { base: unread, head: unread }))).toEqual([['source-edited', 'medium', undefined]])

    // Merged with a merge commit after the mainline gained the file: the merge brought the approvals to a tree that had it.
    const merged = await stampedPlanRepo()
    const mainline = await git(merged.repo, ['rev-parse', 'HEAD~1'])
    await git(merged.repo, ['branch', '-q', 'plan'])
    await git(merged.repo, ['reset', '-q', '--hard', mainline])
    await commit(merged.repo, { 'app/Models/Comment.ts': MODEL })
    await git(merged.repo, ['merge', '-q', '--no-ff', '-m', 'merge plan', 'plan'])
    const mergeCommit = await git(merged.repo, ['rev-parse', 'HEAD'])
    expect(edited(await laneRecorded(merged.repo, mergeCommit, await commit(merged.repo, edit)))).toEqual([['source-edited', 'medium', undefined]])
  })

  test('should lower an added file and an added table the plan declares, naming the element', async () => {
    const { repo, base } = await planRepo()
    const report = await laneOf(repo, base, await commit(repo, { 'app/Models/Comment.ts': MODEL, 'db/schema.ts': SCHEMA }))

    expect(report.facts.filter((fact) => fact.declaredBy)).toEqual([
      expect.objectContaining({ code: 'schema-changed', lane: 'low', target: 'comments', declaredBy: 'docs/plans/comments/plan.json#model.comment' }),
      expect.objectContaining({ code: 'file-added', lane: 'low', files: ['app/Models/Comment.ts'], declaredBy: 'docs/plans/comments/plan.json#model.comment' }),
    ])
    expect(renderChangeLane(report)).toContain('app/Models/Comment.ts added (declared by docs/plans/comments/plan.json#model.comment)')
    // The index callback inside the declared table is the scaffold's own.
    expect(report.facts.filter((fact) => fact.code === 'source-edited')).toEqual([])
  })

  test("should keep a table dropped from the schema's aggregate object, beside a declared table", async () => {
    const { repo } = await planRepo()
    const tables = SCHEMA.slice(0, SCHEMA.indexOf('\nexport const comments'))
    const base = await commit(repo, { 'db/schema.ts': `${tables}\nexport const schema = { users, posts }\n` })
    const listed = await laneOf(repo, base, await commit(repo, { 'db/schema.ts': `${SCHEMA}\nexport const schema = { users, posts, comments }\n` }))
    expect(listed.facts.map((fact) => [fact.code, fact.lane])).toEqual([['schema-changed', 'low']])

    const dropped = await laneOf(repo, base, await commit(repo, { 'db/schema.ts': `${SCHEMA}\nexport const schema = { users, comments }\n` }))
    expect(dropped.facts.map((fact) => [fact.code, fact.lane])).toEqual([['schema-changed', 'low'], ['source-edited', 'medium']])
  })

  test('should lower the migration drizzle-kit writes for the tables the plan adds', async () => {
    const { repo } = await planRepo()
    const folder = join(import.meta.dir, 'fixtures/change-migrations')
    const [first, second] = readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    const files = (name: string) => Object.fromEntries(['migration.sql', 'snapshot.json'].map((file) => [`drizzle/${name}/${file}`, readFileSync(join(folder, name, file), 'utf8')]))
    const base = await commit(repo, files(first!))
    const report = await laneOf(repo, base, await commit(repo, { 'db/schema.ts': SCHEMA, ...files(second!) }))

    expect(factAt(report, 'migration')).toMatchObject({ lane: 'low', target: `drizzle/${second}`, declaredBy: 'docs/plans/comments/plan.json#model.comment' })
    expect(factAt(report, 'migration')?.files.sort()).toEqual([`drizzle/${second}/migration.sql`, `drizzle/${second}/snapshot.json`])
  })

  test('should lower an added policy with exactly the planned abilities', async () => {
    const { repo, base } = await planRepo()
    const report = await laneOf(repo, base, await commit(repo, { 'app/Policies/CommentPolicy.ts': POLICY_FILE }))

    expect(factAt(report, 'policy-added')).toMatchObject({ lane: 'low', declaredBy: 'docs/plans/comments/plan.json#policy.comment' })
  })

  test('should declare nothing from a plan that is closed', async () => {
    const { repo, base } = await planRepo()
    const hash = report0Hash(await laneOf(repo, base, base))
    const closed = await commit(repo, { 'docs/plans/comments.md': `---\ntype: plan\nclosed: true\nplan_hash: ${hash}\n---\n` })
    const report = await laneOf(repo, closed, await commit(repo, { 'app/Models/Comment.ts': MODEL }))

    expect(report.plans).toEqual([expect.objectContaining({ file: 'docs/plans/comments/plan.json', standing: 'closed' })])
    expect(factAt(report, 'file-added')).toMatchObject({ lane: 'medium' })
    expect(factAt(report, 'file-added')?.declaredBy).toBeUndefined()
  })

  test('should let guren.review.ts raise a declared fact, which keeps its declaration', async () => {
    const { repo } = await planRepo()
    const base = await commit(repo, { 'guren.review.ts': "export default { facts: { 'file-added': 'medium' } }\n" })
    const report = await laneOf(repo, base, await commit(repo, { 'app/Models/Comment.ts': MODEL }))

    expect(factAt(report, 'file-added')).toMatchObject({ lane: 'medium', policyFrom: 'low', declaredBy: 'docs/plans/comments/plan.json#model.comment' })
  })

  test('should keep a file a plan names at another path, or exporting another name, at medium', async () => {
    const { repo, base } = await planRepo()
    const report = await laneOf(repo, base, await commit(repo, { 'app/Models/Note.ts': MODEL, 'app/Models/Comment.ts': MODEL.replace('class Comment', 'class Note') }))

    expect(report.facts.filter((fact) => fact.code === 'file-added').map((fact) => [fact.files[0], fact.lane, fact.declaredBy])).toEqual([
      ['app/Models/Comment.ts', 'medium', undefined],
      ['app/Models/Note.ts', 'medium', undefined],
    ])
  })

  test('should lower the provider a planned policy implies and the entry edit registering it, as plan:scaffold writes them', async () => {
    // Taken from a real run: the comments plan approved, then plan:scaffold on its scaffold step.
    const fixture = (name: string): string => readFileSync(join(import.meta.dir, 'fixtures/change-providers', `${name}.ts.txt`), 'utf8')
    const { repo } = await planRepo()
    const base = await commit(repo, { 'src/app.ts': fixture('app.base') })
    const written = { 'app/Providers/CommentPolicyProvider.ts': fixture('CommentPolicyProvider'), 'app/Policies/CommentPolicy.ts': fixture('CommentPolicy') }
    const entryFacts = (report: ChangeLaneReport) => report.facts.filter((fact) => fact.files.includes('src/app.ts')).map((fact) => [fact.code, fact.lane, fact.target, fact.declaredBy])
    const head = await commit(repo, { ...written, 'src/app.ts': fixture('app.head') })

    const report = await laneOf(repo, base, head)
    expect(entryFacts(report)).toEqual([['provider-added', 'low', 'CommentPolicyProvider', 'docs/plans/comments/plan.json#policy.comment']])
    expect(factAt(report, 'file-added')).toMatchObject({ lane: 'low', files: ['app/Providers/CommentPolicyProvider.ts'] })

    // The provider runs at boot, so one the scaffold did not write keeps its registration with a person.
    const edited = await laneOf(repo, base, await commit(repo, { 'app/Providers/CommentPolicyProvider.ts': `${fixture('CommentPolicyProvider')}\nconsole.log('booted')\n` }))
    expect(entryFacts(edited)).toEqual([['provider-added', 'medium', 'CommentPolicyProvider', undefined]])

    const used = await laneOf(repo, base, await commit(repo, { ...written, 'src/app.ts': fixture('app.head').replace('export default app', "app.use('*', async (_c, next) => next())\n\nexport default app") }))
    expect(entryFacts(used)).toEqual([['source-edited', 'medium', undefined, undefined]])
  })

  test('should read a key added to defineEnv() as env-added, lowered where the plan states it', async () => {
    const { repo } = await createRepo()
    const path = join(repo, 'docs/plans/comments/plan.json')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ ...loadApprovedCommentsPlan(), planVersion: 2, env: [{ id: 'env.queue', change: { kind: 'add' }, key: 'QUEUE_CONNECTION', default: 'sync' }] }), 'utf8')
    await approvePlanFile(path)
    const ENV = "import { defineEnv, Env } from '@guren/core'\n\nconst env = defineEnv({\n  APP_NAME: Env.string().default('Guren'),\n})\n\nexport default env\n"
    const base = await commit(repo, { 'config/env.ts': ENV })
    const envFacts = (report: ChangeLaneReport) => report.facts.filter((fact) => fact.files.includes('config/env.ts')).map((fact) => [fact.code, fact.lane, fact.target, fact.declaredBy])
    const withKey = (chain: string): string => ENV.replace("  APP_NAME: Env.string().default('Guren'),\n", `  APP_NAME: Env.string().default('Guren'),\n  QUEUE_CONNECTION: ${chain},\n`)

    expect(envFacts(await laneOf(repo, base, await commit(repo, { 'config/env.ts': withKey("Env.string().default('sync')") }))))
      .toEqual([['env-added', 'low', 'QUEUE_CONNECTION', 'docs/plans/comments/plan.json#env.queue']])
    expect(envFacts(await laneOf(repo, base, await commit(repo, { 'config/env.ts': withKey("Env.string().default('redis')") }))))
      .toEqual([['env-added', 'medium', 'QUEUE_CONNECTION', undefined]])
    // An argument the comparison would leave out is code the import runs.
    expect(envFacts(await laneOf(repo, base, await commit(repo, { 'config/env.ts': withKey("Env.string().default('sync').describe(process.env.GUREN_TESTING = '1')") }))))
      .toEqual([['env-added', 'medium', 'QUEUE_CONNECTION', undefined]])
    expect(envFacts(await laneOf(repo, base, await commit(repo, { 'config/env.ts': `// @ts-nocheck\n${withKey("Env.string().default('sync')")}` }))))
      .toEqual([['source-edited', 'medium', undefined, undefined]])
    expect(envFacts(await laneOf(repo, base, await commit(repo, { 'config/env.ts': withKey("Env.string().default('sync')").replace("APP_NAME: Env.string().default('Guren')", "APP_NAME: Env.string()") }))))
      .toEqual([['source-edited', 'medium', undefined, undefined]])
  })

  test('should lower a file a command of the plan writes, while it is what the generator writes', async () => {
    const { repo } = await createRepo()
    const path = join(repo, 'docs/plans/comments/plan.json')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ ...loadApprovedCommentsPlan(), commands: [{ id: 'command.provider', command: 'guren make:provider Queue', reason: 'binds the queue' }] }), 'utf8')
    await approvePlanFile(path)
    const base = await commit(repo, {})
    const provider = providerFile('Queue')
    const providerFact = (report: ChangeLaneReport) => report.facts.filter((fact) => fact.files.includes(provider.path)).map((fact) => [fact.code, fact.lane, fact.declaredBy])

    expect(providerFact(await laneOf(repo, base, await commit(repo, { [provider.path]: provider.contents }))))
      .toEqual([['file-added', 'low', 'docs/plans/comments/plan.json#command.provider']])
    expect(providerFact(await laneOf(repo, base, await commit(repo, { [provider.path]: provider.contents.replace('boot(): void {\n', "boot(): void {\n    console.log('booted')\n") }))))
      .toEqual([['file-added', 'medium', undefined]])
  })

  test('should declare nothing from a plan nobody approved', async () => {
    const { repo, base } = await planRepo(false)
    const report = await laneOf(repo, base, await commit(repo, { 'app/Models/Comment.ts': MODEL, 'db/schema.ts': SCHEMA }))

    expect(report.plans).toEqual([expect.objectContaining({ file: 'docs/plans/comments/plan.json', standing: 'unapproved' })])
    expect(report.facts.filter((fact) => fact.declaredBy)).toEqual([])
    expect(factAt(report, 'file-added')?.lane).toBe('medium')
    expect(report.facts.filter((fact) => fact.code === 'source-edited')).toEqual([expect.objectContaining({ lane: 'medium', target: 'comments', files: ['db/schema.ts'] })])
  })

  test('should lower the routes a mount adds and drop its entry edit, once the records show each as planned', async () => {
    const fixture = join(import.meta.dir, 'fixtures/change-routes')
    const records = JSON.parse(readFileSync(join(fixture, 'records.json'), 'utf8')) as Record<'scaffold' | 'mount', { recordVersion: number; routes: RouteSecurityRecord[] }>
    const { repo } = await planRepo()
    const base = await commit(repo, {
      'routes/web.ts': readFileSync(join(fixture, 'web.base.ts.txt'), 'utf8'),
      'routes/comments.ts': readFileSync(join(fixture, 'comments.ts.txt'), 'utf8'),
      'app/Http/Controllers/CommentController.ts': readFileSync(join(fixture, 'CommentController.ts.txt'), 'utf8'),
      'app/Models/Post.ts': "import { defineModel } from '@guren/core'\nimport { posts } from '@/db/schema'\n\nexport class Post extends defineModel(posts) {}\n",
    })
    const head = await commit(repo, { 'routes/web.ts': readFileSync(join(fixture, 'web.head.ts.txt'), 'utf8') })
    const judge = async (pair: SecurityRecordPair): Promise<ChangeLaneReport> => {
      const change = await resolveChange(repo, base, head)
      const { reader, dispose } = openChange(repo, change)
      try {
        return await judgeChangeLane(change, reader, { audit: async () => ({ unavailable: 'not audited in this test', records: pair }) })
      } finally {
        await dispose()
      }
    }

    const mounted = await judge({ base: records.scaffold, head: records.mount })
    expect(mounted.facts.map((fact) => [fact.code, fact.lane, fact.target, fact.files, fact.declaredBy])).toEqual([
      ['route-added', 'low', 'POST /posts/:postId/comments (comments.store)', ['routes/web.ts'], 'docs/plans/comments/plan.json#route.comments.store'],
      ['route-added', 'low', 'DELETE /comments/:id (comments.destroy)', ['routes/web.ts'], 'docs/plans/comments/plan.json#route.comments.destroy'],
    ])
    expect(renderChangeLane(mounted)).toContain('A declared route was read off its security record')

    // A planned `auth` the registered route lacks keeps the route and the entry edit with a person.
    const [store, destroy, ...rest] = records.mount.routes
    const open = await judge({ base: records.scaffold, head: { ...records.mount, routes: [store!, { ...destroy!, middleware: [] }, ...rest] } })
    expect(open.facts.map((fact) => [fact.code, fact.lane])).toEqual([['source-edited', 'medium'], ['route-added', 'low'], ['route-added', 'medium']])
  })

  test('should declare nothing in a change that writes a plan record', async () => {
    const { repo, base } = await planRepo()
    const report = await laneOf(repo, base, await commit(repo, { 'app/Models/Comment.ts': MODEL, 'docs/plans/comments/decisions.json': '{"waivers":[]}' }))

    expect(factAt(report, 'plan-record')?.lane).toBe('high')
    expect(report.facts.filter((fact) => fact.declaredBy)).toEqual([])
  })
})

describe('judgeChangeLane with per-route security records', () => {
  const route = (middleware: RouteSecurityRecord['middleware']): RouteSecurityRecord => ({
    method: 'PUT', path: '/posts/:id', module: null, action: 'PostController.update', middleware, contracts: {},
    handler: { authenticates: false, authorizes: [], validates: [] },
  })
  const auth = { kind: 'alias' as const, name: 'auth', capabilities: { authentication: { mode: 'required' as const } } }
  const throttle = { kind: 'inline' as const, name: null, capabilities: {} }
  const records = (...routes: RouteSecurityRecord[]) => ({ recordVersion: SECURITY_RECORD_VERSION, routes })

  async function laneWith(files: Record<string, string | null>, pair: SecurityRecordPair, options: Pick<JudgeChangeLaneOptions, 'baseRecord' | 'headRecords'> = {}): Promise<ChangeLaneReport> {
    const { repo, base } = await createRepo()
    const head = await commit(repo, files)
    const change = await resolveChange(repo, base, head)
    const { reader, dispose } = openChange(repo, change)
    const audits: ChangeAudits = { unavailable: 'not audited in this test', records: pair }
    try {
      return await judgeChangeLane(change, reader, { audit: async () => audits, ...options })
    } finally {
      await dispose()
    }
  }
  const controller = { 'app/Http/Controllers/PostController.ts': 'export class PostController {\n  update() {}\n}\n' }
  const security = (report: ChangeLaneReport) => report.unjudged.filter((entry) => entry.reader === 'security-records').map((entry) => entry.lane)

  test('should turn a guard gone into authorization-removed, carrying the files the change touched', async () => {
    const report = await laneWith(controller, { base: records(route([auth])), head: records(route([])) })

    expect(report.facts).toContainEqual(expect.objectContaining({ code: 'authorization-removed', lane: 'high', files: ['app/Http/Controllers/PostController.ts'] }))
    expect(report.records).toEqual({ compared: true })
    expect(security(report)).toEqual([])
  })

  test('should give each added, removed or changed route and each agent tool a medium fact of its own', async () => {
    const health: RouteSecurityRecord = { ...route([]), method: 'GET', path: '/health', name: 'health', action: 'HealthController.show' }
    const routeFacts = (report: ChangeLaneReport) => report.facts.filter((fact) => fact.code.startsWith('route-') || fact.code === 'agent-tool').map((fact) => [fact.code, fact.lane, fact.target])

    expect(routeFacts(await laneWith(controller, { base: records(route([auth])), head: records(route([auth]), health) }))).toEqual([['route-added', 'medium', 'GET /health (health)']])
    expect(routeFacts(await laneWith(controller, { base: records(route([auth]), health), head: records(route([auth])) }))).toEqual([['route-removed', 'medium', 'GET /health (health)']])
    const tool = { ...route([auth]), agent: { toolName: 'posts_update' } }
    expect(routeFacts(await laneWith(controller, { base: records(route([auth])), head: records(tool) }))).toEqual([['route-changed', 'medium', 'PUT /posts/:id'], ['agent-tool', 'medium', 'PUT /posts/:id']])
    expect(routeFacts(await laneWith(controller, { base: records(route([auth])), head: records(route([auth]), { ...health, agent: { toolName: 'health' } }) }))).toEqual([['route-added', 'medium', 'GET /health (health)'], ['agent-tool', 'medium', 'GET /health (health)']])
    expect(routeFacts(await laneWith(controller, { base: records(route([auth])), head: records(route([auth])) }))).toEqual([])
  })

  test('should hold a record it cannot order at high, and say nothing of an unchanged one', async () => {
    expect(security(await laneWith(controller, { base: records(route([auth, throttle])), head: records(route([throttle, auth])) }))).toEqual(['high'])
    const same = await laneWith(controller, { base: records(route([auth])), head: records(route([auth])) })
    expect(security(same)).toEqual([])
    expect(same.facts.map((fact) => fact.code)).not.toContain('authorization-removed')
  })

  test('should compare a change that touches no route file, controller or policy', async () => {
    const report = await laneWith({ 'config/app.ts': 'export default {}\n' }, { base: records(route([auth])), head: records(route([])) })

    expect(report.facts).toContainEqual(expect.objectContaining({ code: 'authorization-removed', files: ['config/app.ts'] }))
  })

  test('should hold a registrar only the head skipped at high, and one both sides skipped at medium', async () => {
    const skipped = (...names: string[]) => ({ ...records(route([auth])), skipped: names })
    expect(security(await laneWith({ 'src/app.ts': 'export default {}\n' }, { base: records(route([auth])), head: skipped('the createApp({ boot }) callback') }))).toEqual(['high'])
    expect(security(await laneWith(controller, { base: skipped('the createApp({ boot }) callback'), head: skipped('the createApp({ boot }) callback') }))).toEqual(['medium'])
  })

  test('should keep a base it cannot read at medium, and a head the change made unreadable at high', async () => {
    expect(security(await laneWith(controller, { unavailable: "the base's records were not read: x", side: 'base' }))).toEqual(['medium'])
    expect(security(await laneWith(controller, { unavailable: 'the base was not audited: bun.lock differs' }))).toEqual(['medium'])
    expect(security(await laneWith(controller, { unavailable: "the head's records were not read: a provider threw", side: 'head' }))).toEqual(['high'])
    expect(security(await laneWith({ 'config/app.ts': 'export default {}\n' }, { unavailable: 'x', side: 'base' }))).toEqual([])
  })

  describe('with a stored base record', () => {
    const stored = (...routes: RouteSecurityRecord[]) => ({ records: records(...routes), head: 'a'.repeat(40), cli: '2.37.3', server: '2.37.0' })
    const notInstalled = { unavailable: 'the base was not audited: bun.lock is not the lockfile installed here' }

    test('should compare the stored base against the head the audit read', async () => {
      const report = await laneWith(controller, { ...notInstalled, side: 'base', head: records(route([])) }, { baseRecord: stored(route([auth])) })

      expect(report.facts).toContainEqual(expect.objectContaining({ code: 'authorization-removed', lane: 'high' }))
      expect(report.records).toEqual({ compared: true, stored: { head: 'a'.repeat(40), cli: '2.37.3', server: '2.37.0' } })
      expect(security(report)).toEqual([])
    })

    test('should read the head alone when the audit exported neither side', async () => {
      let asked = 0
      const headRecords = async () => {
        asked += 1
        return records(route([]))
      }
      const report = await laneWith(controller, notInstalled, { baseRecord: stored(route([auth])), headRecords })

      expect(asked).toBe(1)
      expect(report.facts.map((fact) => fact.code)).toContain('authorization-removed')
    })

    test('should keep an unusable record at medium, naming why and what would fix it', async () => {
      const report = await laneWith(controller, notInstalled, { baseRecord: { unusable: 'the base record is format 1, and this run writes 2', fix: 'run the Change workflow on aaaaaaaaaaaa again' } })
      const entry = report.unjudged.find((item) => item.reader === 'security-records')

      expect(entry?.lane).toBe('medium')
      expect(entry?.reason).toContain('the base record is format 1, and this run writes 2 (run the Change workflow on aaaaaaaaaaaa again)')
      expect(report.records).toEqual({ compared: false })
    })

    test('should hold a head that exported and did not read at high, and one never exported at medium', async () => {
      const baseRecord = stored(route([auth]))
      expect(security(await laneWith(controller, notInstalled, { baseRecord, headRecords: async () => ({ unavailable: "the head's records were not read: a provider threw", exported: true }) }))).toEqual(['high'])
      expect(security(await laneWith(controller, notInstalled, { baseRecord, headRecords: async () => ({ unavailable: 'the head was not exported: a symlink', exported: false }) }))).toEqual(['medium'])
    })

    test('should leave a head the change made unreadable at high whatever the stored base holds', async () => {
      expect(security(await laneWith(controller, { unavailable: "the head's records were not read: a provider threw", side: 'head' }, { baseRecord: stored(route([auth])) }))).toEqual(['high'])
    })
  })
})

describe('change:lane', () => {
  test('should refuse to run without both commits', async () => {
    await expect(runCommand(builtinSubCommands['change:lane'], { rawArgs: ['--head', 'abc1234'] })).rejects.toThrow('needs both --base <sha> and --head <sha>')
  })

  test('should say when the head is behind the base', async () => {
    const { repo, base } = await createRepo()
    const ahead = await commit(repo, { 'README.md': '# ahead\n' })

    expect(renderChangeLane(await laneOf(repo, ahead, base))).toContain('were --base and --head swapped?')
  })

  test('should render the floor, the facts by lane and what was not judged', async () => {
    const report = await laneAfter({ 'app/Http/Controllers/PostController.ts': 'export class PostController {\n  index() {}\n}\n', 'tests/helpers.test.ts': null })

    const text = renderChangeLane(report)

    expect(text).toContain(`Change ${report.mergeBase.slice(0, 12)}..${report.head.slice(0, 12)}: floor high`)
    expect(text.indexOf('\nhigh\n')).toBeLessThan(text.indexOf('\nmedium\n'))
    expect(text).toContain('  test-removed: tests/helpers.test.ts deleted')
    expect(text).toContain('  security-records (medium): ')
  })
})
